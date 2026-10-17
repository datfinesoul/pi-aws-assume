// Optional installed-Pi integration tests. Never invoke real Granted or an LLM.
// PI_CODING_AGENT_ENTRY=/path/to/pi-coding-agent/dist/index.js node --test test/pi.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const entry = process.env.PI_CODING_AGENT_ENTRY;
const extension = resolve(dirname(fileURLToPath(import.meta.url)), "../extensions/aws-assume/index.ts");

async function setup(t, { mode = "tui", dependency = true, trusted = true,
  profiles = ["test-a", "test-b"], configuredProfiles = ["test-a", "test-b"], writePolicy = true,
  globalPolicy, projectGlobal, projectPolicy, extensionPath = extension } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-assume-integration-"));
  const oldEnv = { ...process.env };
  t.after(() => {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    rmSync(cwd, { recursive: true, force: true });
  });
  mkdirSync(join(cwd, ".pi"));
  mkdirSync(join(cwd, "bin"));
  if (writePolicy) writeFileSync(join(cwd, ".pi/aws-assume.json"), JSON.stringify({ global: projectGlobal,
    profiles: profiles.map((pattern, n) => ({ id: `rule-${n}`, pattern })), ...projectPolicy }));
  mkdirSync(join(cwd, "agent"));
  if (globalPolicy) writeFileSync(join(cwd, "agent/aws-assume.json"), JSON.stringify(globalPolicy));
  // Discovery tests must never read the developer's real AWS configuration or credentials.
  const configPath = join(cwd, "fake-aws-config");
  const credentialsPath = join(cwd, "fake-aws-credentials");
  // test-a has a configured region so region resolution can be checked end to end.
  writeFileSync(configPath, configuredProfiles.map((name) => `[profile ${name}]\nsso_session=fake\n${name === "test-a" ? "region = us-west-2\n" : ""}`).join(""));
  writeFileSync(credentialsPath, "[metadata-only]\naws_secret_access_key=FAKE_SECRET_METADATA\n");
  const log = join(cwd, "calls");
  // A guard regression must fail the test, never fall through to the user's real AWS CLI.
  writeFileSync(join(cwd, "bin/aws"), "#!/bin/sh\necho 'fake aws must not be called' >&2\nexit 87\n", { mode: 0o755 });
  if (dependency) writeFileSync(join(cwd, "bin/granted"), `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join('|')+'\\n');\nconsole.error('FAKE_SECRET_NEVER_FORWARD');\nconsole.log(JSON.stringify({Version:1,AccessKeyId:'FAKE_ACCESS',SecretAccessKey:'FAKE_SECRET',SessionToken:'FAKE_TOKEN',Expiration:new Date(Date.now()+3600000).toISOString()}));\n`, { mode: 0o755 });
  // Exclude real Granted/AWS entirely, even if executable discovery regresses.
  process.env.PATH = join(cwd, "bin");
  process.env.PI_CODING_AGENT_DIR = join(cwd, "agent");
  process.env.AWS_CONFIG_FILE = configPath;
  process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsPath;
  process.env.AWS_PROFILE = "unapproved-inherited-profile";
  process.env.AWS_SECRET_ACCESS_KEY = "FAKE_INHERITED_SECRET";
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
  delete process.env.BASH_ENV;
  for (const key of Object.keys(process.env)) if (key.startsWith("BASH_FUNC_")) delete process.env[key];
  const { loadExtensions, createExtensionRuntime } = await import(new URL("./core/extensions/loader.js", pathToFileURL(resolve(entry))));
  const { initTheme } = await import(new URL("./modes/interactive/theme/theme.js", pathToFileURL(resolve(entry))));
  initTheme("dark");
  const runtime = createExtensionRuntime();
  runtime.getSettings = () => ({ shellPath: "/bin/bash", shellCommandPrefix: "export PI_ASSUME_PREFIX_CHECK=ok" });
  const loaded = await loadExtensions([extensionPath], cwd, undefined, runtime);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const ext = loaded.extensions[0];
  const notices = [];
  const widgets = new Map();
  let prompts = 0;
  let allow = true;
  const ctx = {
    cwd, mode, hasUI: mode === "tui", isProjectTrusted: () => trusted,
    sessionManager: { getSessionId: () => "fake-session", getSessionFile: () => undefined,
      getBranch: () => { throw new Error("Must not restore role state from history"); } },
    ui: { custom: (factory) => new Promise((resolve) => {
      let component;
      component = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, (value) => {
        component?.dispose();
        resolve(value);
      });
    }), notify: (message) => notices.push(message), setStatus: () => {},
      setWidget: (key, factory) => { if (factory) widgets.set(key, factory); else widgets.delete(key); },
      confirm: async () => { prompts++; return allow; }, select: async () => "test-a" },
    waitForIdle: async () => {},
  };
  const emit = async (event, extra = {}) => {
    const results = [];
    for (const handler of ext.handlers.get(event) ?? []) results.push(await handler({ type: event, ...extra }, ctx));
    return results;
  };
  const tool = (name) => ext.tools.get(name)?.definition;
  const call = (action, profile, offset) => tool("assume_profile").execute("test-call", { action, profile, offset }, undefined, undefined, ctx);
  const metadata = async () => JSON.parse((await call("status")).content[0].text);
  const count = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").length : 0;
  const shell = (command) => tool("aws_bash").execute("test-shell", { command }, undefined, undefined, ctx);
  await emit("session_start", { reason: "startup" });
  assert.ok(!notices.some((text) => /Pi version|Requires Pi|major version/.test(text)), "supported Pi versions must not notify");
  t.after(async () => { await emit("session_shutdown"); });
  return { cwd, configPath, log, emit, tool, call, metadata, count, shell, notices, widgets, ctx, ext,
    prompts: () => prompts, deny: () => { allow = false; } };
}

