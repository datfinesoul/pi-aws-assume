import { readFileSync } from "node:fs";

export function isProfileName(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.@/+:=-]{0,127}$/.test(value) &&
    value.split("/").every(Boolean);
}

function isPattern(value) {
  return typeof value === "string" && value.length <= 128 &&
    /^[A-Za-z0-9*?][A-Za-z0-9_.@/+:=*?-]*$/.test(value) &&
    value.split("/").every((segment) => segment && (segment === "**" || !segment.includes("**")));
}

export function hasGlobPatterns(patterns) { return patterns.some((pattern) => /[*?]/.test(pattern)); }

// Match a single segment without turning user input into an executable regular expression.
function matchSegment(name, pattern) {
  let n = 0, p = 0, star = -1, retry = 0;
  while (n < name.length) {
    if (pattern[p] === "?" || pattern[p] === name[n]) { n++; p++; }
    else if (pattern[p] === "*") { star = p++; retry = n; }
    else if (star >= 0) { p = star + 1; n = ++retry; }
    else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

export function matchesProfilePattern(name, pattern) {
  if (!isProfileName(name) || !isPattern(pattern)) return false;
  const names = name.split("/");
  const parts = pattern.split("/");
  let previous = Array(names.length + 1).fill(false);
  previous[0] = true;
  for (let p = 0; p < parts.length; p++) {
    const next = Array(names.length + 1).fill(false);
    if (parts[p] === "**") {
      // Intermediate ** may consume zero segments. Trailing /** requires a descendant,
      // so glg/** matches glg/team but not the bare profile glg.
      const trailing = p === parts.length - 1;
      next[0] = !trailing && previous[0];
      for (let n = 1; n <= names.length; n++) {
        next[n] = next[n - 1] || previous[n - 1] || (!trailing && previous[n]);
      }
    } else {
      for (let n = 1; n <= names.length; n++) next[n] = previous[n - 1] && matchSegment(names[n - 1], parts[p]);
    }
    previous = next;
  }
  return previous[names.length];
}

export function isAllowedProfile(name, patterns) {
  return patterns.some((pattern) => matchesProfilePattern(name, pattern));
}

export function resolveAllowedProfiles(patterns, available = []) {
  // Preserve exact-name entries even when discovery is unavailable; Granted validates them.
  const names = new Set(patterns.filter(isProfileName));
  for (const name of available) if (isAllowedProfile(name, patterns)) names.add(name);
  return Object.freeze([...names].sort());
}

export function parsePolicy(text) {
  let value;
  try { value = JSON.parse(text); } catch { throw new Error("aws-assume.json must contain valid JSON; no profiles are allowed."); }
  if (!value || Array.isArray(value) || typeof value !== "object" ||
      Object.keys(value).some((key) => key !== "profiles") || !Array.isArray(value.profiles)) {
    throw new Error('aws-assume.json must contain only a "profiles" array; no profiles are allowed.');
  }
  const profiles = value.profiles;
  if (profiles.length > 100 || profiles.some((profile) => !isPattern(profile)) || new Set(profiles).size !== profiles.length) {
    throw new Error("aws-assume.json contains invalid or duplicate profile names/patterns; no profiles are allowed.");
  }
  return Object.freeze([...profiles]);
}

export function loadPolicy(path) {
  try { return parsePolicy(readFileSync(path, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return Object.freeze([]);
    if (error.code) throw new Error("Cannot read aws-assume.json; no profiles are allowed.");
    throw error;
  }
}
