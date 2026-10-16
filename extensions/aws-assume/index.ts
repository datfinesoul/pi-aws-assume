import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import * as piAgent from "@earendil-works/pi-coding-agent";
import { BorderedLoader, createBashToolDefinition, createLocalBashOperations } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { AssumeError, fetchCredentials, findGranted, safeMessage } from "../../src/credentials.js";
import { createGuards } from "../../src/guards.js";
import { hasGlobPatterns, loadPolicy } from "../../src/policy.js";
import { discoverProfileNames, discoverProfileRegion } from "../../src/profiles.js";
import { RoleSession } from "../../src/session.js";
import { formatLocalExpiration } from "../../src/status.js";
import { checkPiVersion, isUsableVersion } from "../../src/version.js";

const AWS_BASH = "aws_bash";
// Reasons are plain sentences shared by user notices and model-facing output.
const NO_POLICY = "This project has no AWS profile policy (.pi/aws-assume.json), or it defines no rules and selects no global rule IDs. Create the policy outside Pi, then /reload. See pi-aws-assume's README.md.";
// Model-facing only; never shown in user notices.
const SAFETY_GUIDANCE = "assume_profile is a Pi extension tool, not a shell command, function, or alias. Never probe for it with bash/type/which or search shell startup files. If its tool declaration is unavailable, report that the Pi tool is unavailable; ask the user to check extension loading and /reload, not to define a shell alias. If the task requires an assumed profile and role access or authentication is unavailable, stop and report the blocker. Do not fall back to ambient credentials, search credential stores, invoke AWS/Granted directly to obtain credentials, or modify project/global AWS policy or AWS profile files. The user manages setup outside Pi, then /reload. Plain bash otherwise keeps the ambient AWS environment. This is guidance, not a sandbox.";
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
  const unavailable = () => `assume: role access is unavailable. ${reason}`;
  // Tool errors carry model guidance; command errors stay short for the user.
  const requireSession = (ctx: ExtensionContext, audience: "model" | "user") => {
    if (ctx.mode !== "tui" || !ctx.isProjectTrusted() || !session) {
      throw new AssumeError(audience === "model" ? `Role access is unavailable. ${reason} ${SAFETY_GUIDANCE}`
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
      description: "Select one of this project's allowed AWS profiles for aws_bash. Use only when the user or task clearly requires an assumed /assume profile; when unclear, do not use it and use plain bash with the ambient AWS environment. Actions: list concrete allowed profile names (100 per page; use nextOffset), status, assume a concrete profile name, cancel pending authentication, or clear the active profile. Approval is once per concrete profile per session, never per wildcard rule. Credential-fetch output is not exposed. This is a Pi tool, not a shell command or alias. Always available for status diagnostics even when role access is disabled; status reports the setup blocker. If an assumed profile is required but unavailable, stop and report it; do not hunt for credentials or bypass this tool.",
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
      async execute() { throw new AssumeError(`Role access is unavailable. ${reason} ${SAFETY_GUIDANCE}`); },
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

    reason = "Only interactive terminal mode is supported.";
    if (ctx.mode !== "tui") return;
    const version = checkPiVersion(piVersion);
    if (!isUsableVersion(version)) { reason = version.message; ctx.ui.notify(unavailable(), "warning"); return; }
    reason = "The project is not trusted.";
    if (!ctx.isProjectTrusted()) return;

    // No effective rules means no role access, discovery, or guards; diagnostics remain visible.
    const policyPath = join(ctx.cwd, ".pi", "aws-assume.json");
    let patterns: readonly string[] = [];
    const globalPolicyPath = join(piAgent.getAgentDir(), "aws-assume.json");
    try {
      patterns = loadPolicy({
        bundledPath: fileURLToPath(new URL("./config.json", import.meta.url)),
        globalPath: globalPolicyPath,
        projectPath: policyPath,
      });
    }
    catch (error) {
      reason = error instanceof Error ? error.message : "Cannot load the policy; no profiles are allowed.";
      ctx.ui.notify(unavailable(), "error");
      return;
    }
    reason = NO_POLICY;
    if (!patterns.length) return;

    reason = "Only macOS is supported in this alpha.";
    if (process.platform !== "darwin") { ctx.ui.notify(unavailable(), "warning"); return; }
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
    const current = new RoleSession({ profiles: patterns, availableProfiles,
      region: (profile: string) => discoverProfileRegion(profile, { cwd: ctx.cwd }), fetch: async (profile: string, options: { signal: AbortSignal }) => {
      const outcome = await ctx.ui.custom<{ credentials?: Awaited<ReturnType<typeof fetchCredentials>>; error?: unknown }>((tui, theme, _kb, done) => {
        const deadline = Date.now() + 60000;
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
          void fetchCredentials(executable, profile, { signal, timeoutMs: 60000 })
            .then((credentials) => finish({ credentials }), (error) => finish({ error }));
        }
        return loader;
      });
      if (outcome.error) throw outcome.error;
      if (!outcome.credentials) throw new AssumeError("Role operation cancelled.");
      return outcome.credentials;
    } });
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
      description: `Run a bash command with the temporary credentials of the AWS profile selected through assume_profile. Use only when the user or task clearly requires one of this project's allowed /assume profiles; otherwise use plain bash, which keeps the ambient AWS environment. Refuses to run when no profile is active. Do not pass --profile, set AWS_PROFILE, or run Granted. ${awsBash.description}`,
      promptSnippet: "Run bash with the selected /assume AWS profile's temporary credentials",
      promptGuidelines: [
        "Use assume_profile and aws_bash only when the user or task clearly requires one of this project's allowed AWS profiles; when unclear, do not use them and use plain bash.",
        "Select the profile with assume_profile before using aws_bash; never use --profile, AWS_PROFILE, or Granted commands in aws_bash.",
      ],
      executionMode: "sequential",
    });
    pi.registerTool(roleTool());
    updateStatus(ctx);
    if (!current.status().profiles.length) ctx.ui.notify("assume: no existing AWS profile names match the configured patterns. /reload refreshes discovery; explicit concrete names must still match the rules.", "info");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    session?.clear({ approvals: true }); session = undefined; guards = undefined; announced = undefined;
    hasAssumed = false;
    updateStatus(ctx);
  });

  pi.on("tool_call", (event, ctx) => {
    if (!session || !guards || ctx.mode !== "tui" || !ctx.isProjectTrusted()) return;
    const path = (event.input as { path?: string } | undefined)?.path;
    const blocked = guards.file(event.toolName, path);
    if (blocked) return { block: true, reason: blocked };
  });

  // Awareness is independent of authorization, including unsupported modes and missing policy.
  pi.on("before_agent_start", () => {
    const state = session
      ? `active /assume profile is ${session.status().activeProfile ?? "none"}. Use assume_profile and aws_bash only when the user or task clearly requires one of this project's allowed profiles; when unclear, do not use them.`
      : `role access is unavailable and aws_bash is not provided. Reason: ${reason} Use assume_profile action=status for diagnostics.`;
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
