import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { normalizeEnvironment } from "../src/environment.ts";
import { fetchCredentials, findGranted, shellEnvironment } from "../src/credentials.ts";
import { createGuards } from "../src/guards.ts";
import { discoverProfileNames, discoverProfileRegion } from "../src/profiles.ts";

function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), "assume windows "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const wire = () => ({ Version: 1, AccessKeyId: "FAKE_ACCESS", SecretAccessKey: "FAKE_SECRET",
  SessionToken: "FAKE_TOKEN", Expiration: new Date(Date.now() + 3600000).toISOString() });

// Node acts as a native executable: its first Granted argument names this script.
// This exercises real Windows CreateProcess without shell scripts or live authentication.
function fake(t, script) {
  const cwd = temporary(t);
  writeFileSync(join(cwd, "credential-process"), script);
  return cwd;
}

function fakeEnvironment(cwd) {
  return { ...process.env, AWS_CONFIG_FILE: join(cwd, "fake-config"),
    AWS_SHARED_CREDENTIALS_FILE: join(cwd, "fake-credentials") };
}

test("Windows discovery accepts native executables and mixed-case PATH, not batch wrappers", (t) => {
  const dir = temporary(t);
  writeFileSync(join(dir, "granted.cmd"), "must not run");
  assert.equal(findGranted({ Path: dir }, "win32"), undefined);
  mkdirSync(join(dir, "granted.exe"));
  assert.equal(findGranted({ Path: dir }, "win32"), undefined);
  rmSync(join(dir, "granted.exe"), { recursive: true });
  writeFileSync(join(dir, "granted.exe"), "discovery must not execute this");
  assert.equal(findGranted({ Path: `"${dir}"` }, "win32"), realpathSync(join(dir, "granted.exe")));
});

test("Windows environment canonicalization removes identity aliases before credential injection", () => {
  const base = { Path: "tools", aws_profile: "old", Aws_Secret_Access_Key: "OLD_SECRET",
    granted_token: "OLD_TOKEN", aws_sso_session: "old", aws_region: "us-west-2" };
  const normalized = normalizeEnvironment(base, "win32");
  const env = shellEnvironment(normalized);
  assert.equal(env.AWS_REGION, "us-west-2");
  assert.equal(env.PATH, "tools");
  for (const key of ["AWS_PROFILE", "AWS_SECRET_ACCESS_KEY", "GRANTED_TOKEN", "AWS_SSO_SESSION"]) assert.equal(env[key], undefined);
  assert.equal(base.Aws_Secret_Access_Key, "OLD_SECRET");
});

test("native credential process validates argv and sanitizes inherited identity", async (t) => {
  const cwd = fake(t, `
const assert = require('node:assert/strict');
assert.deepEqual(process.argv.slice(2), ['--profile', 'dev', '--window', '5m', '--auto-login']);
assert.equal(process.env.AWS_PROFILE, undefined);
assert.equal(process.env.AWS_SECRET_ACCESS_KEY, undefined);
console.error('PRIVATE_DIAGNOSTIC');
console.log(JSON.stringify(${JSON.stringify(wire())}));
`);
  const env = { ...fakeEnvironment(cwd), AWS_PROFILE: "old", AWS_SECRET_ACCESS_KEY: "old" };
  if (process.platform === "win32") Object.assign(env, { aws_profile: "alias", Aws_Secret_Access_Key: "alias" });
  const result = await fetchCredentials(process.execPath, "dev", { cwd, env });
  assert.equal(result.accessKeyId, "FAKE_ACCESS");
});

test("native credential process bounds output, hides errors, and times out", async (t) => {
  for (const [script, expected] of [
    ["console.error('PRIVATE_DIAGNOSTIC'); process.exit(9)", /raw output withheld/],
    ["console.log('PRIVATE_DIAGNOSTIC')", /invalid credential JSON/],
    ["process.stdout.write('x'.repeat(70000))", /safety limit/],
    ["setInterval(() => {}, 1000)", /timed out/],
  ]) {
    const cwd = fake(t, script);
    await assert.rejects(fetchCredentials(process.execPath, "dev", { cwd, env: fakeEnvironment(cwd), timeoutMs: 2000 }), (error) => {
      assert.match(error.message, expected);
      assert.doesNotMatch(error.message, /PRIVATE_DIAGNOSTIC/);
      return true;
    });
  }
});

