import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { spawn } from "node:child_process";
import { discoverProfileRegion } from "./profiles.js";

export class AssumeError extends Error {
  constructor(message) { super(message); this.name = "AssumeError"; }
}

export function safeMessage(error) {
  return error instanceof AssumeError ? error.message : "Role operation failed; diagnostic output was withheld to protect credentials.";
}

export function findGranted(env = process.env) {
  for (const directory of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, "granted");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch { /* Try the next PATH entry without executing anything. */ }
  }
  return undefined;
}

export const IDENTITY_KEYS = new Set([
  "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_SECURITY_TOKEN",
  "AWS_ACCESS_KEY", "AWS_SECRET_KEY", "AWS_PROFILE", "AWS_DEFAULT_PROFILE",
  "AWS_SESSION_EXPIRATION", "AWS_CREDENTIAL_EXPIRATION", "AWS_ROLE_ARN", "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE", "AWS_CONFIG_FILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI", "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
]);

export const FALLBACK_REGION = "us-east-1";

// Region-name prefixes of the AWS partitions outside the commercial "aws" partition.
// Longer prefixes come first so "us-isob-" is not classified as "us-iso-".
const PARTITION_PREFIXES = [
  ["cn-", "aws-cn"], ["us-gov-", "aws-us-gov"], ["us-isob-", "aws-iso-b"], ["us-isof-", "aws-iso-f"],
  ["us-iso-", "aws-iso"], ["eu-isoe-", "aws-iso-e"], ["eusc-", "aws-eusc"],
];

export function regionPartition(region) {
  return PARTITION_PREFIXES.find(([prefix]) => region.startsWith(prefix))?.[1] ?? "aws";
}

// Preserve inherited region precedence within a partition, but never let an ambient region
// from another partition (for example commercial vs. China or GovCloud) redirect a configured
// profile. A CLI --region or explicit SDK region still overrides the resulting environment.
export function resolveRegionDetails(base, profileRegion, profileSource = "profile.region") {
  const inherited = base.AWS_REGION || base.AWS_DEFAULT_REGION;
  if (profileRegion && inherited && regionPartition(profileRegion) !== regionPartition(inherited)) {
    return { region: profileRegion, source: profileSource };
  }
  if (inherited) return { region: inherited, source: base.AWS_REGION ? "AWS_REGION" : "AWS_DEFAULT_REGION" };
  if (profileRegion) return { region: profileRegion, source: profileSource };
  return { region: FALLBACK_REGION, source: "default" };
}

export function resolveRegion(base, profileRegion) {
  return resolveRegionDetails(base, profileRegion).region;
}

export function shellEnvironment(base, credentials, profileRegion) {
  const region = resolveRegion(base, profileRegion);
  const env = { ...base };
  for (const key of Object.keys(env)) {
    if (IDENTITY_KEYS.has(key) || key.startsWith("GRANTED_") || key.startsWith("AWS_SSO_")) delete env[key];
  }
  env.AWS_REGION = region;
  env.AWS_DEFAULT_REGION = region;
  if (credentials) {
    env.AWS_ACCESS_KEY_ID = credentials.accessKeyId;
    env.AWS_SECRET_ACCESS_KEY = credentials.secretAccessKey;
    env.AWS_SESSION_TOKEN = credentials.sessionToken;
    env.AWS_SESSION_EXPIRATION = new Date(credentials.expiresAt).toISOString();
    env.AWS_CREDENTIAL_EXPIRATION = env.AWS_SESSION_EXPIRATION;
  }
  return env;
}

export function parseCredentials(text, now = Date.now()) {
  let value;
  try { value = JSON.parse(text); } catch { throw new AssumeError("Granted returned invalid credential JSON (output withheld)."); }
  const validSecret = (s) => typeof s === "string" && /^[\x21-\x7e]{1,16384}$/.test(s);
  const expiresAt = typeof value?.Expiration === "string" ? Date.parse(value.Expiration) : NaN;
  if (value?.Version !== 1 || !validSecret(value.AccessKeyId) || !validSecret(value.SecretAccessKey) ||
      !validSecret(value.SessionToken) || !Number.isFinite(expiresAt) || expiresAt <= now + 15000) {
    throw new AssumeError("Granted did not return valid, unexpired temporary credentials (output withheld).");
  }
  return Object.freeze({ accessKeyId: value.AccessKeyId, secretAccessKey: value.SecretAccessKey,
    sessionToken: value.SessionToken, expiresAt });
}

function grantedEnvironment(base, profile, cwd) {
  // Resolve the profile region from the same config file and working directory as the session.
  const env = shellEnvironment(base, undefined, discoverProfileRegion(profile, { env: base, cwd }));
  // The trusted credential resolver still needs the user's configured profile files/browser settings.
  for (const key of Object.keys(base)) {
    if (key === "AWS_CONFIG_FILE" || key === "AWS_SHARED_CREDENTIALS_FILE" || key.startsWith("GRANTED_")) env[key] = base[key];
  }
  return env;
}

// No shell, no public output callbacks, and no raw stdout/stderr in errors or logs.
export function fetchCredentials(executable, profile, { signal, env = process.env, cwd = process.cwd(), timeoutMs = 60000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) { reject(new AssumeError("Role operation cancelled.")); return; }
    const child = spawn(executable, ["credential-process", "--profile", profile, "--window", "5m", "--auto-login"], {
      // stderr is discarded: Granted launches the browser with its own stderr, so piping it here
      // lets an open browser hold the pipe and delay the 'close' event long after Granted exits.
      // detached keeps Granted and the browser it launches out of Pi's process group, so terminal
      // signals aimed at Pi do not reach them. Only this pid is ever signalled, never the group.
      // Granted resolves a relative AWS_CONFIG_FILE against its cwd; keep it aligned with region discovery.
      cwd, env: grantedEnvironment(env, profile, cwd), stdio: ["ignore", "pipe", "ignore"], detached: process.platform !== "win32",
    });
    let output = "";
    let bytes = 0;
    let failure;
    let settled = false;
    let escalation;
    const kill = (message) => {
      if (settled) return;
      failure = new AssumeError(message);
      // Signal Granted only, never its process group: on Linux the login browser is a descendant
      // in that group, so a group signal would close every browser window and tab. The stdout pipe
      // is destroyed below, so an orphaned descendant cannot keep completion pending.
      try { child.kill("SIGTERM"); } catch { /* Process may already have exited. */ }
      escalation = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* Already exited. */ } }, 2000);
      escalation.unref?.();
      child.stdout.destroy();
      finish(failure);
    };
    const abort = () => kill("Role operation cancelled.");
    const timer = setTimeout(() => kill("Granted timed out waiting for credentials or browser authentication."), timeoutMs);
    const finish = (error, credentials) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      output = "";
      if (error) reject(error); else resolvePromise(credentials);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 65536) kill("Granted credential output exceeded the safety limit (output withheld).");
      else output += chunk;
    });
    child.once("error", () => finish(new AssumeError("Cannot execute Granted. Check that it is still installed and executable.")));
    child.once("close", (code) => {
      clearTimeout(escalation);
      if (failure) { finish(failure); return; }
      if (code !== 0) { finish(new AssumeError(`Granted failed (exit ${code ?? "signal"}); raw output withheld. Check Granted setup outside Pi.`)); return; }
      try { finish(undefined, parseCredentials(output)); } catch (error) { finish(error); }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