// Reproduce an in-process source upgrade, not just a new session with already-current imports.
// The installed loader may keep native JS modules cached even after clearExtensionCache().
for (const helper of ["policy", "session"]) {
  test(`mixed-version reload reports a restart requirement for a cached ${helper} helper`, {
    skip: !entry,
  }, async (t) => {
    const copy = mkdtempSync(join(tmpdir(), "pi-assume-reload-"));
    t.after(() => rmSync(copy, { recursive: true, force: true }));
    const root = resolve(dirname(extension), "../..");
    cpSync(join(root, "src"), join(copy, "src"), { recursive: true });
    cpSync(join(root, "extensions"), join(copy, "extensions"), { recursive: true });
    writeFileSync(join(copy, "package.json"), '{"type":"module"}');
    const path = join(copy, "src", `${helper}.js`);
    const current = readFileSync(path, "utf8");
    const previous = helper === "policy"
      ? current.replace("export function loadPolicy(", "function loadCurrentPolicy(") + "\nexport function loadPolicy() { return []; }\n"
      : current.replace("autoApproveRules: this.#autoApproveRules.map((rule) => ({ ...rule })), ", "");
    assert.notEqual(previous, current);
    writeFileSync(path, previous);
    const warm = join(copy, "warm.ts");
    writeFileSync(warm, helper === "policy"
      ? `import { loadPolicy } from "./src/policy.js"; export default function(pi) { pi.registerCommand("warm", { handler() { return loadPolicy({}); } }); }`
      : `import { RoleSession } from "./src/session.js"; export default function(pi) { pi.registerCommand("warm", { handler() { return new RoleSession({ profiles: [] }).status(); } }); }`);
    const loader = await import(new URL("./core/extensions/loader.js", pathToFileURL(resolve(entry))));
    loader.clearExtensionCache();
    const warmed = await loader.loadExtensions([warm], copy, undefined, loader.createExtensionRuntime());
    assert.deepEqual(warmed.errors, []);
    const oldValue = await warmed.extensions[0].commands.get("warm").handler();
    if (helper === "policy") assert.deepEqual(oldValue, []);
    else assert.equal(oldValue.autoApproveRules, undefined);
    // Update the helper on disk and perform the same factory-cache reset as /reload.
    writeFileSync(path, current);
    loader.clearExtensionCache();
    const env = await setup(t, { extensionPath: join(copy, "extensions/aws-assume/index.ts") });
    const status = await env.metadata();
    assert.equal(status.available, false);
    assert.match(status.reason, /Fully exit and restart Pi/);
    assert.match(status.reason, /\/reload cannot refresh these cached helpers/);
    assert.doesNotMatch(status.reason, /project is not trusted|reading 'map'/);
    assert.equal(env.tool("aws_bash").exposure, "hidden");
    assert.equal(env.count(), 0);
    assert.ok(env.notices.some((text) => /restart Pi/.test(text)));
    await assert.rejects(env.call("assume", "test-a"), /restart Pi/);
    assert.match((await env.emit("before_agent_start"))[0].message.content, /restart Pi/);
  });
}

test("Pi loads the extension without session-side effects", { skip: !entry }, async (t) => {
  const env = await setup(t, { mode: "print" });
  assert.equal(env.tool("assume_profile").exposure, "model-only");
  assert.equal(env.tool("aws_bash").exposure, "hidden");
  assert.equal(env.tool("bash"), undefined);
  assert.equal(env.count(), 0);
  assert.equal((await env.metadata()).available, false);
  assert.match((await env.metadata()).reason, /Only interactive terminal mode/);
  assert.match((await env.emit("before_agent_start"))[0].message.content, /role access is unavailable/);
  await assert.rejects(env.call("assume", "test-a"), /Only interactive terminal mode/);
});

