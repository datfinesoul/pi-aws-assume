// Windows environment names are case-insensitive. Use one canonical spelling before
// reading or sanitizing them, including plain objects supplied by Pi's shell runner.
export function normalizeEnvironment(base, platform = process.platform) {
  if (platform !== "win32") return { ...base };
  const env = {};
  for (const key of Object.keys(base).sort()) env[key.toUpperCase()] = base[key];
  return env;
}
