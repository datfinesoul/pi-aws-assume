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

const LABELS = Object.freeze({
  project: "Project .pi/aws-assume.json",
  global: "Global aws-assume.json",
  bundled: "Bundled aws-assume config.json",
});
const failure = (source, problem) => new Error(`${LABELS[source]} ${problem}; no profiles are allowed.`);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

// One schema for every layer: rules are exactly { id, pattern }. Only the project may select global rule IDs.
export function parsePolicyFile(text, source = "project") {
  if (!LABELS[source]) throw new TypeError("Unknown policy source.");
  let value;
  try { value = JSON.parse(text); } catch { throw failure(source, "must contain valid JSON"); }
  const keys = source === "project" ? ["global", "profiles"] : ["profiles"];
  if (!isObject(value) || Object.keys(value).some((key) => !keys.includes(key))) {
    throw failure(source, `may contain only ${keys.map((key) => `"${key}"`).join(" and ")}`);
  }
  const profiles = value.profiles ?? [];
  const global = value.global ?? [];
  if (!Array.isArray(profiles) || profiles.length > 100) throw failure(source, 'has an invalid "profiles" array');
  if (!Array.isArray(global) || global.length > 100 || global.some((id) => !isProfileName(id)) ||
      new Set(global).size !== global.length) throw failure(source, 'has an invalid or duplicate "global" rule ID');
  const ids = new Set();
  const rules = profiles.map((rule) => {
    if (!isObject(rule) || Object.keys(rule).sort().join() !== "id,pattern" ||
        !isProfileName(rule.id) || !isPattern(rule.pattern) || ids.has(rule.id)) {
      throw failure(source, 'has an invalid or duplicate rule; each rule must be { "id", "pattern" }');
    }
    ids.add(rule.id);
    return Object.freeze({ id: rule.id, pattern: rule.pattern });
  });
  return Object.freeze({ global: Object.freeze([...global]), profiles: Object.freeze(rules) });
}

function readPolicyFile(path, source) {
  let text;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw failure(source, "cannot be read");
  }
  return parsePolicyFile(text, source);
}

// Returns the effective profile patterns. Global rules apply only when the project selects their IDs,
// so rules added to the global file later never reach an existing project.
export function loadPolicy({ bundledPath, globalPath, projectPath }) {
  const project = readPolicyFile(projectPath, "project");
  if (!project) return Object.freeze([]);
  const selected = [];
  if (project.global.length) {
    // Bundled rules are the lowest layer of the selectable library; a global rule with the same ID replaces it.
    const library = new Map();
    for (const layer of [readPolicyFile(bundledPath, "bundled"), readPolicyFile(globalPath, "global")]) {
      for (const rule of layer?.profiles ?? []) library.set(rule.id, rule);
    }
    const own = new Set(project.profiles.map((rule) => rule.id));
    for (const id of project.global) {
      if (own.has(id)) throw failure("project", 'uses a "global" rule ID that is also a project rule ID');
      const rule = library.get(id);
      if (!rule) throw failure("project", 'selects a "global" rule ID that is not defined globally');
      selected.push(rule);
    }
  }
  const rules = [...selected, ...project.profiles];
  if (rules.length > 100) throw failure("project", "selects more than 100 rules in total");
  return Object.freeze([...new Set(rules.map((rule) => rule.pattern))]);
}