test("missing Granted notifies and leaves shell/guards untouched", { skip: !entry }, async (t) => {
  const env = await setup(t, { dependency: false });
  assert.equal(env.tool("assume_profile").exposure, "model-only");
  assert.match((await env.metadata()).reason, /not installed/);
  assert.equal(env.tool("aws_bash").exposure, "hidden");
  assert.equal(env.tool("bash"), undefined);
  assert.equal(env.count(), 0);
  assert.ok(env.notices.some((text) => /not installed/.test(text)));
  assert.deepEqual(await env.emit("tool_call", { toolName: "read", input: { path: "~/.aws/credentials" } }), [undefined]);
});

test("untrusted project remains inert", { skip: !entry }, async (t) => {
  const env = await setup(t, { trusted: false });
  assert.equal(env.tool("assume_profile").exposure, "model-only");
  assert.match((await env.metadata()).reason, /project is not trusted/);
  assert.equal(env.tool("aws_bash").exposure, "hidden");
  assert.equal(env.tool("bash"), undefined);
  assert.equal(env.count(), 0);
});

for (const [label, options] of [["missing", { writePolicy: false }], ["empty", { profiles: [] }]]) {
  test(`${label} policy exposes diagnostics without enabling role access`, { skip: !entry }, async (t) => {
    const env = await setup(t, options);
    assert.equal(env.tool("assume_profile").exposure, "model-only");
    const status = await env.metadata();
    assert.equal(status.available, false);
    assert.match(status.reason, /no AWS profile policy/);
    assert.match(status.guidance, /stop and report the blocker/);
    assert.match(status.guidance, /Do not fall back to ambient credentials/);
    assert.match(status.guidance, /Pi extension tool, not a shell command, function, or alias/);
    assert.match(status.guidance, /Never probe for it with bash\/type\/which/);
    assert.match(env.tool("assume_profile").description, /Pi tool, not a shell command or alias/);
    assert.ok(!JSON.stringify(status).includes("FAKE_SECRET"));
    assert.equal(env.tool("aws_bash").exposure, "hidden");
    assert.equal(env.tool("bash"), undefined);
    assert.deepEqual(env.notices, []);
    assert.equal(env.widgets.has("assume"), false);
    assert.deepEqual(await env.emit("tool_call", { toolName: "read", input: { path: "~/.aws/credentials" } }), [undefined]);
    // Policy files are always guarded from built-in writes/edits; credential stores only with active role access.
    for (const toolName of ["write", "edit"]) {
      for (const path of [".pi/aws-assume.json", join(env.cwd, "agent/aws-assume.json")]) {
        const [blocked] = await env.emit("tool_call", { toolName, input: { path } });
        assert.equal(blocked?.block, true, `${toolName} ${path}`);
        assert.match(blocked.reason, /protected from assistant edits/);
      }
    }
    assert.deepEqual(await env.emit("tool_call", { toolName: "read", input: { path: ".pi/aws-assume.json" } }), [undefined]);
    assert.deepEqual(await env.emit("tool_call", { toolName: "write", input: { path: "~/.aws/config" } }), [undefined]);
    assert.deepEqual(await env.emit("tool_call", { toolName: "bash", input: { command: "echo {} > .pi/aws-assume.json" } }), [undefined]);
    const reminder = (await env.emit("before_agent_start"))[0].message.content;
    assert.match(reminder, /role access is unavailable/);
    assert.match(reminder, /search credential stores/);
    assert.match(reminder, /not to define a shell alias/);
    assert.match(reminder, /aws_bash is not provided/);
    assert.doesNotMatch(reminder, /Use assume_profile and aws_bash only/);
    assert.doesNotMatch(reminder, /assume: /);
    assert.deepEqual(await env.emit("before_agent_start"), [undefined]);
    for (const action of ["list", "clear", "cancel"]) await assert.rejects(env.call(action), /no AWS profile policy/);
    await assert.rejects(env.shell("echo must-not-run"), /no AWS profile policy/);
    for (const action of ["status", "list", "clear", "some-profile"]) {
      await env.ext.commands.get("assume").handler(action, env.ctx);
      assert.match(env.notices.at(-1), /^assume: role access is unavailable\. This project has no AWS profile policy/);
      assert.doesNotMatch(env.notices.at(-1), /Never probe|shell alias|ambient credentials|"guidance"/);
    }
    await assert.rejects(env.call("list"), /Never probe for it/);
    await assert.rejects(env.call("assume", "test-a"), /no AWS profile policy/);
    assert.equal(env.count(), 0);
  });
}

