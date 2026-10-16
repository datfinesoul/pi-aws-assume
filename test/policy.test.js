import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicyLayers, mergePolicyLayers, parsePolicyLayer } from "../src/policy.js";
import { createGuards } from "../src/guards.js";

const layer = (value) => parsePolicyLayer(JSON.stringify(value));
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "aws-policy-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = { bundledPath: join(dir, "bundled.json"), globalPath: join(dir, "global.json"), projectPath: join(dir, "project.json") };
  const put = (key, value) => writeFileSync(paths[key], JSON.stringify(value));
  return { dir, paths, put };
}

test("layers merge by ID field by field with additions, removals, and explicit re-enabling", () => {
  const bundled = layer({ profiles: [{ id: "readonly", pattern: "example/**/readonly" }] });
  const global = layer({ profiles: [{ id: "audit", pattern: "example/**/audit" }, "legacy"] });
  const project = layer({ enabled: true, profiles: [{ id: "readonly", pattern: "example/team/readonly" },
    { id: "audit", enabled: false }, { id: "legacy", enabled: false }, { id: "admin", pattern: "example/team/admin" }] });
  assert.deepEqual(mergePolicyLayers(bundled, global, project), ["example/team/readonly", "example/team/admin"]);
  assert.deepEqual(mergePolicyLayers(global, project, layer({ profiles: [{ id: "audit", enabled: true }] })),
    ["example/**/audit", "example/team/readonly", "example/team/admin"]);
  assert.throws(() => project.profiles.push({}));
  assert.throws(() => { project.profiles[0].pattern = "admin"; });
});

test("duplicate patterns across IDs deduplicate; removing one ID does not negate overlapping rules", () => {
  assert.deepEqual(mergePolicyLayers(layer({ profiles: ["example/**", { id: "same", pattern: "example/**" }] }),
    layer({ profiles: [{ id: "same", enabled: false }] })), ["example/**"]);
});

test("missing/empty/disabled project stays inert even with global rules or invalid global content", (t) => {
  const { paths, put } = fixture(t);
  writeFileSync(paths.globalPath, "FAKE_SECRET");
  assert.deepEqual(loadPolicyLayers(paths), []);
  put("projectPath", { profiles: [] });
  assert.deepEqual(loadPolicyLayers(paths), []);
  put("projectPath", { enabled: false, profiles: ["local"] });
  assert.deepEqual(loadPolicyLayers(paths), []);
  put("globalPath", { profiles: ["global"] });
  assert.deepEqual(loadPolicyLayers(paths), []);
});

test("explicit project opt-in inherits global defaults; legacy policies still activate and add", (t) => {
  const { paths, put } = fixture(t);
  put("bundledPath", { profiles: [] });
  put("globalPath", { profiles: ["global"] });
  put("projectPath", { enabled: true, profiles: [] });
  assert.deepEqual(loadPolicyLayers(paths), ["global"]);
  put("projectPath", { profiles: ["local"] });
  assert.deepEqual(loadPolicyLayers(paths), ["global", "local"]);
  rmSync(paths.globalPath);
  assert.deepEqual(loadPolicyLayers(paths), ["local"]);
  put("projectPath", { enabled: true, profiles: [] });
  assert.deepEqual(loadPolicyLayers(paths), []);
});

test("any participating invalid/unreadable layer fails the whole merge closed, without raw content", (t) => {
  const { paths, put } = fixture(t);
  put("projectPath", { enabled: true, profiles: ["local"] });
  for (const key of ["bundledPath", "globalPath", "projectPath"]) {
    writeFileSync(paths[key], "FAKE_SECRET");
    assert.throws(() => loadPolicyLayers(paths), (error) => /aws-assume.json/.test(error.message) && !error.message.includes("FAKE_SECRET"));
    put(key, { enabled: true, profiles: [] });
  }
  rmSync(paths.globalPath);
  mkdirSync(paths.globalPath);
  assert.throws(() => loadPolicyLayers(paths), /Cannot read/);
});

test("invalid rule objects and unresolved overrides fail closed", () => {
  for (const value of [{ enabled: "true", profiles: [] }, { profiles: [{}] }, { profiles: [null] },
    { profiles: [{ id: "x", pattern: "bad;name" }] }, { profiles: [{ id: "x", enabled: "false" }] },
    { profiles: [{ id: "x", extra: true }] }, { profiles: ["x", { id: "x", enabled: false }] }]) {
    assert.throws(() => layer(value));
  }
  assert.throws(() => mergePolicyLayers(layer({ profiles: [{ id: "unknown" }] })));
  assert.deepEqual(mergePolicyLayers(layer({ profiles: [{ id: "unknown", enabled: false }] })), []);
  const hundred = layer({ profiles: Array.from({ length: 100 }, (_, n) => `p${n}`) });
  assert.throws(() => mergePolicyLayers(hundred, layer({ profiles: ["extra"] })));
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
