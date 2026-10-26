import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import * as piAgent from "@earendil-works/pi-coding-agent";
import { BorderedLoader, createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AssumeError, fetchCredentials, findGranted, resolveRegionDetails, safeMessage } from "../../src/credentials.js";
import { createGuards } from "../../src/guards.js";
import { hasGlobPatterns, loadPolicy } from "../../src/policy.js";
import { discoverProfileNames, discoverProfileRegionDetails } from "../../src/profiles.js";
import { RoleSession } from "../../src/session.js";
import { formatLocalExpiration } from "../../src/status.js";
import { checkPiVersion, isUsableVersion } from "../../src/version.js";

const AWS_BASH = "aws_bash";
// Reasons are plain sentences shared by user notices and model-facing output.
const NO_POLICY = [
  "This project has no effective AWS Assume rules. You cannot select extension-managed profiles. You cannot use aws_bash.",
  "Ordinary AWS commands may still use plain bash with the ambient AWS environment. These commands do not require an AWS Assume policy.",
  "If you need extension-managed profiles, configure .pi/aws-assume.json outside Pi. Then run /reload.",
].join("\n\n");
const STALE_HELPERS = "AWS Assume's JavaScript helpers are from an older version. Fully exit and restart Pi to finish loading the extension update; /reload cannot refresh these cached helpers. No role access was enabled.";
// Share execution rules across model context, tool descriptions, and prompt guidelines.
const EXECUTION_GUIDANCE = [
  "If the user requests ambient credentials or existing environment credentials, use plain bash.",
  "Otherwise, use aws_bash for AWS requests when a /assume profile is active, unless the user requests another profile.",
  "The active profile is already selected and approved for this session.",
  "Do not ask for approval to use the active profile.",
  "Do not call assume_profile action=assume again for the active profile.",
  "If the active profile is unclear, use assume_profile action=status.",
  "Without an active profile, use plain bash unless the user or task requires an allowed /assume profile.",
  "An ordinary AWS request does not by itself require an assumed profile.",
  "To select a required profile or switch profiles, use assume_profile action=assume.",
  "Plain bash keeps the ambient AWS environment. It does not receive the active profile's credentials.",
  "Ambient AWS commands require neither an AWS Assume policy nor an active /assume profile.",
];
// Model-facing only; never shown in user notices.
const SAFETY_GUIDANCE = [
  ...EXECUTION_GUIDANCE,
  "Missing AWS Assume setup disables only extension-managed profile access. It does not prohibit ordinary AWS commands through plain bash. Do not require AWS Assume setup solely to use credentials already available in the environment.",
  "Do not substitute identities for a required assumed profile. If you cannot select or authenticate that profile, apply these rules:\n- Stop the task.\n- Report the blocker.\n- Do not silently substitute ambient credentials.\n- Do not search credential stores.\n- Do not invoke AWS/Granted directly to obtain substitute credentials.",
  "Using ambient credentials is not a bypass when no assumed profile is required.",
  "assume_profile is a Pi extension tool. It is not a shell command, function, or alias. Do not probe for assume_profile with bash/type/which. Do not search shell startup files for assume_profile.",
  "If the tool declaration is unavailable, apply these steps:\n- Report a tool-loading problem.\n- Ask the user to check extension loading.\n- Ask the user to run /reload.",
  "Do not modify the project's AWS Assume policy. Do not modify the global AWS Assume policy. Do not modify AWS profile files.",
  "The user manages this setup outside Pi. The user then runs /reload.",
  "For ambient credentials, let the AWS CLI or SDK use its normal credential resolution. Do not print credentials. Do not search credential stores.",
  "This guidance is not a sandbox.",
].join("\n\n");
// Namespace access: an older Pi without this export must not fail at import time.
const piVersion = (piAgent as { VERSION?: unknown }).VERSION;

function profilePage(current: RoleSession, offset = 0) {
  const profiles = current.status().profiles;
  const page = profiles.slice(offset, offset + 100);
  return { profiles: page, totalProfiles: profiles.length,
    nextOffset: offset + page.length < profiles.length ? offset + page.length : null };
}

function statusSummary(current: RoleSession) {
  const status = current.status();
  return { ...status, profiles: status.profiles.slice(0, 100), totalProfiles: status.profiles.length,
    approvedProfiles: status.approvedProfiles.slice(0, 100), totalApprovedProfiles: status.approvedProfiles.length };
}