test("global rules apply only by project-selected ID", {
  skip: !entry,
}, async (t) => {
  const env = await setup(t, { writePolicy: false, globalPolicy: { profiles: [
    { id: "readonly", pattern: "test-a" }, { id: "other", pattern: "test-b" }] } });
  assert.equal(env.tool("aws_bash").exposure, "hidden");
  assert.deepEqual(env.notices, []);
  writeFileSync(join(env.cwd, ".pi/aws-assume.json"), JSON.stringify({ global: ["readonly"] }));
  await env.emit("session_start", { reason: "reload" });
  assert.deepEqual((await env.metadata()).profiles, ["test-a"]);
  await assert.rejects(env.call("assume", "test-b"), /allowlist/);
  await env.call("assume", "test-a");
  assert.equal(env.prompts(), 1);
  const globalPath = join(env.cwd, "agent/aws-assume.json");
  assert.equal((await env.emit("tool_call", { toolName: "edit", input: { path: globalPath } }))[0].block, true);
  writeFileSync(join(env.cwd, ".pi/aws-assume.json"), JSON.stringify({ global: ["other"],
    profiles: [{ id: "mine", pattern: "test-c" }] }));
  await env.emit("session_start", { reason: "reload" });
  assert.deepEqual((await env.metadata()).profiles, ["test-b", "test-c"]);
  assert.deepEqual((await env.metadata()).approvedProfiles, []);
  assert.equal((await env.metadata()).activeProfile, null);
  await assert.rejects(env.call("assume", "test-a"), /allowlist/);
  await env.call("assume", "test-c");
  assert.equal(env.prompts(), 2);
  writeFileSync(globalPath, "FAKE_SECRET");
  await env.emit("session_start", { reason: "reload" });
  assert.equal(env.tool("aws_bash").exposure, "hidden");
  assert.ok(env.notices.some((text) => /^assume: role access is unavailable\. Global aws-assume\.json/.test(text)));
  assert.ok(!env.notices.join("\n").includes("FAKE_SECRET"));
});

test("project rules without global selections ignore global rules", {
  skip: !entry,
}, async (t) => {
  const env = await setup(t, { profiles: ["test-a"], globalPolicy: { profiles: [{ id: "other", pattern: "test-b" }] } });
  assert.deepEqual((await env.metadata()).profiles, ["test-a"]);
  await assert.rejects(env.call("assume", "test-b"), /allowlist/);
  assert.equal(env.count(), 0);
});

test("rule-level auto-approval: selected global and project matches only; project rules that set it win, false vetoes", {
  skip: !entry,
}, async (t) => {
  const env = await setup(t, {
    globalPolicy: { profiles: [
      { id: "readonly", pattern: "example/*/readonly", autoApprove: true },
      { id: "unselected", pattern: "**", autoApprove: true },
    ] },
    projectPolicy: { global: ["readonly"], profiles: [
      // Omitted autoApprove has no opinion, so this broad allow rule does not cancel the global auto-approval.
      { id: "manual", pattern: "example/**" },
      // An explicit project false overrides the selected global true for its matches.
      { id: "locked", pattern: "example/locked/readonly", autoApprove: false },
      { id: "exact", pattern: "test-a", autoApprove: true },
    ] },
    configuredProfiles: ["example/a/readonly", "example/a/admin", "example/locked/readonly", "test-a", "outside"],
  });
  env.deny();
  assert.equal(env.count(), 0);
  assert.equal((await env.metadata()).activeProfile, null);
  const loadNotice = env.notices.find((text) => text.startsWith("AWS auto-approval enabled for:"));
  assert.equal(loadNotice, "AWS auto-approval enabled for:\n• example/*/readonly (global)\n• test-a (project)");
  assert.doesNotMatch(loadNotice, /unselected|manual/);
  await env.call("assume", "example/a/readonly");
  await env.call("assume", "example/new/readonly");
  await env.call("assume", "test-a");
  assert.equal(env.prompts(), 0);
  assert.equal(env.count(), 3);
  assert.deepEqual(env.notices.filter((text) => /by an autoApprove policy rule/.test(text)).map((text) => text.split(" ")[1]),
    ["example/a/readonly", "example/new/readonly", "test-a"]);
  assert.deepEqual((await env.metadata()).autoApproveRules, [
    { pattern: "example/*/readonly", autoApprove: true, source: "global" },
    { pattern: "example/locked/readonly", autoApprove: false, source: "project" },
    { pattern: "test-a", autoApprove: true, source: "project" },
  ]);
  await assert.rejects(env.call("assume", "example/a/admin"), /declined/);
  await assert.rejects(env.call("assume", "example/org/team/readonly"), /declined/);
  await assert.rejects(env.call("assume", "example/locked/readonly"), /declined/);
  await assert.rejects(env.call("assume", "outside"), /allowlist/);
  await assert.rejects(env.call("assume", "example/*/readonly"), /allowlist/);
  assert.equal(env.count(), 3);
  assert.equal(env.prompts(), 3);
  await env.emit("session_start", { reason: "reload" });
  assert.equal((await env.metadata()).activeProfile, null);
  assert.deepEqual((await env.metadata()).approvedProfiles, []);
  assert.equal(env.count(), 3);
  await env.call("assume", "example/new/readonly");
  assert.equal(env.prompts(), 3);
  // Removing autoApprove takes effect at reload, including discarding earlier approvals.
  writeFileSync(join(env.cwd, ".pi/aws-assume.json"), JSON.stringify({ profiles: [{ id: "exact", pattern: "test-a" }] }));
  env.notices.length = 0;
  await env.emit("session_start", { reason: "reload" });
  assert.ok(!env.notices.some((text) => /autoApprove/.test(text)), "no auto-approval notice without autoApprove rules");
  await assert.rejects(env.call("assume", "test-a"), /declined/);
  assert.equal(env.count(), 4);
  assert.equal(env.prompts(), 4);
});

