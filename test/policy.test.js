import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, loadPolicy, parsePolicyFile } from "../src/policy.js";
import { createGuards } from "../src/guards.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "aws-policy-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = { bundledPath: join(dir, "bundled.json"), globalPath: join(dir, "global.json"), projectPath: join(dir, "project.json") };
  const put = (key, value) => writeFileSync(paths[key], JSON.stringify(value));
  return { dir, paths, put };
}
const library = { profiles: [{ id: "readonly", pattern: "example/**/readonly" }, { id: "audit", pattern: "example/**/audit" }] };
const patterns = (paths) => [...new Set(loadPolicy(paths).profiles.map((rule) => rule.pattern))];

test("project rules never import unselected global rules, but inherit the global timeout", (t) => {
  const { paths, put } = fixture(t);
  put("globalPath", { ...library, timeoutSeconds: 120 });
  put("projectPath", { profiles: [{ id: "admin", pattern: "example/team/admin" }] });
  assert.deepEqual(patterns(paths), ["example/team/admin"]);
  assert.equal(loadPolicy(paths).timeoutSeconds, 120);
  assert.equal(loadPolicy(paths).profiles[0].autoApprove, null, "omitted autoApprove has no opinion");
  assert.equal(loadPolicy(paths).profiles[0].source, "project");
});

test("missing, empty, or settings-only project stays inert even with global rules and auto-approval", (t) => {
  const { paths, put } = fixture(t);
  put("globalPath", { timeoutSeconds: 120, profiles: [{ id: "all", pattern: "**", autoApprove: true }] });
  assert.deepEqual(loadPolicy(paths), { profiles: [], timeoutSeconds: 60 });
  for (const project of [{}, { global: [], profiles: [] }, { timeoutSeconds: 30 }]) {
    put("projectPath", project);
    assert.deepEqual(loadPolicy(paths), { profiles: [], timeoutSeconds: project.timeoutSeconds ?? 60 });
  }
  // Inactive projects do not read the global/bundled files at all.
  writeFileSync(paths.globalPath, "FAKE_SECRET");
  writeFileSync(paths.bundledPath, "FAKE_SECRET");
  assert.deepEqual(patterns(paths), []);
});

test("projects receive only the global rule IDs they select, never later global additions", (t) => {
  const { paths, put } = fixture(t);
  put("globalPath", library);
  put("projectPath", { global: ["readonly"], profiles: [{ id: "admin", pattern: "example/team/admin" }] });
  assert.deepEqual(patterns(paths), ["example/**/readonly", "example/team/admin"]);
  put("globalPath", { profiles: [...library.profiles, { id: "everything", pattern: "**", autoApprove: true }] });
  assert.deepEqual(patterns(paths), ["example/**/readonly", "example/team/admin"]);
  assert.ok(loadPolicy(paths).profiles.every((rule) => !rule.autoApprove));
  assert.deepEqual(loadPolicy(paths).profiles.map((rule) => rule.source), ["global", "project"]);
  put("projectPath", { global: ["audit"] });
  assert.deepEqual(patterns(paths), ["example/**/audit"]);
});

test("bundled rules are selectable and replaced as a whole by a global rule with the same ID", (t) => {
  const { paths, put } = fixture(t);
  put("bundledPath", { profiles: [{ id: "readonly", pattern: "bundled/readonly", autoApprove: true }, { id: "base", pattern: "bundled/base" }] });
  put("projectPath", { global: ["readonly", "base"] });
  assert.deepEqual(patterns(paths), ["bundled/readonly", "bundled/base"]);
  assert.equal(loadPolicy(paths).profiles[0].autoApprove, true);
  put("globalPath", library);
  assert.deepEqual(patterns(paths), ["example/**/readonly", "bundled/base"]);
  assert.equal(loadPolicy(paths).profiles[0].autoApprove, null, "omission does not retain a lower layer's auto-approval");
});

test("duplicate patterns retain their rule-specific approval settings", (t) => {
  const { paths, put } = fixture(t);
  put("globalPath", library);
  put("projectPath", { global: ["readonly"], profiles: [{ id: "mine", pattern: "example/**/readonly", autoApprove: true }] });
  assert.deepEqual(patterns(paths), ["example/**/readonly"]);
  assert.deepEqual(loadPolicy(paths).profiles.map((rule) => [rule.autoApprove, rule.source]), [[null, "global"], [true, "project"]]);
});

test("unknown, conflicting, or excessive global selections fail closed and name the project file", (t) => {
  const { paths, put } = fixture(t);
  put("projectPath", { global: ["readonly"] });
  assert.throws(() => loadPolicy(paths), /^Error: Project .*not defined globally/);
  put("globalPath", library);
  put("projectPath", { global: ["readonly"], profiles: [{ id: "readonly", pattern: "example/team/readonly" }] });
  assert.throws(() => loadPolicy(paths), /^Error: Project .*also a project rule ID/);
  put("globalPath", { profiles: Array.from({ length: 60 }, (_, n) => ({ id: `g${n}`, pattern: `g${n}` })) });
  put("projectPath", { global: Array.from({ length: 60 }, (_, n) => `g${n}`),
    profiles: Array.from({ length: 41 }, (_, n) => ({ id: `p${n}`, pattern: `p${n}` })) });
  assert.throws(() => loadPolicy(paths), /more than 100 rules/);
});