export default function assumeExtension(pi: ExtensionAPI) {
  let session: RoleSession | undefined;
  let guards: ReturnType<typeof createGuards> | undefined;
  // Always-on, independent of role access: built-in write/edit tools cannot change policy files.
  let policyGuard: ReturnType<typeof createGuards> | undefined;
  let reason = "The session has not started.";
  let announced: string | undefined;
  let hasAssumed = false;

  const updateStatus = (ctx: ExtensionContext) => {
    // A widget provides a width-aware row without taking ownership of Pi's footer.
    ctx.ui.setStatus("assume", undefined);
    if (session?.status().activeProfile) hasAssumed = true;
    ctx.ui.setWidget("assume", session && hasAssumed ? (_tui, theme) => ({
      invalidate() {},
      render(width: number) {
        if (width <= 0) return [""];
        const status = session?.status();
        const profile = `AWS: ${status?.activeProfile ?? "none"}`;
        const expiry = status?.expiresAt ? `Expires ${formatLocalExpiration(status.expiresAt)}` : "";
        const rightWidth = visibleWidth(expiry);
        const left = truncateToWidth(profile, Math.max(0, width - (expiry ? rightWidth + 1 : 0)));
        const padding = " ".repeat(Math.max(0, width - visibleWidth(left) - rightWidth));
        return [theme.fg("dim", truncateToWidth(left + padding + expiry, width))];
      },
    }) : undefined);
  };
  const unavailable = () => `assume: extension-managed profile access is unavailable. ${reason}`;
  // Tool errors carry model guidance; command errors stay short for the user.
  const requireSession = (ctx: ExtensionContext, audience: "model" | "user") => {
    if (ctx.mode !== "tui" || !ctx.isProjectTrusted() || !session) {
      throw new AssumeError(audience === "model" ? `Extension-managed profile access is unavailable. ${reason} ${SAFETY_GUIDANCE}`
        : unavailable());
    }
    return session;
  };
  const result = (metadata: object) => ({
    content: [{ type: "text" as const, text: JSON.stringify(metadata, null, 2) }], details: undefined,
  });

  function roleTool() {
    return {
      name: "assume_profile", label: "AWS profile", exposure: "model-only" as const,
      description: [
        "Manage this project's allowed AWS profiles for aws_bash.",
        ...EXECUTION_GUIDANCE,
        "Actions: list allowed profile names, report status, assume a concrete profile, cancel pending authentication, or clear the active profile.",
        "Lists contain at most 100 names. Use nextOffset for the next page.",
        "Approval applies once per concrete profile per session, unless a matching rule enables autoApprove.",
        "Approval never applies to an entire wildcard rule. Credential-fetch output is not exposed.",
        "This is a Pi tool, not a shell command or alias.",
        "Status diagnostics remain available when extension-managed profile access is disabled. Status reports the setup blocker.",
        "If a required assumed profile is unavailable, stop. Report the blocker. Do not search for credentials or bypass this tool.",
      ].join(" "),
      parameters: Type.Object({
        action: StringEnum(["list", "status", "assume", "cancel", "clear"] as const),
        profile: Type.Optional(Type.String({ description: "Concrete profile name matching the project allowlist; required for assume. Never pass a wildcard here." })),
        offset: Type.Optional(Type.Integer({ minimum: 0, maximum: 1000000, description: "List pagination offset; defaults to 0." })),
      }),
      executionMode: "sequential" as const,
      async execute(_id: string, params: { action: string; profile?: string; offset?: number }, signal: AbortSignal | undefined,
        _onUpdate: unknown, ctx: ExtensionContext) {
        if (params.action === "status" && !session) {
          return result({ available: false, reason, guidance: SAFETY_GUIDANCE });
        }
        const current = requireSession(ctx, "model");
        try {
          if (params.action === "assume") {
            if (!params.profile) throw new AssumeError("Specify a profile to assume.");
            await current.assume(params.profile, {
              signal,
              confirm: (profile: string, approvalSignal: AbortSignal) => ctx.ui.confirm("Allow AWS profile for this session?",
                `Allow the assistant to use ${profile}? Switching back will not prompt again until the session resets.`, { signal: approvalSignal }),
              onAutoApprove: (profile: string) => ctx.ui.notify(
                `assume: ${profile} was approved for the assistant by an autoApprove policy rule; no confirmation was shown.`, "warning"),
            });
          } else if (params.action === "cancel") current.cancel();
          else if (params.action === "clear") current.clear();
          if (session !== current) throw new AssumeError("Session changed; no role was restored.");
          updateStatus(ctx);
          return result(params.action === "list" ? profilePage(current, params.offset) : statusSummary(current));
        } catch (error) { throw new AssumeError(safeMessage(error)); }
      },
    };
  }

  // Withdrawn placeholder; tools cannot be unregistered, only re-registered as hidden.
  function hiddenAwsBash() {
    return {
      name: AWS_BASH, label: "AWS bash", exposure: "hidden" as const,
      description: "Inactive AWS profile shell.",
      parameters: Type.Object({ command: Type.String() }),
      async execute() { throw new AssumeError(`Extension-managed profile access is unavailable. ${reason} ${SAFETY_GUIDANCE}`); },
    };
  }
  const deactivate = () => {
    pi.registerTool(roleTool());
    pi.registerTool(hiddenAwsBash());
  };

  // Diagnostics remain visible; credentialed execution stays hidden until all checks pass.
  deactivate();

  pi.on("session_start", (_event, ctx) => {
    session?.clear({ approvals: true });
    session = undefined;
    guards = undefined;
    announced = undefined;
    hasAssumed = false;
    deactivate();
    updateStatus(ctx);

    // Guard policy files before any availability check: a policy written while role access is off
    // (missing, invalid, unsupported) would otherwise take effect at the user's next /reload.
    const policyPath = join(ctx.cwd, ".pi", "aws-assume.json");
    const globalPolicyPath = join(piAgent.getAgentDir(), "aws-assume.json");
    policyGuard = createGuards({ cwd: ctx.cwd, home: homedir(), policyPath,
      additionalPolicyPaths: [globalPolicyPath], policyOnly: true });

    reason = "Only interactive terminal mode is supported.";
    if (ctx.mode !== "tui") return;
    const version = checkPiVersion(piVersion);
    if (!isUsableVersion(version)) { reason = version.message; ctx.ui.notify(unavailable(), "warning"); return; }
    reason = "The project is not trusted.";
    if (!ctx.isProjectTrusted()) return;

    // No effective rules means no role access, discovery, or guards; diagnostics remain visible.
    let policy: ReturnType<typeof loadPolicy>;
    try {
      policy = loadPolicy({
        bundledPath: fileURLToPath(new URL("./config.json", import.meta.url)),
        globalPath: globalPolicyPath,
        projectPath: policyPath,
      });
      // Pi can reload this TypeScript entry while retaining native JavaScript imports.
      // Never reinterpret the old pattern-array API or silently drop new policy settings.
      if (!policy || !Array.isArray(policy.profiles) || !Number.isInteger(policy.timeoutSeconds) ||
          policy.profiles.some((rule: { source?: unknown }) => rule.source !== "project" && rule.source !== "global")) {
        throw new AssumeError(STALE_HELPERS);
      }
    }
    catch (error) {
      reason = error instanceof Error ? error.message : "Cannot load the policy; no profiles are allowed.";
      ctx.ui.notify(unavailable(), "error");
      return;
    }
    const patterns = [...new Set(policy.profiles.map((rule: { pattern: string }) => rule.pattern))];
    type Rule = { id: string; pattern: string; autoApprove: boolean | null; source: "project" | "global" };
    const rules = policy.profiles as readonly Rule[];
    const autoApproveRules = rules.filter((rule) => rule.autoApprove === true);
    const timeoutMs = policy.timeoutSeconds * 1000;
    reason = NO_POLICY;
    if (!patterns.length) return;

    reason = "Only macOS and Linux are supported.";
    if (process.platform === "win32") { ctx.ui.notify(unavailable(), "warning"); return; }
    const executable = findGranted();
    reason = "Granted is not installed or not on PATH; no installation or fallback was attempted.";
    if (!executable) { ctx.ui.notify(unavailable(), "warning"); return; }

    const settings = pi.getSettings();
    const shellOptions = { shellPath: settings.shellPath, commandPrefix: settings.shellCommandPrefix };
    let availableProfiles: string[] = [];
    if (hasGlobPatterns(patterns)) {
      try { availableProfiles = discoverProfileNames({ cwd: ctx.cwd }); }
      catch { ctx.ui.notify("assume: cannot list AWS profile names safely. Check AWS files outside Pi. Explicit concrete names still require a matching policy rule.", "warning"); }
    }
    if (typeof discoverProfileRegionDetails !== "function" || typeof resolveRegionDetails !== "function") {
      reason = STALE_HELPERS;
      ctx.ui.notify(unavailable(), "warning");
      return;
    }
    const current = new RoleSession({ profiles: patterns,
      autoApproveRules: rules.filter((rule) => rule.autoApprove !== null), availableProfiles,
      region: (profile: string) => discoverProfileRegionDetails(profile, { cwd: ctx.cwd }), fetch: async (profile: string, options: { signal: AbortSignal }) => {
      const outcome = await ctx.ui.custom<{ credentials?: Awaited<ReturnType<typeof fetchCredentials>>; error?: unknown }>((tui, theme, _kb, done) => {
        const deadline = Date.now() + timeoutMs;
        const loader = new BorderedLoader(tui, theme,
          `AWS: resolving ${profile}. Complete browser/keychain sign-in (Esc to cancel).`);
        const countdown = new Text("", 1, 0);
        // Keep the countdown inside the loader, before its trailing spacer and bottom border.
        loader.children.splice(loader.children.length - 2, 0, countdown);
        const updateCountdown = () => {
          const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
          countdown.setText(theme.fg("muted", `Authentication timeout in ${seconds}s`));
          tui.requestRender();
        };
        updateCountdown();
        const countdownTimer = setInterval(updateCountdown, 250);
        // Own the authentication interaction even when a command has no turn signal.
        const controller = new AbortController();
        const signal = AbortSignal.any([options.signal, controller.signal]);
        let finished = false;
        const finish = (outcome: { credentials?: Awaited<ReturnType<typeof fetchCredentials>>; error?: unknown }) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          clearInterval(countdownTimer);
          signal.removeEventListener("abort", onAbort);
          done(outcome);
        };
        // The screen owns its deadline: closing it must not depend on the resolver settling.
        const timer = setTimeout(() => {
          finish({ error: new AssumeError("Granted timed out waiting for credentials or browser authentication.") });
          controller.abort();
        }, Math.max(0, deadline - Date.now()));
        const onAbort = () => finish({ error: new AssumeError("Role operation cancelled.") });
        signal.addEventListener("abort", onAbort, { once: true });
        loader.onAbort = () => controller.abort();
        if (signal.aborted) onAbort();
        if (!finished) {
          void fetchCredentials(executable, profile, { signal, cwd: ctx.cwd, timeoutMs })
            .then((credentials) => finish({ credentials }), (error) => finish({ error }));
        }
        return loader;
      });
      if (outcome.error) throw outcome.error;
      if (!outcome.credentials) throw new AssumeError("Role operation cancelled.");
      return outcome.credentials;
    } });
    // A fresh policy helper can still coexist with an older cached session implementation.
    if (!Array.isArray(current.status().autoApproveRules) || !("regionSource" in current.status())) {
      reason = STALE_HELPERS;
      ctx.ui.notify(unavailable(), "warning");
      return;
    }
    const currentGuards = createGuards({ cwd: ctx.cwd, home: homedir(), policyPath,
      additionalPolicyPaths: [globalPolicyPath] });
    const local = createLocalBashOperations({ shellPath: settings.shellPath });
    session = current;
    guards = currentGuards;
    const awsBash = createBashToolDefinition(ctx.cwd, {
      ...shellOptions,
      operations: { async exec(command, cwd, options) {
        if (session !== current) throw new AssumeError("AWS execution context changed; retry the command.");
        const blocked = currentGuards.shell(command);
        if (blocked) throw new AssumeError(blocked);
        const revision = current.revision();
        let env;
        try { env = await current.environment(options.env ?? process.env, { signal: options.signal }); }
        catch (error) { throw new AssumeError(safeMessage(error)); }
        if (session !== current || revision !== current.revision()) {
          throw new AssumeError("AWS execution context changed; retry the command.");
        }
        updateStatus(ctx);
        return local.exec(command, cwd, { ...options, env });
      } },
    });
    // A separate tool: plain bash is never replaced and keeps the ambient AWS environment.
    pi.registerTool({
      ...awsBash,
      name: AWS_BASH,
      label: "AWS bash",
      exposure: "model-only",
      description: [
        "Run a bash command with the active /assume profile's temporary credentials.",
        ...EXECUTION_GUIDANCE,
        "This tool refuses to run when no profile is active.",
        "Do not pass --profile. Do not set AWS_PROFILE. Do not run Granted.",
        awsBash.description,
      ].join(" "),
      promptSnippet: "Run bash with the active /assume AWS profile's temporary credentials",
      promptGuidelines: [
        ...EXECUTION_GUIDANCE,
        "In aws_bash, do not pass --profile. Do not set AWS_PROFILE. Do not run Granted.",
      ],
      executionMode: "sequential",
    });
    pi.registerTool(roleTool());
    updateStatus(ctx);
    // Auto-approval is policy-granted access; always surface it so an unexpected policy edit is visible.
    if (autoApproveRules.length) {
      const shown = autoApproveRules.slice(0, 10).map((rule) => `• ${rule.pattern} (${rule.source})`);
      const more = autoApproveRules.length > shown.length ? `\n• and ${autoApproveRules.length - shown.length} more` : "";
      ctx.ui.notify(`AWS auto-approval enabled for:\n${shown.join("\n")}${more}`, "warning");
    }
    if (!current.status().profiles.length) ctx.ui.notify("assume: no existing AWS profile names match the configured patterns. /reload refreshes discovery; explicit concrete names must still match the rules.", "info");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    session?.clear({ approvals: true }); session = undefined; guards = undefined; policyGuard = undefined; announced = undefined;
    hasAssumed = false;
    updateStatus(ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    const path = (event.input as { path?: string } | undefined)?.path;
    // Full guards (policy + credential stores) only with active role access; policy files are always guarded.
    const active = session && guards && ctx.mode === "tui" && ctx.isProjectTrusted() ? guards : policyGuard;
    const blocked = active?.file(event.toolName, path);
    if (blocked) return { block: true, reason: blocked };
  });

  // Awareness is independent of authorization, including unsupported modes and missing policy.
  pi.on("before_agent_start", () => {
    const state = session
      ? `active /assume profile is ${session.status().activeProfile ?? "none"}.`
      : `extension-managed profile access is unavailable and aws_bash is not provided. Reason: ${reason} Use assume_profile action=status for diagnostics.`;
    if (announced === state) return;
    announced = state;
    return { message: { customType: "assume-context", display: false, content: `AWS context: ${state} ${SAFETY_GUIDANCE}` } };
  });

  pi.registerCommand("assume", {
    description: "Select a matching AWS profile, or use list [offset]/status/cancel/clear. Cancel preserves the active role. No profile editing.",
    getArgumentCompletions(prefix) {
      const choices = ["list", "status", "cancel", "clear", ...(session?.status().profiles ?? []).map((profile: string) => `use ${profile}`)];
      return choices.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
    },
    async handler(args, ctx) {
      try {
        if (!args.trim() && !session && reason === NO_POLICY) {
          ctx.ui.notify("No AWS profiles are enabled for this project. Configure .pi/aws-assume.json, then run /reload.", "info");
          return;
        }
        if (args.trim() === "status" && !session) {
          ctx.ui.notify(unavailable(), "info");
          return;
        }
        const current = requireSession(ctx, "user");
        const input = args.trim();
        const listing = /^list(?:\s+(\d+))?$/.exec(input);
        if (input === "cancel") {
          current.cancel();
        } else if (input === "clear") {
          current.clear();
        } else if (!listing && input !== "status") {
          await ctx.waitForIdle();
          if (session !== current) throw new AssumeError("Session changed; choose the profile again.");
          const choices = current.status().profiles;
          if (!input && !choices.length) {
            ctx.ui.notify("assume: no matching profile names to show. Check the policy/AWS files or specify a concrete name explicitly.", "info");
            return;
          }
          const profile = input ? input.replace(/^use\s+/, "") : await ctx.ui.select("Assume a matching AWS profile", choices);
          if (!profile) return;
          if (session !== current) throw new AssumeError("Session changed; choose the profile again.");
          await current.assume(profile, { userInitiated: true, signal: ctx.signal });
        }
        if (session !== current) return;
        updateStatus(ctx);
        ctx.ui.notify(JSON.stringify(listing ? profilePage(current, Number(listing[1] ?? 0)) : statusSummary(current), null, 2), "info");
      } catch (error) { ctx.ui.notify(safeMessage(error), "error"); }
    },
  });
}