test("configured timeout also bounds lazy refresh and prevents the pending shell from running", {
  skip: !entry, timeout: 10000,
}, async (t) => {
  const env = await setup(t, { projectPolicy: { timeoutSeconds: 2 } });
  // Return credentials already inside the five-minute refresh window, without advancing the real clock.
  writeFileSync(join(env.cwd, "bin/granted"), `#!${process.execPath}\nconsole.log(JSON.stringify({Version:1,AccessKeyId:'FAKE_ACCESS',SecretAccessKey:'FAKE_SECRET',SessionToken:'FAKE_TOKEN',Expiration:new Date(Date.now()+60000).toISOString()}));\n`, { mode: 0o755 });
  await env.call("assume", "test-a");
  writeFileSync(join(env.cwd, "bin/granted"), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  let ready;
  const installed = new Promise((resolve) => { ready = resolve; });
  env.ctx.ui.custom = (factory) => new Promise((resolve) => {
    const loader = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, (value) => {
      loader.dispose();
      resolve(value);
    });
    assert.match(loader.render(160).join("\n"), /Authentication timeout in 2s/);
    ready();
  });
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  const pending = assert.rejects(env.shell(`${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync("marker", "ran")'`), /timed out/);
  await installed;
  t.mock.timers.tick(2000);
  await pending;
  assert.equal(existsSync(join(env.cwd, "marker")), false);
  assert.equal((await env.metadata()).activeProfile, "test-a");
});

test("reminder is injected only when the active profile changes", { skip: !entry }, async (t) => {
  const env = await setup(t);
  const reminder = async () => (await env.emit("before_agent_start"))[0]?.message?.content;
  assert.match(await reminder(), /active \/assume profile is none/);
  assert.equal(await reminder(), undefined);
  await env.call("assume", "test-a");
  assert.match(await reminder(), /active \/assume profile is test-a/);
  assert.equal(await reminder(), undefined);
  await env.emit("session_start", { reason: "reload" });
  assert.match(await reminder(), /profile is none/);
});

test("interactive Pi integration: approval, private credentials, shell environment, and all session reset reasons", {
  skip: !entry,
}, async (t) => {
  const env = await setup(t);
  assert.equal(env.count(), 0);
  assert.equal((await env.metadata()).activeProfile, null);
  assert.equal(env.tool("assume_profile").exposure, "model-only");
  assert.equal(env.tool("aws_bash").exposure, "model-only");
  assert.equal(env.tool("bash"), undefined, "plain bash is never replaced");
  const command = `${JSON.stringify(process.execPath)} -e 'console.log(JSON.stringify({active:process.env.AWS_ACCESS_KEY_ID === "FAKE_ACCESS",inherited:!!process.env.AWS_PROFILE,secret:!!process.env.AWS_SECRET_ACCESS_KEY,region:process.env.AWS_REGION,prefix:process.env.PI_ASSUME_PREFIX_CHECK,session:process.env.PI_SESSION_ID}))'`;
  // Without an active profile, aws_bash refuses instead of falling back to ambient/default credentials.
  await assert.rejects(env.shell(command), /No AWS profile is active/);
  await assert.rejects(env.call("assume", "admin"), /allowlist/);
  assert.equal(env.prompts(), 0);
  const activation = await env.call("assume", "test-a");
  assert.ok(!JSON.stringify(activation).includes("FAKE_SECRET"));
  assert.equal(env.prompts(), 1);
  assert.equal(env.count(), 1);
  const active = await env.shell(command);
  assert.deepEqual(JSON.parse(active.content[0].text), { active: true, inherited: false, secret: true, region: "us-west-2", prefix: "ok", session: "fake-session" });
  await env.call("assume", "test-a");
  assert.equal(env.prompts(), 1);
  assert.equal(env.count(), 1);
  await env.ext.commands.get("assume").handler("use test-b", env.ctx);
  await env.call("assume", "test-b");
  assert.equal(env.prompts(), 1);
  await env.call("clear");
  assert.equal((await env.metadata()).activeProfile, null);
  await assert.rejects(env.shell(command), /No AWS profile is active/);
  for (const reason of ["reload", "new", "resume", "fork"]) {
    await env.call("assume", "test-a");
    const previousCalls = env.count();
    await env.emit("session_start", { reason });
    assert.equal(env.count(), previousCalls, `${reason} must not authenticate`);
    assert.equal((await env.metadata()).activeProfile, null);
    assert.deepEqual((await env.metadata()).approvedProfiles, []);
  }
  const blocked = await env.emit("tool_call", { toolName: "write", input: { path: ".pi/aws-assume.json" } });
  assert.equal(blocked[0].block, true);
  await env.call("assume", "test-b");
  await assert.rejects(env.shell("aws --profile admin s3 ls"), /omit --profile/);
  const region = await env.shell(`${JSON.stringify(process.execPath)} -e 'console.log(process.env.AWS_REGION)'`);
  assert.equal(region.content[0].text.trim(), "us-east-1", "no inherited or profile region falls back to us-east-1");
  assert.ok(!env.notices.join("\n").includes("FAKE_SECRET"));
});