test("any participating invalid/unreadable file fails closed, names its layer, and hides raw content", (t) => {
  const { paths, put } = fixture(t);
  // Global settings participate even without imported rules.
  put("projectPath", { profiles: [{ id: "own", pattern: "own" }] });
  put("globalPath", library);
  for (const [key, label] of [["bundledPath", /^Bundled/], ["globalPath", /^Global/], ["projectPath", /^Project/]]) {
    writeFileSync(paths[key], "FAKE_SECRET");
    assert.throws(() => loadPolicy(paths), (error) => label.test(error.message) && !error.message.includes("FAKE_SECRET"));
    put(key, key === "projectPath" ? { profiles: [{ id: "own", pattern: "own" }] } : key === "globalPath" ? library : { profiles: [] });
  }
  rmSync(paths.globalPath);
  mkdirSync(paths.globalPath);
  assert.throws(() => loadPolicy(paths), /^Error: Global .*cannot be read/);
});

test("only project files may select global rules; rules require id/pattern and optional boolean autoApprove", () => {
  assert.deepEqual(parsePolicyFile('{"global":["readonly"]}').global, ["readonly"]);
  for (const source of ["global", "bundled"]) {
    assert.throws(() => parsePolicyFile('{"global":["readonly"],"profiles":[]}', source), /may contain only/);
  }
  for (const value of [{ enabled: true }, { autoApprove: true }, { global: "readonly" }, { global: ["a", "a"] }, { global: ["bad;id"] },
    { profiles: ["legacy"] }, { profiles: [{}] }, { profiles: [null] }, { profiles: [{ id: "x" }] },
    { profiles: [{ pattern: "x" }] }, { profiles: [{ id: "x", pattern: "x", enabled: false }] },
    { profiles: [{ id: "x/*", pattern: "x" }] }, { profiles: [{ id: "x", pattern: "bad;name" }] }]) {
    assert.throws(() => parsePolicyFile(JSON.stringify(value)), JSON.stringify(value));
  }
  for (const source of ["project", "global", "bundled"]) {
    for (const autoApprove of [true, false]) {
      const rule = parsePolicyFile(JSON.stringify({ profiles: [{ id: "x", pattern: "x/**", autoApprove }] }), source).profiles[0];
      assert.equal(rule.autoApprove, autoApprove);
      assert.ok(Object.isFrozen(rule));
    }
    assert.equal(parsePolicyFile('{"profiles":[{"id":"x","pattern":"x"}]}', source).profiles[0].autoApprove, null);
    for (const autoApprove of [null, "true", "false", 1, 0, [], {}]) {
      assert.throws(() => parsePolicyFile(JSON.stringify({ profiles: [{ id: "x", pattern: "x", autoApprove }] }), source), /invalid/);
    }
  }
  assert.throws(() => parsePolicyFile("{}", "other"), TypeError);
});

test("timeout defaults to 60 and merges bundled < global < project, independently of selected rule IDs", (t) => {
  const { paths, put } = fixture(t);
  put("projectPath", { profiles: [{ id: "own", pattern: "own" }] });
  assert.equal(loadPolicy(paths).timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
  put("bundledPath", { timeoutSeconds: 90 });
  assert.equal(loadPolicy(paths).timeoutSeconds, 90);
  put("globalPath", { timeoutSeconds: 120 });
  assert.equal(loadPolicy(paths).timeoutSeconds, 120);
  put("projectPath", { timeoutSeconds: 5, profiles: [{ id: "own", pattern: "own" }] });
  assert.equal(loadPolicy(paths).timeoutSeconds, 5);
  assert.ok(Object.isFrozen(loadPolicy(paths)));
  assert.ok(Object.isFrozen(loadPolicy(paths).profiles));
});

test("invalid timeouts fail closed in every layer, including when the project overrides global", (t) => {
  const { paths, put } = fixture(t);
  for (const source of ["project", "global", "bundled"]) {
    for (const timeoutSeconds of [null, "60", 0, -1, 1.5, MAX_TIMEOUT_SECONDS + 1, [], {}, true]) {
      assert.throws(() => parsePolicyFile(JSON.stringify({ timeoutSeconds }), source), /invalid "timeoutSeconds"/);
    }
    for (const timeoutSeconds of [1, MAX_TIMEOUT_SECONDS]) {
      assert.equal(parsePolicyFile(JSON.stringify({ timeoutSeconds }), source).timeoutSeconds, timeoutSeconds);
    }
  }
  put("projectPath", { timeoutSeconds: 5, profiles: [{ id: "own", pattern: "own" }] });
  put("globalPath", { timeoutSeconds: "FAKE_SECRET" });
  assert.throws(() => loadPolicy(paths), (error) => /^Global/.test(error.message) && !error.message.includes("FAKE_SECRET"));
});

test("global policy and symlink aliases are protected from assistant writes and AWS shell access", (t) => {
  const { dir, paths } = fixture(t);
  writeFileSync(paths.globalPath, "{}");
  symlinkSync(paths.globalPath, join(dir, "alias"));
  const guard = createGuards({ cwd: dir, home: dir, policyPath: paths.projectPath,
    additionalPolicyPaths: [paths.globalPath], env: {} });
  assert.ok(guard.file("write", paths.globalPath));
  assert.ok(guard.file("edit", "alias"));
  assert.ok(guard.shell(`cat ${paths.globalPath}`));
  assert.equal(guard.file("read", paths.globalPath), undefined);
});
