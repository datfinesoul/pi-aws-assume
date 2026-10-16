import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, parsePolicyFile } from "../src/policy.js";
import { createGuards } from "../src/guards.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "aws-policy-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = { bundledPath: join(dir, "bundled.json"), globalPath: join(dir, "global.json"), projectPath: join(dir, "project.json") };
  const put = (key, value) => writeFileSync(paths[key], JSON.stringify(value));
  return { dir, paths, put };
}
const library = { profiles: [{ id: "readonly", pattern: "example/**/readonly" }, { id: "audit", pattern: "example/**/audit" }] };

test("project rules apply without any global rules; the global file is not read", (t) => {
  const { paths, put } = fixture(t);
  writeFileSync(paths.globalPath, "FAKE_SECRET");
  writeFileSync(paths.bundledPath, "FAKE_SECRET");
  put("projectPath", { profiles: [{ id: "admin", pattern: "example/team/admin" }] });
  assert.deepEqual(loadPolicy(paths), ["example/team/admin"]);
});

test("missing or empty project stays inert even with global rules", (t) => {
  const { paths, put } = fixture(t);
  put("globalPath", library);
  assert.deepEqual(loadPolicy(paths), []);
  put("projectPath", {});
  assert.deepEqual(loadPolicy(paths), []);
  put("projectPath", { global: [], profiles: [] });
  assert.deepEqual(loadPolicy(paths), []);
});

test("projects receive only the global rule IDs they select, never later global additions", (t) => {
  const { paths, put } = fixture(t);
  put("globalPath", library);
  put("projectPath", { global: ["readonly"], profiles: [{ id: "admin", pattern: "example/team/admin" }] });
  assert.deepEqual(loadPolicy(paths), ["example/**/readonly", "example/team/admin"]);
  put("globalPath", { profiles: [...library.profiles, { id: "everything", pattern: "**" }] });
  assert.deepEqual(loadPolicy(paths), ["example/**/readonly", "example/team/admin"]);
  put("projectPath", { global: ["audit"] });
  assert.deepEqual(loadPolicy(paths), ["example/**/audit"]);
});

test("bundled rules are selectable and replaced by a global rule with the same ID", (t) => {
  const { paths, put } = fixture(t);
  put("bundledPath", { profiles: [{ id: "readonly", pattern: "bundled/readonly" }, { id: "base", pattern: "bundled/base" }] });
  put("projectPath", { global: ["readonly", "base"] });
  assert.deepEqual(loadPolicy(paths), ["bundled/readonly", "bundled/base"]);
  put("globalPath", library);
  assert.deepEqual(loadPolicy(paths), ["example/**/readonly", "bundled/base"]);
});

test("duplicate patterns across selected and project rules deduplicate", (t) => {
  const { paths, put } = fixture(t);
  put("globalPath", library);
  put("projectPath", { global: ["readonly"], profiles: [{ id: "mine", pattern: "example/**/readonly" }] });
  assert.deepEqual(loadPolicy(paths), ["example/**/readonly"]);
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
  put("projectPath", { global: ["readonly"] });
  put("globalPath", library);
  for (const [key, label] of [["bundledPath", /^Bundled/], ["globalPath", /^Global/], ["projectPath", /^Project/]]) {
    writeFileSync(paths[key], "FAKE_SECRET");
    assert.throws(() => loadPolicy(paths), (error) => label.test(error.message) && !error.message.includes("FAKE_SECRET"));
    put(key, key === "projectPath" ? { global: ["readonly"] } : key === "globalPath" ? library : { profiles: [] });
  }
  rmSync(paths.globalPath);
  mkdirSync(paths.globalPath);
  assert.throws(() => loadPolicy(paths), /^Error: Global .*cannot be read/);
});

test("only project files may select global rules; rules are exactly { id, pattern }", () => {
  assert.deepEqual(parsePolicyFile('{"global":["readonly"]}').global, ["readonly"]);
  for (const source of ["global", "bundled"]) {
    assert.throws(() => parsePolicyFile('{"global":["readonly"],"profiles":[]}', source), /may contain only "profiles"/);
  }
  for (const value of [{ enabled: true }, { global: "readonly" }, { global: ["a", "a"] }, { global: ["bad;id"] },
    { profiles: ["legacy"] }, { profiles: [{}] }, { profiles: [null] }, { profiles: [{ id: "x" }] },
    { profiles: [{ pattern: "x" }] }, { profiles: [{ id: "x", pattern: "x", enabled: false }] },
    { profiles: [{ id: "x/*", pattern: "x" }] }, { profiles: [{ id: "x", pattern: "bad;name" }] }]) {
    assert.throws(() => parsePolicyFile(JSON.stringify(value)), JSON.stringify(value));
  }
  assert.throws(() => parsePolicyFile("{}", "other"), TypeError);
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