test("path glob integration lists/picks concrete matches and forwards only approved names", {
  skip: !entry,
}, async (t) => {
  const env = await setup(t, { profiles: ["glg/*/readonly", "glg/**/audit"], configuredProfiles: [
    "glg/a/readonly", "glg/b/readonly", "glg/org/team/readonly", "glg/org/team/audit", "other/a/readonly",
  ] });
  const names = ["glg/a/readonly", "glg/b/readonly", "glg/org/team/audit"];
  assert.deepEqual(JSON.parse((await env.call("list")).content[0].text).profiles, names);
  const completions = await env.ext.commands.get("assume").getArgumentCompletions("use glg/");
  assert.deepEqual(completions.map((item) => item.value), names.map((name) => `use ${name}`));
  let picker;
  env.ctx.ui.select = async (_title, options) => { picker = options; return options[0]; };
  await env.ext.commands.get("assume").handler("", env.ctx);
  assert.deepEqual(picker, names);
  assert.equal(env.prompts(), 0); // User selection counts only for this concrete profile.
  await env.call("assume", "glg/b/readonly");
  assert.equal(env.prompts(), 1);
  await env.call("assume", "glg/a/readonly");
  assert.equal(env.prompts(), 1);
  await assert.rejects(env.call("assume", "glg/*/readonly"), /concrete profile/);
  await assert.rejects(env.call("assume", "glg/org/team/readonly"), /allowlist/);
  assert.equal(env.count(), 3);
  assert.ok(!readFileSync(env.log, "utf8").includes("*"));
  assert.ok(!JSON.stringify(await env.metadata()).includes("FAKE_SECRET"));
  assert.ok(!env.notices.join("\n").includes("FAKE_SECRET"));
  writeFileSync(env.configPath, "[profile glg/new/readonly]\nsso_session=fake\n");
  await env.emit("session_start", { reason: "reload" });
  assert.equal(env.count(), 3); // Discovery/reload never authenticates.
  assert.deepEqual(JSON.parse((await env.call("list")).content[0].text).profiles, ["glg/new/readonly"]);
  assert.equal((await env.metadata()).activeProfile, null);
  assert.deepEqual((await env.metadata()).approvedProfiles, []);
});

test("large wildcard match lists are paginated without exposing nonmatching names", {
  skip: !entry,
}, async (t) => {
  const names = Array.from({ length: 205 }, (_, n) => `glg/team-${String(n).padStart(3, "0")}/readonly`);
  const env = await setup(t, { profiles: ["glg/*/readonly"], configuredProfiles: [...names, "other/private/admin"] });
  const first = JSON.parse((await env.call("list")).content[0].text);
  assert.deepEqual(first.profiles, names.slice(0, 100));
  assert.equal(first.totalProfiles, 205);
  assert.equal(first.nextOffset, 100);
  const last = JSON.parse((await env.call("list", undefined, 200)).content[0].text);
  assert.deepEqual(last.profiles, names.slice(200));
  assert.equal(last.nextOffset, null);
  await env.ext.commands.get("assume").handler("list 200", env.ctx);
  assert.deepEqual(JSON.parse(env.notices.at(-1)).profiles, names.slice(200));
  assert.equal((await env.metadata()).profiles.length, 100);
  assert.equal(env.count(), 0);
});

test("no matching glob profiles gives an empty picker result without auth or wildcard execution", {
  skip: !entry,
}, async (t) => {
  const env = await setup(t, { profiles: ["glg/**"], configuredProfiles: ["other/private/admin"] });
  env.ctx.ui.select = async () => { throw new Error("An empty picker must not open"); };
  await env.ext.commands.get("assume").handler("", env.ctx);
  assert.deepEqual(JSON.parse((await env.call("list")).content[0].text).profiles, []);
  assert.equal(env.count(), 0);
  await assert.rejects(env.call("assume", "glg/**"), /concrete profile/);
  assert.equal(env.count(), 0);
});

