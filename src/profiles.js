import { closeSync, openSync, readSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isProfileName } from "./policy.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_NAMES = 10000;

// Retain section names only, never profile values, keys, tokens, or credential_process output.
export function parseProfileNames(text, kind = "config") {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*\[([^\]\r\n]+)\]\s*(?:[#;].*)?$/.exec(line);
    if (!match) continue;
    const section = match[1].trim();
    const name = kind === "credentials" ? section : section === "default" ? section :
      section.startsWith("profile ") ? section.slice(8).trim() : undefined;
    if ((kind !== "credentials" || section !== "DEFAULT") && isProfileName(name)) names.add(name);
    if (names.size > MAX_NAMES) throw new Error("Too many AWS profile names to list safely.");
  }
  return [...names].sort();
}

// Read at most MAX_BYTES; returns undefined for a missing file.
function readLimited(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = readSync(fd, buffer, size, buffer.length - size, null);
      if (!read) break;
      size += read;
    }
    if (size > MAX_BYTES) throw new Error("AWS profile metadata file exceeds the safety limit.");
    return buffer.toString("utf8", 0, size);
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    // Never include raw file contents or machine-specific paths in a surfaced diagnostic.
    throw new Error("Cannot list AWS profile names safely. Check AWS file access/size outside Pi; raw file data withheld.");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readNames(path, kind) {
  const text = readLimited(path);
  return text === undefined ? [] : parseProfileNames(text, kind);
}

function configPath({ env, home, cwd }) {
  return resolve(cwd, env.AWS_CONFIG_FILE || join(home, ".aws", "config"));
}

const REGION = /^[a-z]{2,}(?:-[a-z0-9]+){1,4}$/;

// Retain region metadata only. An explicit operational region wins over the SSO fallback.
export function parseProfileRegionDetails(text, profile) {
  let inProfile = false;
  let region;
  let ssoRegion;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[([^\]\r\n]+)\]\s*(?:[#;].*)?$/.exec(line);
    if (section) {
      const name = section[1].trim();
      inProfile = name === "default" ? profile === "default" : name.startsWith("profile ") && name.slice(8).trim() === profile;
      continue;
    }
    if (!inProfile) continue;
    const match = /^\s*(region|sso_region)\s*=\s*([^\s#;]+)\s*(?:[#;].*)?$/.exec(line);
    if (!match || !REGION.test(match[2])) continue;
    if (match[1] === "region") region = match[2];
    else ssoRegion = match[2];
  }
  if (region) return { region, source: "profile.region" };
  if (ssoRegion) return { region: ssoRegion, source: "profile.sso_region" };
  return undefined;
}

export function parseProfileRegion(text, profile) {
  return parseProfileRegionDetails(text, profile)?.region;
}

// Best effort: any failure means "no configured region" and never surfaces file content.
export function discoverProfileRegionDetails(profile, { env = process.env, home = homedir(), cwd = process.cwd() } = {}) {
  try {
    const text = readLimited(configPath({ env, home, cwd }));
    return text === undefined ? undefined : parseProfileRegionDetails(text, profile);
  } catch {
    return undefined;
  }
}

export function discoverProfileRegion(profile, options) {
  return discoverProfileRegionDetails(profile, options)?.region;
}

export function discoverProfileNames({ env = process.env, home = homedir(), cwd = process.cwd() } = {}) {
  const credentials = env.AWS_SHARED_CREDENTIALS_FILE || join(home, ".aws", "credentials");
  const names = new Set([
    ...readNames(configPath({ env, home, cwd }), "config"),
    ...readNames(resolve(cwd, credentials), "credentials"),
  ]);
  if (names.size > MAX_NAMES) throw new Error("Too many AWS profile names to list safely.");
  return [...names].sort();
}
