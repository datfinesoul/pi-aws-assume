import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import { spawn } from "node:child_process";

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

// Region order: inherited AWS_REGION, inherited AWS_DEFAULT_REGION, the profile's configured
// region, then FALLBACK_REGION. A CLI --region or explicit SDK region still overrides it.
export function resolveRegion(base, profileRegion) {
  return base.AWS_REGION || base.AWS_DEFAULT_REGION || profileRegion || FALLBACK_REGION;
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

function grantedEnvironment(base) {
  const env = shellEnvironment(base);
  // The trusted credential resolver still needs the user's configured profile files/browser settings.
  for (const key of Object.keys(base)) {
    if (key === "AWS_CONFIG_FILE" || key === "AWS_SHARED_CREDENTIALS_FILE" || key.startsWith("GRANTED_")) env[key] = base[key];
  }
  return env;
}

// No shell, no public output callbacks, and no raw stdout/stderr in errors or logs.
export function fetchCredentials(executable, profile, { signal, env = process.env, timeoutMs = 60000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) { reject(new AssumeError("Role operation cancelled.")); return; }
    const child = spawn(executable, ["credential-process", "--profile", profile, "--window", "5m", "--auto-login"], {
      env: grantedEnvironment(env), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32",
    });
    let output = "";
    let bytes = 0;
    let failure;
    let settled = false;
    const kill = (message) => {
      if (settled) return;
      failure = new AssumeError(message);
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { /* Process may already have exited. */ }
      // Detached descendants must not hold inherited pipes open after cancellation/timeout.
      child.stdout.destroy();
      child.stderr.destroy();
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
    child.stderr.resume(); // Drain, but never forward Granted diagnostics into Pi's transcript.
    child.once("error", () => finish(new AssumeError("Cannot execute Granted. Check that it is still installed and executable.")));
    child.once("close", (code) => {
      if (failure) { finish(failure); return; }
      if (code !== 0) { finish(new AssumeError(`Granted failed (exit ${code ?? "signal"}); raw output withheld. Check Granted setup outside Pi.`)); return; }
      try { finish(undefined, parseCredentials(output)); } catch (error) { finish(error); }
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}