test("declining assistant approval never invokes Granted, but user selection counts", {
  skip: !entry,
}, async (t) => {
  const env = await setup(t);
  env.deny();
  await assert.rejects(env.call("assume", "test-a"), /declined/);
  assert.equal(env.count(), 0);
  assert.deepEqual((await env.metadata()).approvedProfiles, []);
  await env.ext.commands.get("assume").handler("use test-a", env.ctx);
  await env.call("assume", "test-a");
  assert.equal(env.count(), 1);
  assert.equal(env.prompts(), 1);
});

test("clear between environment preparation and spawn cannot launch stale credentials", {
  skip: !entry,
}, async (t) => {
  const env = await setup(t);
  await env.call("assume", "test-a");
  const pending = env.shell(`${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync("marker", "ran")'`);
  queueMicrotask(() => { void env.call("clear"); });
  await assert.rejects(pending, /context changed|cancelled/);
  assert.equal(existsSync(join(env.cwd, "marker")), false);
});

test("late user selector result cannot authenticate after session replacement", {
  skip: !entry,
}, async (t) => {
  const env = await setup(t);
  let choose;
  let ready;
  const entered = new Promise((r) => { ready = r; });
  env.ctx.ui.select = () => { ready(); return new Promise((r) => { choose = r; }); };
  const command = env.ext.commands.get("assume").handler("", env.ctx);
  await entered;
  await env.emit("session_start", { reason: "resume" });
  choose("test-a");
  await command;
  assert.equal(env.count(), 0);
  assert.equal((await env.metadata()).activeProfile, null);
});