test("native cancellation leaves the launched browser alive", async (t) => {
  const cwd = fake(t, `
const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync('browser.pid', String(child.pid));
setInterval(() => {}, 1000);
`);
  let pid;
  t.after(() => { if (pid) try { process.kill(pid); } catch {} });
  const controller = new AbortController();
  const pending = fetchCredentials(process.execPath, "dev", { cwd, env: fakeEnvironment(cwd), signal: controller.signal });
  try {
    for (let i = 0; i < 500 && !pid; i++) {
      try { pid = Number(readFileSync(join(cwd, "browser.pid"), "utf8")); } catch {}
      if (!pid) await delay(20);
    }
    assert.ok(pid, "fake browser started");
  } finally { controller.abort(); }
  await assert.rejects(pending, /cancelled/);
  await delay(200);
  assert.doesNotThrow(() => process.kill(pid, 0));
});

test("profile metadata honors Windows environment aliases and CRLF files", (t) => {
  const cwd = temporary(t);
  writeFileSync(join(cwd, "config"), "[profile dev]\r\nregion = us-gov-west-1\r\n");
  writeFileSync(join(cwd, "credentials"), "[other]\r\n");
  const env = normalizeEnvironment({ aws_config_file: "config", Aws_Shared_Credentials_File: "credentials" }, "win32");
  assert.deepEqual(discoverProfileNames({ cwd, env }), ["dev", "other"]);
  assert.equal(discoverProfileRegion("dev", { cwd, env }), "us-gov-west-1");
});

test("Pi's local Bash backend receives only the injected temporary identity", {
  skip: !process.env.PI_CODING_AGENT_ENTRY,
}, async (t) => {
  const cwd = temporary(t);
  const { createLocalBashOperations } = await import(pathToFileURL(process.env.PI_CODING_AGENT_ENTRY).href);
  const script = join(cwd, "check.cjs");
  writeFileSync(script, `
const assert = require('node:assert/strict');
assert.equal(process.env.AWS_ACCESS_KEY_ID, 'FAKE_ACCESS');
assert.equal(process.env.AWS_SECRET_ACCESS_KEY, 'FAKE_SECRET');
assert.equal(process.env.AWS_PROFILE, undefined);
assert.equal(process.env.AWS_REGION, 'us-gov-west-1');
console.log('identity isolated');
`);
  const credentials = { accessKeyId: "FAKE_ACCESS", secretAccessKey: "FAKE_SECRET", sessionToken: "FAKE_TOKEN", expiresAt: Date.now() + 3600000 };
  const base = { ...process.env, AWS_PROFILE: "ambient", AWS_SECRET_ACCESS_KEY: "ambient" };
  delete base.AWS_REGION;
  delete base.AWS_DEFAULT_REGION;
  const env = shellEnvironment(base, credentials, "us-gov-west-1");
  // Avoid developer shell hooks. These tests never invoke AWS or Granted.
  delete env.BASH_ENV;
  delete env.ENV;
  let output = "";
  const quote = (path) => "'" + path.replace(/\\/g, "/").replaceAll("'", "'\"'\"'") + "'";
  const result = await createLocalBashOperations().exec(`${quote(process.execPath)} ${quote(script)}`, cwd, {
    env, timeout: 15, onData: (data) => { output += data.toString(); },
  });
  assert.equal(result.exitCode, 0, output);
  assert.match(output, /identity isolated/);
  assert.equal(base.AWS_PROFILE, "ambient");
});

test("guards block native exe commands and Windows path aliases", (t) => {
  const cwd = temporary(t);
  const home = join(cwd, "home");
  const policyPath = join(cwd, ".pi", "aws-assume.json");
  const guards = createGuards({ cwd, home, policyPath });
  for (const command of ["granted.exe credential-process", "aws.exe configure", "aws.exe sso login"]) {
    assert.ok(guards.shell(command), command);
  }
  if (process.platform !== "win32") return;
  for (const command of ['cat ~\\.aws\\credentials', 'cat /c/Users/test/.aws/credentials',
    'C:\\tools\\GRANTED.EXE credential-process', 'aws_profile=other aws sts get-caller-identity',
    `cat "${policyPath.toUpperCase()}"`]) assert.ok(guards.shell(command), command);
  assert.ok(guards.file("write", policyPath.toUpperCase()));
  assert.equal(guards.shell("aws.exe sts get-caller-identity"), undefined);
});
