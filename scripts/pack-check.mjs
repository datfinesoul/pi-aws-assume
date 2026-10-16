#!/usr/bin/env node
// Run `pack --dry-run` with the package manager that invoked this script, so
// both npm and pnpm are supported. Add other package managers here as needed.
import { spawnSync } from "node:child_process";

const userAgent = process.env.npm_config_user_agent ?? "";
const manager = userAgent.startsWith("pnpm/") ? "pnpm" : "npm";
const result = spawnSync(manager, ["pack", "--dry-run"], { stdio: "inherit" });

if (result.error) {
  console.error(`pack:check could not run '${manager}': ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
