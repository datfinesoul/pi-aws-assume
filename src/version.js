// Pi compatibility gate. Pi does not check extension compatibility on update, so the
// extension checks the running host version itself at session start. Any version of the
// supported major at or above the minimum is accepted silently.
export const MIN_PI_VERSION = "1.2.0";

// Compare major.minor.patch only; pre-release and build suffixes are ignored.
export function parseVersion(value) {
  const match = typeof value === "string" ? /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim()) : null;
  return match ? match.slice(1, 4).map(Number) : undefined;
}

function compare(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  return 0;
}

// Returns { status, message }. Only "ok" may enable role access.
export function checkPiVersion(version, { min = MIN_PI_VERSION } = {}) {
  const current = parseVersion(version);
  const minimum = parseVersion(min);
  if (!current) {
    return { status: "invalid", message: "Cannot determine the Pi version." };
  }
  const shown = current.join(".");
  if (current[0] !== minimum[0]) {
    return { status: "major", message: `Pi ${shown} is a different major version than supported (${minimum[0]}.x); update pi-aws-assume.` };
  }
  if (compare(current, minimum) < 0) {
    return { status: "older", message: `Requires Pi ${min} or newer (running ${shown}).` };
  }
  return { status: "ok", message: "" };
}

export function isUsableVersion(result) {
  return result.status === "ok";
}
