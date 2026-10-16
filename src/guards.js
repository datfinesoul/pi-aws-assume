import { realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const POLICY_FILE = "aws-assume.json";
// Protected files are user-edited only. Guide the assistant to hand the change to the user instead of a bare refusal.
const USER_EDIT = "the extension requires the user to make the change themselves; do not retry with another tool. " +
  'Tell the user: "The extension requires you to make this change yourself in <file>:" followed by ' +
  "the complete intended file content (or the exact lines to change) as a code snippet, then ask them to run /reload. " +
  "Never include credentials or secrets in the snippet.";
const userEditGuidance = (path) => `assume: ${path} is protected from assistant edits; ${USER_EDIT.replace("<file>", path)}`;

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
  // Also match home-relative spellings of every protected path, e.g. ~/x, $HOME/x, ${HOME}/x.
  const sensitive = readOnly.flatMap((path) => {
    const rel = relative(resolve(home), path);
    return rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel) ? [path, `~/${rel}`, `$HOME/${rel}`, `\${HOME}/${rel}`] : [path];
  });
  const within = (path, root) => {
    const rel = relative(root, path);
    return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  };
  const matches = (path, roots) => roots.some((root) => within(path, root) || within(canonical(path), canonical(root)));

  function file(tool, path) {
    if (typeof path !== "string") return;
    const absolute = expand(path);
    if (["write", "edit"].includes(tool) && matches(absolute, readOnly)) {
      return userEditGuidance(absolute);
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
    // Match .aws/.granted only as a whole path segment, not names such as .aws-sdk.
    // The policy file name is blocked in any form, so relative, ~/, $HOME, and
    // $PI_CODING_AGENT_DIR references to project or global policy are all covered.
    if (/(?:~\/|\$HOME\/|\$\{HOME\}\/|\/)\.(?:aws|granted)(?=[/\s'";|&)]|$)/m.test(command) ||
        sensitive.some((path) => command.includes(path)) || command.includes(POLICY_FILE) ||
        /\bAWS_(?:CONFIG_FILE|SHARED_CREDENTIALS_FILE)\s*=/.test(command)) {
      if (command.includes(POLICY_FILE) || policies.some((path) => command.includes(path))) {
        return "assume: aws_bash cannot access AWS Assume policy files. To inspect a policy, use the read tool. " +
          `To change one, ${USER_EDIT.replace("<file>", policies.join(" or ") || POLICY_FILE)} Name only the file that applies.`;
      }
      return "assume: direct shell access to profile/policy/credential-store paths is blocked (best-effort guard).";
    }
  }

  return { file, shell };
}
