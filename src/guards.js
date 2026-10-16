import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

function canonical(path) {
  // Resolve existing ancestors as well, so a symlink + a not-yet-created file is covered.
  try { return realpathSync(path); }
  catch {
    const parent = dirname(path);
    return parent === path ? path : join(canonical(parent), path.slice(parent.length).replace(/^[/\\]+/, ""));
  }
}

export function createGuards({ cwd, home, policyPath, additionalPolicyPaths = [], env = process.env }) {
  const expand = (path) => resolve(cwd, path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path);
  const stores = [join(home, ".aws"), join(home, ".granted"),
    env.AWS_CONFIG_FILE, env.AWS_SHARED_CREDENTIALS_FILE].filter(Boolean).map(expand);
  const policies = [policyPath, ...additionalPolicyPaths].filter(Boolean).map(expand);
  const readOnly = [...policies, ...stores];
  const within = (path, root) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  };
  const matches = (path, roots) => roots.some((root) => within(path, root) || within(canonical(path), canonical(root)));

  function file(tool, path) {
    if (typeof path !== "string") return;
    const absolute = expand(path);
    if (["write", "edit"].includes(tool) && matches(absolute, readOnly)) {
      return "assume: profile/policy files are read-only to assistant tools. Edit them yourself outside Pi, then /reload.";
    }
    if (["read", "grep", "find", "ls"].includes(tool) && matches(absolute, stores)) {
      return "assume: direct access to AWS/Granted credential stores is blocked. Use assume_profile instead.";
    }
  }

  // Applied only to the AWS shell tool, never to plain bash. Intentionally conservative checks
  // for common bypasses, NOT a shell parser or sandbox.
  function shell(command) {
    // Granted/assume as a command word (start of a command or after ; & | ( or $( ), optionally
    // quoted, path-qualified, or behind a common command wrapper.
    if (/(?:^|[;&|(\n`]|\$\()\s*(?:(?:exec|env|command|sudo|nohup|time|xargs)\s+)*["']?(?:[^\s;&|()'"]*\/)?(?:assume|assumego|granted)(?=[\s;)&|'"`]|$)/m.test(command)) {
      return "assume: run profile selection/authentication through assume_profile, not Granted shell commands.";
    }
    if (/(?:^|[\s;&|(/])aws\s+(?:configure\b|sso\s+(?:login|logout)\b)/m.test(command)) {
      return "assume: AWS profile configuration/direct SSO commands are blocked. Manage configuration outside Pi; authenticate through assume_profile.";
    }
    if (/(?:^|\s)--profile(?:[=\s]|$)|\bAWS_(?:DEFAULT_)?PROFILE\s*=/.test(command)) {
      return "assume: aws_bash uses the selected profile; omit --profile and AWS_PROFILE. Select another profile through assume_profile.";
    }
    const sensitive = [...stores, ...policies];
    // Match .aws/.granted only as a whole path segment, not names such as .aws-sdk.
    if (/(?:~\/|\$HOME\/|\$\{HOME\}\/|\/)\.(?:aws|granted)(?=[/\s'";|&)]|$)/m.test(command) ||
        sensitive.some((path) => command.includes(path)) || command.includes(".pi/aws-assume.json") ||
        /\bAWS_(?:CONFIG_FILE|SHARED_CREDENTIALS_FILE)\s*=/.test(command)) {
      return "assume: direct shell access to profile/policy/credential-store paths is blocked (best-effort guard).";
    }
  }

  return { file, shell };
}
