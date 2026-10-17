import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parsePolicyFile, loadPolicy, matchesProfilePattern, resolveAllowedProfiles } from "../src/policy.js";
import { discoverProfileNames, discoverProfileRegion, parseProfileNames, parseProfileRegion } from "../src/profiles.js";
import { AssumeError, fetchCredentials, findGranted, parseCredentials, safeMessage, shellEnvironment } from "../src/credentials.js";
import { createGuards } from "../src/guards.js";
import { RoleSession } from "../src/session.js";
import { checkPiVersion, isUsableVersion, parseVersion } from "../src/version.js";

const now = 1700000000000;
const credentials = (expiresAt = now + 3600000) => ({ accessKeyId: "FAKE_ACCESS", secretAccessKey: "FAKE_SECRET", sessionToken: "FAKE_TOKEN", expiresAt });
const wire = (expires = Date.now() + 3600000) => ({ Version: 1, AccessKeyId: "FAKE_ACCESS", SecretAccessKey: "FAKE_SECRET", SessionToken: "FAKE_TOKEN", Expiration: new Date(expires).toISOString() });
function temporary(t) {
  const path = mkdtempSync(join(tmpdir(), "pi-assume-test-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
function deferred() { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; }

// Policy is explicit; discovery retains only profile section names, never credential values.
const rules = (...patterns) => patterns.map((pattern, n) => ({ id: `rule-${n}`, pattern }));
const ownPatterns = (text) => parsePolicyFile(text).profiles.map((rule) => rule.pattern);
test("policy supports exact names and path-style globs, remains immutable and deny-by-default", (t) => {
  const policy = parsePolicyFile(JSON.stringify({ profiles: rules("dev", "production/team:readonly") }));
  assert.deepEqual(policy.profiles.map((rule) => rule.pattern), ["dev", "production/team:readonly"]);
  assert.throws(() => policy.profiles.push({ id: "admin", pattern: "admin" }));
  assert.throws(() => { policy.profiles[0].pattern = "admin"; });
  const dir = temporary(t);
  assert.deepEqual(loadPolicy({ bundledPath: join(dir, "b.json"), globalPath: join(dir, "g.json"), projectPath: join(dir, "missing.json") }),
    { profiles: [], timeoutSeconds: 60 });
  assert.deepEqual(ownPatterns(JSON.stringify({ profiles: rules("glg/*/readonly", "glg/**", "team-?", "*") })), ["glg/*/readonly", "glg/**", "team-?", "*"]);
});
test("malformed or ambiguous policy fails closed without reflecting its content", () => {
  const invalid = ["glg/**prod", "glg/***", "glg//readonly", "glg/[ab]", "glg/{dev,prod}", "!admin", "--help", "dev;whoami", "dev\nadmin"];
  for (const text of ["FAKE_SECRET", "null", "[]", '{"profiles":"*"}', '{"profiles":["dev"]}',
    '{"profiles":[{"id":"dev","pattern":"dev"},{"id":"dev","pattern":"prod"}]}',
    ...invalid.map((pattern) => JSON.stringify({ profiles: [{ id: "x", pattern }] })),
    '{"profiles":[],"allowAll":true}', '{"profiles":[{"id":"x","pattern":"x","note":"FAKE_SECRET"}]}']) {
    assert.throws(() => parsePolicyFile(text), (error) => !error.message.includes("FAKE_SECRET"));
  }
});
test("path globs are whole-name, case-sensitive, slash-aware, and literal outside * and ?", () => {
  const cases = [
    ["glg/team/readonly", "glg/*", false],
    ["glg/team", "glg/*", true],
    ["glg/team/readonly", "glg/*/readonly", true],
    ["glg/org/team/readonly", "glg/*/readonly", false],
    ["glg/team/readonly", "glg/**", true],
    ["glg/team/read-only", "glg/t??m/read-*", true],
    ["glg/abXcdYef", "glg/a*b?*ef", true],
    ["glg/team/readonly", "glg/*/read", false],
    ["glg/team", "glg/*/**", false],
    ["glg/team/audit", "glg/**/team/**/audit", true],
    ["glg/audit", "glg/**/team/**/audit", false],
    ["glg/org/team/readonly", "glg/**", true],
    ["glg", "glg/**", false],
    ["glg/readonly", "glg/**/readonly", true],
    ["glg/org/team/readonly", "glg/**/readonly", true],
    ["other/glg/team/readonly", "glg/**", false],
    ["GLG/team/readonly", "glg/**", false],
    ["glg/a/readonly", "glg/?/readonly", true],
    ["glg/ab/readonly", "glg/?/readonly", false],
    ["glg/a/b/readonly", "glg/?/readonly", false],
    ["glg/readonly-extra", "glg/**/readonly", false],
    ["glg/.team/readonly", "glg/*/readonly", true],
    ["dev.foo+bar", "dev.foo+bar", true],
    ["devXfoooooobar", "dev.foo+bar", false],
    ["glg/a/b/c/end", "glg/**/**/end", true],
    ["glg/a/b/end", "glg/**/b/**/end", true],
    ["glg/a/b/end", "glg/**/x/**/end", false],
    ["flat", "**", true],
    ["glg/team/readonly", "*", false],
    ["glg/**", "glg/**", false],
    ["--help", "**", false],
    ["bad\nname", "**", false],
    ["glg//readonly", "glg/**", false],
  ];
  for (const [name, pattern, expected] of cases) assert.equal(matchesProfilePattern(name, pattern), expected, `${pattern} vs ${name}`);
});
test("overlapping rules resolve unique concrete names; wildcard strings are never offered", () => {
  assert.deepEqual(resolveAllowedProfiles(["glg/**/readonly", "glg/*/readonly", "flat"],
    ["other/team/readonly", "glg/a/readonly", "glg/a/readonly", "glg/org/a/readonly", "glg/a/admin", "glg/**"]),
  ["flat", "glg/a/readonly", "glg/org/a/readonly"]);
  assert.deepEqual(resolveAllowedProfiles(["missing/**"], []), []);
});
test("profile discovery parses only config/credentials section names, ignoring values and SSO sessions", () => {
  assert.deepEqual(parseProfileNames('[default]\nregion=us-east-1\n[profile glg/a/readonly]\nsso_session=fake\ncredential_process=DO_NOT_EXECUTE\n[sso-session fake]\nsso_start_url=FAKE_SECRET\n[services fake]\n[unprefixed]\n[profile glg/a/readonly]\n[profile glg/b/readonly] # comment\n[profile invalid name]\n'),
    ["default", "glg/a/readonly", "glg/b/readonly"]);
  assert.deepEqual(parseProfileNames('[glg/a/readonly]\naws_secret_access_key=FAKE_SECRET\n[default]\n[DEFAULT]\n', "credentials"),
    ["default", "glg/a/readonly"]);
});
test("discovery honors custom AWS paths, deduplicates, and handles missing files without invoking anything", (t) => {
  const home = temporary(t);
  mkdirSync(join(home, ".aws"));
  writeFileSync(join(home, ".aws/config"), "[profile glg/a/readonly]\n[profile glg/b/readonly]\n");
  writeFileSync(join(home, ".aws/credentials"), "[glg/a/readonly]\naws_secret_access_key=FAKE_SECRET\n");
  assert.deepEqual(discoverProfileNames({ home, env: {} }), ["glg/a/readonly", "glg/b/readonly"]);
  writeFileSync(join(home, "custom"), "[profile glg/custom/readonly]\n");
  assert.deepEqual(discoverProfileNames({ home, cwd: home, env: { AWS_CONFIG_FILE: "custom", AWS_SHARED_CREDENTIALS_FILE: "absent" } }), ["glg/custom/readonly"]);
  assert.deepEqual(discoverProfileNames({ home: join(home, "empty"), env: {} }), []);
});
test("oversized discovery files fail with generic diagnostics, not raw values", (t) => {
  const path = join(temporary(t), "large");
  writeFileSync(path, "FAKE_SECRET".repeat(200000));
  assert.throws(() => discoverProfileNames({ env: { AWS_CONFIG_FILE: path, AWS_SHARED_CREDENTIALS_FILE: path } }),
    (error) => /safely/.test(error.message) && !error.message.includes("FAKE_SECRET"));
});
test("approvals remain per concrete slash-delimited profile, never per matching rule", async () => {
  const fetched = [];
  const prompted = [];
  const session = new RoleSession({ profiles: ["glg/*/readonly"],
    availableProfiles: ["glg/a/readonly", "glg/b/readonly", "glg/org/c/readonly"],
    fetch: async (profile) => { fetched.push(profile); return credentials(); }, now: () => now });
  const confirm = async (profile) => { prompted.push(profile); return true; };
  await session.assume("glg/a/readonly", { confirm });
  await session.assume("glg/b/readonly", { confirm });
  await session.assume("glg/a/readonly", { confirm });
  assert.deepEqual(prompted, ["glg/a/readonly", "glg/b/readonly"]);
  assert.deepEqual(fetched, ["glg/a/readonly", "glg/b/readonly", "glg/a/readonly"]);
  assert.deepEqual(session.status().profiles, ["glg/a/readonly", "glg/b/readonly"]);
  for (const name of ["glg/*/readonly", "glg/org/c/readonly", "other/a/readonly"]) await assert.rejects(session.assume(name, { confirm }), /allowlist/);
  assert.equal(fetched.length, 3);
  // Discovery is a picker snapshot, not the authority: a new concrete name must still match.
  await session.assume("glg/new/readonly", { confirm });
  assert.equal(prompted.at(-1), "glg/new/readonly");
});
const auto = (...patterns) => patterns.map((pattern) => ({ pattern, autoApprove: true, source: "project" }));
test("auto-approval skips prompts only for matching allowed concrete profiles, including undiscovered names", async () => {
  const fetched = [];
  const prompted = [];
  const session = new RoleSession({ profiles: ["example/**/readonly", "example/*/admin", "exact"],
    autoApproveRules: auto("example/*/readonly", "exact", "outside/**"),
    fetch: async (profile) => { fetched.push(profile); return credentials(); }, now: () => now });
  const confirm = async (profile) => { prompted.push(profile); return false; };
  assert.equal(session.status().activeProfile, null);
  assert.deepEqual(session.status().approvedProfiles, []);
  assert.equal(fetched.length, 0, "config never activates a role");
  await session.assume("example/new/readonly", { confirm });
  await session.assume("exact", { confirm });
  assert.deepEqual(prompted, []);
  assert.deepEqual(session.status().approvedProfiles, ["example/new/readonly", "exact"]);
  for (const profile of ["example/org/team/readonly", "example/team/admin"]) {
    await assert.rejects(session.assume(profile, { confirm }), /declined/);
  }
  for (const profile of ["outside/team", "example/*/readonly", "EXAMPLE/team/readonly", "example//readonly"]) {
    await assert.rejects(session.assume(profile, { confirm }), /allowlist/);
  }
  assert.deepEqual(prompted, ["example/org/team/readonly", "example/team/admin"]);
  assert.deepEqual(fetched, ["example/new/readonly", "exact"]);
  session.clear({ approvals: true });
  assert.equal(session.status().activeProfile, null);
  assert.deepEqual(session.status().approvedProfiles, []);
  await assert.rejects(session.environment({}), /No AWS profile is active/);
  await session.assume("example/new/readonly", { confirm });
  assert.equal(prompted.length, 2, "configured auto-approval remains after reset without automatic activation");
});
test("policy auto-approvals are reported; prompted, user, and repeat approvals are not", async () => {
  const reported = [];
  const session = new RoleSession({ profiles: ["a", "b", "c"], autoApproveRules: auto("a", "c"),
    fetch: async () => credentials(), now: () => now });
  const onAutoApprove = (profile) => reported.push(profile);
  await session.assume("a", { onAutoApprove });
  await session.assume("a", { onAutoApprove });
  await session.assume("b", { confirm: async () => true, onAutoApprove });
  await session.assume("c", { userInitiated: true, onAutoApprove });
  assert.deepEqual(reported, ["a"]);
  const throwing = new RoleSession({ profiles: ["a"], autoApproveRules: auto("a"), fetch: async () => credentials(), now: () => now });
  await throwing.assume("a", { onAutoApprove: () => { throw new Error("notice failed"); } });
  assert.equal(throwing.status().activeProfile, "a", "a failing notice does not change role state");
});
test("project rules that set autoApprove decide, false wins; selected global rules apply only otherwise", async () => {
  const rule = (pattern, autoApprove, source) => ({ pattern, autoApprove, source });
  const session = new RoleSession({ profiles: ["example/**"], fetch: async () => credentials(), now: () => now,
    autoApproveRules: [
      rule("example/*/readonly", true, "global"),
      rule("example/**", true, "global"),
      rule("example/prod/*", false, "project"),
      rule("example/dev/*", true, "project"),
      rule("example/dev/admin", false, "project"),
      rule("example/team/*", null, "project"),
      rule("example/*/other", true, "unknown"),
    ] });
  const decisions = {};
  for (const profile of ["example/team/readonly", "example/prod/readonly", "example/dev/readonly", "example/dev/admin",
    "example/x/other", "example/x/y/z"]) {
    let prompted = false;
    try { await session.assume(profile, { confirm: async () => { prompted = true; return false; } }); } catch { /* declined */ }
    decisions[profile] = prompted ? "confirm" : "auto";
  }
  assert.deepEqual(decisions, {
    "example/team/readonly": "auto", // omitted project autoApprove has no opinion; global true applies
    "example/prod/readonly": "confirm", // project false overrides global true
    "example/dev/readonly": "auto", // project true
    "example/dev/admin": "confirm", // false wins among matching project rules
    "example/x/other": "auto", // unknown sources are ignored; global example/** applies
    "example/x/y/z": "auto",
  });
  assert.deepEqual(session.status().autoApproveRules.map((r) => r.source), ["global", "global", "project", "project", "project"]);
  const confirmOnly = new RoleSession({ profiles: ["a"], autoApproveRules: [rule("a", false, "global")],
    fetch: async () => credentials(), now: () => now });
  await assert.rejects(confirmOnly.assume("a"), /declined/, "no auto-approval without a true rule");
});
test("auto-approved failed switches preserve the active role; reset cancels pending auto-approved work", async () => {
  const gate = deferred();
  let pending = false;
  const session = new RoleSession({ profiles: ["a", "b"], autoApproveRules: auto("*"), now: () => now,
    fetch: async (profile) => {
      if (pending) return gate.promise;
      if (profile === "b") throw new AssumeError("fetch failed");
      return credentials();
    } });
  await session.assume("a");
  await assert.rejects(session.assume("b"), /fetch failed/);
  assert.equal(session.status().activeProfile, "a");
  assert.deepEqual(session.status().approvedProfiles, ["a", "b"]);
  pending = true;
  const operation = session.assume("b");
  await delay(0);
  session.clear({ approvals: true });
  gate.resolve(credentials());
  await assert.rejects(operation, /cancelled/);
  assert.equal(session.status().activeProfile, null);
  assert.deepEqual(session.status().approvedProfiles, []);
});
test("credential validation requires versioned, future, temporary credentials", () => {
  assert.equal(parseCredentials(JSON.stringify(wire(now + 3600000)), now).expiresAt, now + 3600000);
  for (const value of [null, {}, { ...wire(), Version: 2 }, { ...wire(), SessionToken: "" },
    { ...wire(), SecretAccessKey: "bad\nvalue" }, { ...wire(), Expiration: "not-a-date" }, wire(now)]) {
    assert.throws(() => parseCredentials(JSON.stringify(value), now), AssumeError);
  }
  assert.throws(() => parseCredentials("FAKE_SECRET"), (error) => !error.message.includes("FAKE_SECRET"));
  assert.ok(!safeMessage(new Error("FAKE_SECRET")).includes("FAKE_SECRET"));
});
test("shell env strips inherited identity, preserves unrelated data, and keeps the inherited region", () => {
  const base = { AWS_PROFILE: "admin", AWS_DEFAULT_PROFILE: "admin", AWS_ACCESS_KEY_ID: "old", AWS_SECRET_ACCESS_KEY: "old",
    AWS_SESSION_TOKEN: "old", GRANTED_COMMAND: "assume admin", AWS_ROLE_ARN: "old", AWS_WEB_IDENTITY_TOKEN_FILE: "old",
    AWS_CONTAINER_CREDENTIALS_FULL_URI: "old", AWS_CONFIG_FILE: "/private/config", AWS_SHARED_CREDENTIALS_FILE: "/private/credentials",
    AWS_REGION: "eu-west-1", PATH: "/usr/bin", PI_SESSION_ID: "test" };
  const clean = shellEnvironment(base);
  assert.deepEqual(clean, { PATH: "/usr/bin", PI_SESSION_ID: "test", AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "eu-west-1" });
  const env = shellEnvironment(base, credentials());
  assert.equal(env.AWS_ACCESS_KEY_ID, "FAKE_ACCESS");
  assert.equal(env.AWS_SESSION_TOKEN, "FAKE_TOKEN");
  assert.equal(base.AWS_PROFILE, "admin");
});
test("region order: inherited AWS_REGION, inherited AWS_DEFAULT_REGION, profile region, then us-east-1", () => {
  const region = (base, profile) => shellEnvironment(base, credentials(), profile).AWS_REGION;
  assert.equal(region({ AWS_REGION: "eu-west-1", AWS_DEFAULT_REGION: "ap-south-1" }, "us-west-2"), "eu-west-1");
  assert.equal(region({ AWS_DEFAULT_REGION: "ap-south-1" }, "us-west-2"), "ap-south-1");
  assert.equal(region({}, "us-west-2"), "us-west-2");
  assert.equal(region({}), "us-east-1");
  assert.equal(shellEnvironment({}, credentials(), "us-west-2").AWS_DEFAULT_REGION, "us-west-2");
});
test("profile region discovery reads only the named profile's region and fails quietly", (t) => {
  const text = "[default]\nregion = eu-central-1\n[profile dev]\nsso_session = x\nregion=us-west-2 ; comment\naws_secret_access_key = FAKE_SECRET\n[profile other]\nregion = ap-south-1\n[sso-session dev]\nregion = eu-west-1\n[profile bad]\nregion = $(whoami)\n";
  assert.equal(parseProfileRegion(text, "dev"), "us-west-2");
  assert.equal(parseProfileRegion(text, "default"), "eu-central-1");
  assert.equal(parseProfileRegion(text, "other"), "ap-south-1");
  assert.equal(parseProfileRegion(text, "missing"), undefined);
  assert.equal(parseProfileRegion(text, "bad"), undefined);
  const dir = temporary(t);
  writeFileSync(join(dir, "config"), text);
  assert.equal(discoverProfileRegion("dev", { env: { AWS_CONFIG_FILE: join(dir, "config") }, home: dir, cwd: dir }), "us-west-2");
  assert.equal(discoverProfileRegion("dev", { env: {}, home: join(dir, "none"), cwd: dir }), undefined);
  writeFileSync(join(dir, "huge"), "x".repeat(2 * 1024 * 1024 + 1));
  assert.equal(discoverProfileRegion("dev", { env: { AWS_CONFIG_FILE: join(dir, "huge") }, home: dir, cwd: dir }), undefined);
});
test("the active profile's configured region is used when no region is inherited", async () => {
  const session = new RoleSession({ profiles: ["a", "b"], fetch: async () => credentials(), now: () => now,
    region: (profile) => (profile === "a" ? "us-west-2" : undefined) });
  await session.assume("a", { userInitiated: true });
  assert.equal((await session.environment({})).AWS_REGION, "us-west-2");
  assert.equal((await session.environment({ AWS_REGION: "eu-west-1" })).AWS_REGION, "eu-west-1");
  await session.assume("b", { userInitiated: true });
  assert.equal((await session.environment({})).AWS_REGION, "us-east-1");
});
test("Pi version gate: any supported-major version at or above the minimum is silent; older, other major, or invalid is unavailable", () => {
  const opts = { min: "1.2.0" };
  assert.deepEqual(parseVersion("1.2.3-beta.1"), [1, 2, 3]);
  assert.equal(parseVersion("latest"), undefined);
  assert.equal(checkPiVersion("1.2.0", opts).status, "ok");
  assert.equal(checkPiVersion("1.3.0", opts).status, "ok");
  assert.deepEqual(checkPiVersion("1.3.1", opts), { status: "ok", message: "" });
  assert.deepEqual(checkPiVersion("1.99.0-rc.1", opts), { status: "ok", message: "" });
  assert.equal(checkPiVersion("1.1.9", opts).status, "older");
  assert.equal(checkPiVersion("2.0.0", opts).status, "major");
  assert.equal(checkPiVersion("0.9.0", opts).status, "major");
  assert.equal(checkPiVersion(undefined, opts).status, "invalid");
  for (const [version, usable] of [["1.2.0", true], ["1.3.1", true], ["1.1.0", false], ["2.0.0", false], ["x", false]]) {
    assert.equal(isUsableVersion(checkPiVersion(version, opts)), usable, version);
  }
});
test("no startup fetch, and non-allowlisted profiles never reach approval/backend", async () => {
  let calls = 0;
  const session = new RoleSession({ profiles: ["dev"], fetch: () => { calls++; }, now: () => now });
  assert.equal(session.status().activeProfile, null);
  await assert.rejects(session.assume("admin", { confirm: () => { calls++; } }), /allowlist/);
  await assert.rejects(session.environment({}), /No AWS profile is active/);
  assert.equal(calls, 0);
});
test("approval is once per profile; user selection counts; clear keeps approvals", async () => {
  let prompts = 0;
  const session = new RoleSession({ profiles: ["a", "b"], fetch: async () => credentials(), now: () => now });
  const confirm = async () => { prompts++; return true; };
  await session.assume("a", { confirm });
  await session.assume("b", { userInitiated: true });
  await session.assume("a", { confirm });
  session.clear();
  await session.assume("b", { confirm });
  assert.equal(prompts, 1);
  assert.deepEqual(session.status().approvedProfiles, ["a", "b"]);
  assert.ok(!JSON.stringify(session.status()).includes("FAKE_SECRET"));
  assert.equal(JSON.stringify(session), "{}");
  session.clear({ approvals: true });
  assert.deepEqual(session.status().approvedProfiles, []);
  assert.equal(session.status().activeProfile, null);
});
test("denial and failed switch leave the existing role unchanged", async () => {
  const session = new RoleSession({ profiles: ["a", "b"], fetch: async (p) => {
    if (p === "b") throw new AssumeError("fetch failed");
    return credentials();
  }, now: () => now });
  await session.assume("a", { userInitiated: true });
  await assert.rejects(session.assume("b", { confirm: async () => false }), /declined/);
  assert.deepEqual(session.status().approvedProfiles, ["a"]);
  await assert.rejects(session.assume("b", { confirm: async () => true }), /fetch failed/);
  assert.equal(session.status().activeProfile, "a");
});
test("refresh is lazy, shared by concurrent requests, and not role reactivation", async () => {
  let time = now;
  let calls = 0;
  const session = new RoleSession({ profiles: ["a"], fetch: async () => { calls++; return credentials(time + 3600000); }, now: () => time });
  await session.assume("a", { userInitiated: true });
  await session.environment({});
  assert.equal(calls, 1);
  time += 3400000;
  await Promise.all([session.environment({}), session.environment({})]);
  assert.equal(calls, 2);
  session.clear();
  await assert.rejects(session.environment({}), /No AWS profile is active/);
  assert.equal(calls, 2);
});
test("failed refresh prevents an environment snapshot from being used", async () => {
  let time = now;
  let fail = false;
  const session = new RoleSession({ profiles: ["a"], now: () => time, fetch: async () => {
    if (fail) throw new AssumeError("refresh failed");
    return credentials();
  } });
  await session.assume("a", { userInitiated: true });
  time += 3500000; fail = true;
  await assert.rejects(session.environment({}), /refresh failed/);
});
test("clear/reset during authentication prevents stale activation and cancels queued work", async () => {
  const gate = deferred();
  const session = new RoleSession({ profiles: ["a"], fetch: async () => gate.promise, now: () => now });
  const pending = session.assume("a", { userInitiated: true });
  await delay(0);
  const queued = session.assume("a", { userInitiated: true });
  session.clear({ approvals: true });
  gate.resolve(credentials());
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(queued, /cancelled/);
  assert.equal(session.status().activeProfile, null);
  assert.deepEqual(session.status().approvedProfiles, []);
});
test("cancel preserves active credentials, rejects late and queued work, and permits retry", async () => {
  const gate = deferred();
  let blocked = false;
  const session = new RoleSession({ profiles: ["a", "b"], now: () => now,
    fetch: async () => blocked ? gate.promise : credentials() });
  await session.assume("a", { userInitiated: true });
  const before = await session.environment({});
  blocked = true;
  const pending = session.assume("b", { userInitiated: true });
  await delay(0);
  const queued = session.assume("b", { userInitiated: true });
  session.cancel();
  gate.resolve(credentials());
  await assert.rejects(pending, /cancelled/);
  await assert.rejects(queued, /cancelled/);
  assert.equal(session.status().activeProfile, "a");
  assert.deepEqual(await session.environment({}), before);
  blocked = false;
  await session.assume("b", { userInitiated: true });
  assert.equal(session.status().activeProfile, "b");
});
test("cancelled refresh rejects the pending environment without clearing the role", async () => {
  let time = now;
  const gate = deferred();
  let refresh = false;
  const session = new RoleSession({ profiles: ["a"], now: () => time,
    fetch: async () => refresh ? gate.promise : credentials() });
  await session.assume("a", { userInitiated: true });
  time += 3500000;
  refresh = true;
  const pending = session.environment({});
  await delay(0);
  session.cancel();
  gate.resolve(credentials());
  await assert.rejects(pending, /cancelled/);
  assert.equal(session.status().activeProfile, "a");
});
test("abort during approval never fetches or remembers approval", async () => {
  const controller = new AbortController();
  let fetched = false;
  const session = new RoleSession({ profiles: ["a"], fetch: () => { fetched = true; } });
  await assert.rejects(session.assume("a", { signal: controller.signal, confirm: async () => {
    controller.abort(); return true;
  } }), /cancelled/);
  assert.equal(fetched, false);
  assert.deepEqual(session.status().approvedProfiles, []);
});
test("file guards cover credential stores, policy writes, and symlink aliases", (t) => {
  const cwd = temporary(t);
  const home = join(cwd, "home");
  mkdirSync(join(home, ".aws"), { recursive: true });
  symlinkSync(join(home, ".aws"), join(cwd, "alias"));
  const guard = createGuards({ cwd, home, policyPath: join(cwd, ".pi/aws-assume.json"), env: {} });
  assert.ok(guard.file("read", "~/\.aws/credentials"));
  assert.ok(guard.file("write", "alias/new-config"));
  const guidance = guard.file("edit", ".pi/aws-assume.json");
  assert.match(guidance, new RegExp(`requires you to make this change yourself in ${join(cwd, ".pi/aws-assume.json")}:.*code snippet.*/reload`));
  assert.match(guidance, /Never include credentials/);
  assert.match(guard.file("write", "alias/new-config"), /make this change yourself in .*new-config/);
  assert.equal(guard.file("write", "extensions/aws-assume/index.ts"), undefined);
  assert.equal(guard.file("read", ".pi/aws-assume.json"), undefined);
  assert.equal(guard.file("write", "src/app.js"), undefined);
});
test("shell guards reject common profile bypasses but do not block STS or region overrides", () => {
  const guard = createGuards({ cwd: "/work", home: "/home/example", policyPath: "/work/.pi/aws-assume.json", env: {} });
  for (const command of ["assume dev", "granted credential-process --profile dev", "/opt/bin/assumego dev", '"/opt/bin/granted" sso login',
    "aws configure set region us-west-2", "aws configure sso", "aws sso login", "aws sso logout",
    "aws --profile dev s3 ls", "aws s3 ls --profile=admin", "AWS_PROFILE=admin aws s3 ls", "cat ~/.aws/credentials",
    "cat $HOME/.granted/config", "rm .pi/aws-assume.json"]) assert.ok(guard.shell(command), command);
  for (const command of ["aws sts assume-role --role-arn arn:aws:iam::123456789012:role/example --role-session-name test",
    "aws sts get-caller-identity", "aws --region eu-west-1 s3 ls", "git status"]) assert.equal(guard.shell(command), undefined, command);
  // Ordinary mentions are not command invocations or credential-store paths.
  for (const command of ['git commit -m "we assume x"', "grep -rn granted src", "cd ../granted && ls", "echo granted",
    "ls node_modules/.aws-sdk"]) assert.equal(guard.shell(command), undefined, command);
  for (const command of ["echo hi && granted sso login", "x=$(granted token)", "sudo granted sso login", "ls ~/.aws"]) {
    assert.ok(guard.shell(command), command);
  }
});
test("shell guards reject project/global policy and custom AWS file paths in common spellings", () => {
  const guard = createGuards({ cwd: "/work", home: "/home/example", policyPath: "/work/.pi/aws-assume.json",
    additionalPolicyPaths: ["/home/example/.pi/agent/aws-assume.json"],
    env: { AWS_CONFIG_FILE: "/home/example/custom/aws-config" } });
  for (const command of ["cat /home/example/.pi/agent/aws-assume.json", "cat ~/.pi/agent/aws-assume.json",
    "echo x > $HOME/.pi/agent/aws-assume.json", "cat ${HOME}/.pi/agent/aws-assume.json",
    "cat \"$PI_CODING_AGENT_DIR/aws-assume.json\"", "cd ~/.pi/agent && cat aws-assume.json", "cat .pi/aws-assume.json",
    "cat ~/custom/aws-config", "cat $HOME/custom/aws-config", "cat /home/example/custom/aws-config"]) {
    assert.ok(guard.shell(command), command);
  }
  assert.match(guard.shell("cd ~/.pi/agent && cat aws-assume.json"),
    /read tool.*yourself in \/work\/\.pi\/aws-assume\.json or \/home\/example\/\.pi\/agent\/aws-assume\.json:.*code snippet/);
  assert.doesNotMatch(guard.shell("cat ~/custom/aws-config"), /yourself in/);
  for (const command of ["cat ~/.pi/agent/settings.json", "ls ~/custom"]) {
    assert.equal(guard.shell(command), undefined, command);
  }
});
test("Granted executable discovery only finds real executable files", (t) => {
  const bin = temporary(t);
  assert.equal(findGranted({ PATH: bin }), undefined);
  writeFileSync(join(bin, "granted"), "not executable");
  assert.equal(findGranted({ PATH: bin }), undefined);
  rmSync(join(bin, "granted"));
  writeFileSync(join(bin, "granted"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.equal(findGranted({ PATH: bin }), realpathSync(join(bin, "granted")));
});
test("credential subprocess uses argv, keeps both streams private, and validates output", async (t) => {
  const bin = temporary(t);
  const executable = join(bin, "granted");
  writeFileSync(executable, `#!${process.execPath}\nif (process.argv.slice(2).join('|') !== 'credential-process|--profile|dev|--window|5m|--auto-login') process.exit(7);\nconsole.error('FAKE_SECRET');\nconsole.log(JSON.stringify(${JSON.stringify(wire())}));\n`, { mode: 0o755 });
  const value = await fetchCredentials(executable, "dev");
  assert.equal(value.secretAccessKey, "FAKE_SECRET");
  writeFileSync(executable, `#!${process.execPath}\nif (process.env.AWS_PROFILE || process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_CONFIG_FILE !== '/fake/custom-config' || process.env.GRANTED_SSO_BROWSER_PROFILE !== 'fake-browser') process.exit(8);\nconsole.log(JSON.stringify(${JSON.stringify(wire())}));\n`);
  await fetchCredentials(executable, "dev", { env: { ...process.env, AWS_PROFILE: "old", AWS_SECRET_ACCESS_KEY: "old", AWS_CONFIG_FILE: "/fake/custom-config", GRANTED_SSO_BROWSER_PROFILE: "fake-browser" } });
  writeFileSync(executable, `#!${process.execPath}\nconsole.log('FAKE_SECRET');console.error('FAKE_TOKEN');process.exit(9);\n`);
  await assert.rejects(fetchCredentials(executable, "dev"), (error) => error instanceof AssumeError && !/FAKE_SECRET|FAKE_TOKEN/.test(error.message));
});
test("credential subprocess handles missing executable, timeout, cancellation, and bounded output", async (t) => {
  const executable = join(temporary(t), "granted");
  await assert.rejects(fetchCredentials(executable, "dev"), /Cannot execute/);
  writeFileSync(executable, `#!${process.execPath}\nsetTimeout(() => {}, 60000);\n`, { mode: 0o755 });
  await assert.rejects(fetchCredentials(executable, "dev", { timeoutMs: 100 }), /timed out/);
  const controller = new AbortController();
  const pending = fetchCredentials(executable, "dev", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  writeFileSync(executable, `#!${process.execPath}\nprocess.stdout.write('x'.repeat(70000));\n`);
  await assert.rejects(fetchCredentials(executable, "dev"), /safety limit/);
});