test("authentication loader cancels command/tool work and preserves the previous role", {
  skip: !entry, timeout: 10000,
}, async (t) => {
  const env = await setup(t);
  await env.call("assume", "test-a");
  writeFileSync(join(env.cwd, "bin/granted"), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  for (const method of ["escape", "tool-abort", "cancel", "shutdown"]) {
    const controller = new AbortController();
    env.ctx.ui.custom = (factory) => new Promise((resolve) => {
      const loader = factory({ requestRender() {} }, { fg: (_color, text) => text }, {}, (value) => {
        loader.dispose();
        resolve(value);
      });
      setTimeout(() => {
        if (method === "escape") loader.handleInput("\u001b");
        else if (method === "tool-abort") controller.abort();
        else if (method === "cancel") void env.ext.commands.get("assume").handler("cancel", env.ctx);
        else void env.emit("session_shutdown");
      }, 50);
    });
    if (method === "escape") {
      await env.ext.commands.get("assume").handler("use test-b", env.ctx);
      assert.ok(env.notices.some((text) => /cancelled/.test(text)));
    } else {
      await assert.rejects(env.tool("assume_profile").execute("pending", { action: "assume", profile: "test-b" },
        controller.signal, undefined, env.ctx), /cancelled/);
    }
    if (method !== "shutdown") assert.equal((await env.metadata()).activeProfile, "test-a");
  }
});

for (const [label, options, timeoutSeconds] of [
  ["default", {}, 60],
  ["global", { globalPolicy: { timeoutSeconds: 120 } }, 120],
  ["project override", { globalPolicy: { timeoutSeconds: 120 }, projectPolicy: { timeoutSeconds: 3 } }, 3],
]) {
 test(`command authentication closes its loader at the ${label} timeout`, {
  skip: !entry, timeout: 10000,
 }, async (t) => {
  const env = await setup(t, options);
  writeFileSync(join(env.cwd, "bin/granted"), `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`, { mode: 0o755 });
  const { InteractiveMode } = await import(new URL("./modes/interactive/interactive-mode.js", pathToFileURL(resolve(entry))));
  const editor = { getText: () => "", setText() {} };
  let focused;
  let ready;
  const installed = new Promise((resolve) => { ready = resolve; });
  const countdownValues = new Set();
  let renders = 0;
  // Exercise Pi's actual custom-screen installation, restoration, and disposal, not our UI mock.
  const host = {
    editor, ui: { requestRender() {
      renders++;
      if (focused && focused !== editor) {
        const lines = focused.render(160);
        const text = lines.join("\n");
        const match = /Authentication timeout in (\d+)s/.exec(text);
        if (match) {
          countdownValues.add(Number(match[1]));
          const countdownLine = lines.findIndex((line) => line.includes("Authentication timeout in"));
          assert.ok(lines.slice(0, countdownLine).some((line) => line.includes("─")), "countdown is below the top border");
          assert.ok(lines.slice(countdownLine + 1).some((line) => line.includes("─")), "countdown is above the bottom border");
        }
      }
    }, setFocus(component) { focused = component; if (component !== editor) ready(); } },
    editorContainer: { clear() {}, addChild() {} },
    disposeActiveSelector() {}, keybindings: {},
  };
  env.ctx.ui.custom = (factory) => InteractiveMode.prototype.showExtensionCustom.call(host, factory);
  // Advance virtual time rather than waiting for authentication deadlines.
  t.mock.timers.enable({ apis: ["Date", "setTimeout", "setInterval"], now: Date.now() });
  const scheduled = [];
  const schedule = globalThis.setTimeout;
  t.mock.method(globalThis, "setTimeout", (...args) => { scheduled.push(args[1]); return schedule(...args); });
  const started = Date.now();
  const pending = env.ext.commands.get("assume").handler("use test-a", env.ctx);
  await installed;
  t.mock.timers.tick(1000);
  assert.ok(countdownValues.has(timeoutSeconds - 1), "countdown updates after one virtual second");
  t.mock.timers.tick(timeoutSeconds * 1000 - 1001);
  assert.notEqual(focused, editor, "authentication must remain open before the deadline");
  t.mock.timers.tick(1);
  await pending;
  const elapsed = Date.now() - started;
  assert.equal(focused, editor, "timeout must restore focus to the editor");
  assert.ok(countdownValues.has(timeoutSeconds), "countdown starts at the configured timeout");
  assert.ok(countdownValues.has(timeoutSeconds - 1), "countdown updates while waiting");
  assert.equal(scheduled.filter((ms) => ms === timeoutSeconds * 1000).length, 2,
    "screen and credential subprocess share the configured deadline");
  const finalRenders = renders;
  t.mock.timers.tick(350);
  assert.equal(renders, finalRenders, "countdown and spinner stop rendering after timeout");
  assert.equal(elapsed, timeoutSeconds * 1000);
  assert.ok(env.notices.some((text) => /timed out/.test(text)));
  assert.equal((await env.metadata()).activeProfile, null);
 });
}

test("AWS row right-aligns local-time expiry and stays within narrow terminal widths", {
  skip: !entry,
}, async (t) => {
  const env = await setup(t);
  const { visibleWidth } = await import(new URL("../../pi-tui/dist/index.js", pathToFileURL(resolve(entry))));
  const row = () => env.widgets.get("assume")({}, { fg: (_color, text) => text });
  assert.equal(env.widgets.has("assume"), false);
  await env.call("status");
  await env.call("clear");
  assert.equal(env.widgets.has("assume"), false);
  await assert.rejects(env.call("assume", "admin"), /allowlist/);
  env.deny();
  await assert.rejects(env.call("assume", "test-a"), /declined/);
  assert.equal(env.widgets.has("assume"), false);
  // Explicit user selection succeeds even after an assistant approval was declined.
  await env.ext.commands.get("assume").handler("use test-a", env.ctx);
  const metadata = await env.metadata();
  const { formatLocalExpiration } = await import("../src/status.js");
  const expected = `Expires ${formatLocalExpiration(metadata.expiresAt)}`;
  const line = row().render(120)[0];
  assert.ok(line.startsWith("AWS: test-a"));
  assert.ok(line.endsWith(expected));
  assert.equal(line.length, 120);
  for (const width of [0, 1, 10, 40]) assert.ok(visibleWidth(row().render(width)[0]) <= width);
  await env.call("clear");
  assert.equal(row().render(120)[0].trim(), "AWS: none");
  for (const reason of ["reload", "new", "resume", "fork"]) {
    await env.emit("session_start", { reason });
    await env.call("status");
    assert.equal(env.widgets.has("assume"), false, `${reason} hides the row until assumption`);
    await env.ext.commands.get("assume").handler("use test-a", env.ctx);
    assert.ok(row().render(120)[0].startsWith("AWS: test-a"));
  }
  await env.emit("session_shutdown");
  assert.equal(env.widgets.has("assume"), false);
});

test("invalid policy fails closed, reports the error without content, and stays inactive", {
  skip: !entry,
}, async (t) => {
  const env = await setup(t);
  writeFileSync(join(env.cwd, ".pi/aws-assume.json"), '{"profiles":["*"],"other":"FAKE_SECRET"}');
  await env.emit("session_start", { reason: "reload" });
  await assert.rejects(env.call("assume", "test-a"), /aws-assume\.json/);
  assert.equal(env.tool("aws_bash").exposure, "hidden");
  assert.equal(env.tool("assume_profile").exposure, "model-only");
  const status = await env.metadata();
  assert.equal(status.available, false);
  assert.match(status.reason, /aws-assume\.json/);
  assert.ok(!JSON.stringify(status).includes("FAKE_SECRET"));
  assert.equal(env.count(), 0);
  assert.ok(env.notices.some((text) => /aws-assume\.json/.test(text)));
  assert.ok(!env.notices.join("\n").includes("FAKE_SECRET"));
});
