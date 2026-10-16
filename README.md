# pi-aws-assume

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Pi](https://github.com/earendil-works/pi) extension that uses [Granted](https://github.com/fwdcloudsec/granted) to run assistant commands with temporary AWS IAM Identity Center credentials. Each project allowlists existing profiles; the assistant asks for approval once per concrete profile per session.

> [!IMPORTANT]
> - **Opt-in per project.** `.pi/aws-assume.json` must define rules or select global rule IDs before role access, `aws_bash`, and guards become available. `assume_profile` remains visible for setup diagnostics without granting access.
> - **Separate shell tool.** Assumed credentials apply only to `aws_bash`. Plain `bash` is unchanged and keeps your ambient AWS credentials and profiles.
> - **Explicit use.** The assistant is instructed to use `aws_bash` only when the user or task clearly requires an allowed `/assume` profile; otherwise it uses plain `bash`.
> - **Not a credential sandbox.** The allowlist and approval do not restrict plain `bash` or other execution tools. Read the [known limitations](#known-limitations).

## Installation

Requirements:

- **[Granted CLI](https://github.com/fwdcloudsec/granted)** installed and on Pi's `PATH`, with your IAM Identity Center profiles already configured. Follow [Granted's setup guide](https://docs.granted.dev/getting-started) first; this extension does not install it or replace its authentication.
- **Interactive Pi 1.x, version 1.2.0 or newer.** See [Pi version compatibility](#pi-version-compatibility).
- **macOS.** Role access in this alpha does not support Linux or JSON, print, and RPC modes. Status diagnostics remain available wherever the extension loads.

In a project with a policy, startup checks for Granted without invoking it. If missing, the extension notifies once and role access stays unavailable; status diagnostics remain.

### Global installation

```bash
pi install git:github.com/datfinesoul/pi-aws-assume
```

Pi records the package in `~/.pi/agent/settings.json`.

### Project installation

```bash
pi install --local git:github.com/datfinesoul/pi-aws-assume
```

Pi records the package in `.pi/settings.json`.

Project packages load only after project trust. Run `/reload` or start a new session after installation.

Installation scope and [configuration](#configuration) are independent: either installation reads the trusted working project's policy and any global rules it selects. A global installation or rule library alone never enables role access.

> [!NOTE]
> Pi identifies a package by where it was installed from. Installing pi-aws-assume globally and for a project from the same source is fine: the project installation replaces the global one. Installing it from different locations, such as GitHub globally and a local checkout for a project, loads both copies, and Pi does not reconcile them.

<details>
<summary>Install from a local checkout</summary>

```bash
# Global installation
pi install /path/to/pi-aws-assume

# Project installation
pi install --local /path/to/pi-aws-assume

# Try from the checkout without changing settings
pi --no-extensions --extension ./extensions/aws-assume/index.ts
```

> When migrating from the project-local Assume MVP, disable that prototype before loading this package so the command and tools are not registered twice. Unlike the prototype, this package does not override `bash`; assumed credentials apply only to `aws_bash`. Manually migrate your policy from `.pi/assume.json` to `.pi/aws-assume.json` outside the assistant, converting each string entry to an `{ "id", "pattern" }` rule. The old path is not read, and no credentials or approvals are migrated.

</details>

## Usage

Create your project policy as described in [Configuration](#configuration), then `/reload`. Without project rules or selected global rules, `/assume status` explains why role access is unavailable and other `/assume` actions refuse.

| User command | Behavior |
|---|---|
| `/assume` | Choose from project-allowed profiles. |
| `/assume use <profile>` | Explicitly select an allowed profile, including names such as `status`. |
| `/assume <profile>` | Shorthand selection, except reserved command names. |
| `/assume list [offset]` | List up to 100 concrete matching names without authenticating; `nextOffset` gives the next page. |
| `/assume status` | Show active profile, policy rules, expiry, and the first 100 profile/approval names with total counts; no secrets. |
| `/assume cancel` | Cancel pending authentication and queued role work without clearing the previously active credentials or per-session approvals. |
| `/assume clear` | Clear active credentials and cancel pending authentication. Existing per-session approvals remain. |

For assistant-driven use, `assume_profile` selects the profile and `aws_bash` runs the commands. Both are model-only tools. `assume_profile` stays visible even without usable setup: `status` returns `available: false`, a reason, and safety guidance; all other actions refuse until prerequisites pass. `aws_bash` is exposed only when role access is enabled. Neither is callable through codemode scripts, because they can open approval or authentication dialogs.

`assume_profile` is a Pi extension tool, not a shell command, function, or alias. The assistant must not run `type`/`which` or search shell startup files to locate it. If the declaration is absent, report a Pi tool-loading/activation problem and ask the user to check loading and `/reload`; do not ask for a shell alias.

- `assume_profile` accepts an `action`: `list`, `status`, `assume`, `cancel`, or `clear`. `assume` requires a concrete `profile`, never a wildcard. `list` accepts an optional integer `offset` and returns up to 100 names, `totalProfiles`, and `nextOffset`. The picker and completions show all discovered matches.
- `aws_bash` takes the same input as `bash` and uses Pi's configured shell and command prefix. Without an active profile, it refuses to run rather than falling back to ambient credentials.

Approval is per concrete profile, not per wildcard: approving `example/team-a/readonly` does not approve `example/team-b/readonly`. Your own `/assume` selection counts as approval; switching back in the same session does not prompt again. A declined or failed switch preserves the previous active profile. Accepted approvals remain even if authentication fails.

**No automatic role activation.** Credentials and approvals are memory-only and reset on restart, `/reload`, `/new`, resume, fork, or shutdown. Neither session history nor Granted's cache restores them; you must select a profile again.

After the first successful assumption, a row above the editor shows the active profile and expiration in local time, such as `2026-10-15T19:40+9`. Clearing shows `AWS: none`; a session reset hides the row until the next successful assumption. Pi's footer is unchanged.

Successive `aws_bash` calls and their CLI/SDK subprocesses inherit the selected credentials. Plain `bash`, the launching terminal, Pi's model-provider environment, user `!`/`!!` commands, other extensions and execution tools, and MCP servers are unchanged.

## Configuration

| Layer | Location | Behavior |
|---|---|---|
| Bundled | `extensions/aws-assume/config.json` | Empty; no shipped allowlist. |
| Global | `~/.pi/agent/aws-assume.json` | Personal library of named rules; follows `PI_CODING_AGENT_DIR`. Applies to a project only by selected ID. |
| Project | `<project>/.pi/aws-assume.json` | Read from the working directory only after Pi grants project trust. Defines the project's own rules and selects global rule IDs. |

All files define `profiles` as `{ "id", "pattern" }` rules. A project's own rules always apply; global rules apply only when the project lists their IDs in `global`. Without selected IDs, the global file is not read. Bundled rules share the selectable library; a global rule with the same ID replaces a bundled one.

**Unlike the automatic configuration merging used by [other datfinesoul Pi extensions](https://github.com/datfinesoul?tab=repositories&q=topic%3Api-extension&type=&language=&sort=), this allowlist requires explicit project selection.** New global rule IDs never widen an existing project's access. The global file cannot opt projects in.

A missing or empty project policy disables role access, regardless of global rules, but does not hide status diagnostics or model-facing safety guidance. Policy loads at session start or `/reload`, not when files change. Invalid or unreadable participating files fail the whole policy closed, with a notice identifying the file's layer but not its contents. Undefined global IDs and conflicts between selected and project rule IDs are invalid.

The extension never writes policies, AWS profiles, or global Pi settings. Granted has its own side effects; see [Credentials and refresh](#credentials-and-refresh).

### Allow exact profiles

Create `.pi/aws-assume.json` **yourself outside the assistant**, using your existing profile names. For example:

```json
{
  "profiles": [{ "id": "readonly", "pattern": "example-readonly" }]
}
```

Never put credentials in the policy. If profile names are private, add `.pi/aws-assume.json` to your project's ignore rules yourself. The extension neither creates the policy nor edits ignore rules. Run `/reload` after changes.

### Allow a group of profiles

Exact names and slash-aware glob patterns can be mixed:

```json
{
  "profiles": [
    { "id": "team-readonly", "pattern": "example/*/readonly" },
    { "id": "audit", "pattern": "example/**/audit" },
    { "id": "readonly", "pattern": "example-readonly" }
  ]
}
```

Matching is case-sensitive and covers the whole profile name. `/` is a delimiter, not a filesystem path to normalize. `*` matches zero or more characters within one segment; `?` matches exactly one character within one segment; `**` must occupy a whole segment and spans complete segments. Intermediate `**` can span zero segments, while a trailing `/**` requires at least one descendant segment and does not include the bare prefix. Dots have no special hidden-file behavior.

| Rule | Examples |
|---|---|
| `example/*` | Matches `example/team`, not `example/team/readonly`. |
| `example/*/readonly` | Matches `example/team/readonly`, not `example/org/team/readonly`. |
| `example/**` | Matches `example/team` and `example/org/team/readonly`, not bare `example` or `other/example/team`. |
| `example/**/readonly` | Matches `example/readonly`, `example/team/readonly`, and `example/org/team/readonly`. |
| `example/team-?/readonly` | Matches `example/team-a/readonly`, not `example/team-ab/readonly`. |

### Use global rules in a project

Create your personal rules yourself in `~/.pi/agent/aws-assume.json` (or under `PI_CODING_AGENT_DIR`):

```json
{
  "profiles": [
    { "id": "readonly", "pattern": "example/**/readonly" },
    { "id": "audit", "pattern": "example/**/audit" }
  ]
}
```

Then select the rules a trusted project uses in its `.pi/aws-assume.json`, optionally alongside its own rules:

```json
{
  "global": ["readonly"],
  "profiles": [{ "id": "team-admin", "pattern": "example/team/admin" }]
}
```

This project allows profiles matching `example/**/readonly` and `example/team/admin`, but imports neither `audit` nor future global rule IDs. Selection makes profiles eligible, not approved or assumed.

### Change or remove access

Edit or remove entries yourself outside the assistant, then `/reload` to apply changes and clear the active role and approvals. Changing a global rule's pattern affects every project that selects its ID. To deactivate a project, remove its rules and `global` IDs, or delete its policy file. No extension command or tool edits the allowlist or AWS profiles.

### Field reference

| Field | Type | Rules |
|---|---|---|
| `global` | Array of strings, optional; project file only | Global rule IDs the project uses. Defaults to none. At most 100 unique IDs, each defined in the global or bundled file and not reused by a project rule. |
| `profiles` | Array of rule objects, optional | At most 100 rules with unique IDs per file. The project's own and selected rules total at most 100. |
| `profiles[].id` | String, required | Stable ID, at most 128 characters, using concrete profile-name syntax. |
| `profiles[].pattern` | String, required | Exact profile name or path-style glob, at most 128 characters. |

Unknown fields, other value types, and invalid rules fail the whole policy closed. Regexes, bracket classes, braces, negation, escaping, empty slash segments, and embedded globstars such as `dev**` are not supported. Concrete profile names start with an ASCII letter or digit, contain only ASCII letters, digits, `_`, `.`, `@`, `/`, `+`, `:`, `=`, or `-`, and have no empty slash-delimited segments.

## How it works

### Assumptions and design choices

- **Project opt-in.** A trusted project must define or select rules in `.pi/aws-assume.json`. Global installation alone grants no access through the extension.
- **Separate credential scope.** Only `aws_bash` receives the selected temporary credentials, after inherited AWS identity variables are removed. Plain `bash` retains ambient credentials and access to other host credential sources.
- **Awareness without authorization.** Status diagnostics and a model-facing context reminder remain available when role access is disabled. If a task requires an assumed profile but setup or authentication is unavailable, the assistant must stop and report the blocker, not fall back to ambient credentials, search credential stores, invoke AWS/Granted directly to obtain credentials, or edit AWS policy/profile files. The user handles setup outside Pi and runs `/reload`. Unrelated tasks may still use plain `bash` with its ambient environment. This guidance is not technical enforcement.
- **Region order in `aws_bash`.** An inherited `AWS_REGION`, then an inherited `AWS_DEFAULT_REGION`, then the selected profile's `region` in your AWS config file, then `us-east-1`. A CLI `--region` or explicit SDK region still wins. An inherited region therefore applies to every selected profile.
- **Memory-only state.** The extension never persists credentials or approvals and never automatically reactivates a role. Granted's own cache is separate.
- **macOS, Granted, interactive mode.** Other platforms, credential tools, and non-interactive modes are out of scope for this alpha.
- **Not a sandbox.** See [Known limitations](#known-limitations).

### Pi version compatibility

Pi does not check extension compatibility when updating packages, so the extension checks the running Pi version at session start:

| Running Pi | Behavior |
|---|---|
| Older than 1.2.0 | Role access unavailable, with a notice. |
| Any 1.x version from 1.2.0 | Role access available, without a version notice. |
| A different major version, or an unknown version | Role access unavailable, with a notice, until pi-aws-assume is updated. |

To control when the extension updates, install a pinned tag or npm version instead of the default branch.

### Components

The extension registers `/assume`, model-only AWS tools, session hooks, the status widget, and best-effort tool-call guards. `aws_bash` reuses Pi's bash implementation. A model-facing AWS context reminder is added before the next agent run when availability or the active profile changes, including when setup is missing; session shutdown or replacement clears role state.

### Profile discovery

For glob rules, discovery reads profile section names from `~/.aws/config` and `~/.aws/credentials` (or `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE`) at session start/reload. It excludes SSO-session/service sections, retains valid names, and sorts and deduplicates matches for the picker, completions, and list tool. Limits are 2 MiB per file and 10,000 distinct names. Discovery never returns or logs credential values, runs credential processes, or invokes AWS or Granted.

Exact-name rules remain listed even if discovery misses them; Granted validates them on selection. Discovery failures warn and omit wildcard expansion. The listing is a snapshot: an explicitly supplied concrete name is eligible if it matches a rule, even when not listed. New matches still require approval. `/reload` refreshes discovery and resets credentials and approvals. Wildcard strings can never be selected or passed to Granted.

### Credentials and refresh

The extension invokes `granted credential-process --profile <name> --window 5m --auto-login` directly, without shell interpolation or the `assume` shell alias. Granted manages its configuration, keychain/cache, and SSO browser login, and may write logs, cache, and browser-integration files. Its `credential-process` also invokes profile-registry auto-sync, so configured registries can update AWS profiles. The extension does not disable this or change Granted settings. If profile files must remain immutable, review Granted's registry configuration outside Pi before use.

Credential output is privately captured and validated, with a 64 KiB stdout limit. Raw stdout/stderr never reaches tool results, notifications, errors, or session entries. Errors are deliberately generic; diagnose Granted outside Pi.

When SSO is needed, Granted opens the browser after approval/selection. A progress screen shows a spinner and countdown during selection or refresh. Press Escape (or your dialog-cancel key) to abort without clearing the previous role. Authentication times out after one minute; the screen closes independently of credential-fetch completion. Tool abort, session reset, and shutdown also cancel the subprocess. `/assume cancel` preserves active credentials; `/assume clear` discards them. Browser fallback URLs and device codes are withheld with Granted's diagnostics: if the browser cannot open, authenticate outside Pi and retry.

Only temporary credentials with a session token and a future expiration are accepted. They are reused in memory and refreshed on demand before the next `aws_bash` command within five minutes of expiry. No background refresh timers run, and no refresh occurs without an explicitly active role. Concurrent refresh/selection requests are serialized. Reset/clear invalidates pending work so late results cannot restore credentials.

`aws_bash` commands receive a fresh environment copy with inherited AWS credential/profile/web-identity/container-credential variables, custom AWS config/credential path variables, and `GRANTED_*` session variables removed. Operational `AWS_REGION` and `AWS_DEFAULT_REGION` follow the [region order](#assumptions-and-design-choices); the profile's region is read from the AWS config file at selection, keeping only that value. Granted still uses the profile's configured **SSO authentication region**, which is separate from the operational region.

Failed refresh prevents the pending shell command from executing with stale credentials. Each launched command receives a credential snapshot. Switching or clearing does not revoke that snapshot or change already-running/background processes, and a long-running process can outlive its credentials.

### Known limitations

- **Plain `bash` is unrestricted by design.** It can use your ambient AWS credentials and any profile, run Granted, read AWS files, or edit `.pi/aws-assume.json`. Policy edits only take effect after your `/reload`, and new profiles still need approval, but review policy changes you did not make.
- The extension denies non-allowlisted names before asking approval or invoking Granted. In `aws_bash`, explicit `--profile` and `AWS_PROFILE`/`AWS_DEFAULT_PROFILE` assignments are rejected in common shell forms, even for allowed names: select through `assume_profile` and omit profile flags.
- In `aws_bash`, common `assume`/`assumego`/`granted` command invocations, `aws configure`, `aws sso login`/`logout`, literal references to credential/policy paths (absolute, `~/`, `$HOME/`, or `${HOME}/` spellings), and any mention of the `aws-assume.json` policy file name are rejected. Plain `bash` is never checked.
- In projects with an active policy, built-in file reads under `~/.aws`/`~/.granted` and configured AWS file paths are blocked, and built-in writes/edits to these stores or the project/global `aws-assume.json` policies are blocked, including symlink aliases.
- These checks are **not a shell parser, permission sandbox, or complete data-loss-prevention system**. Variables, encoded commands, aliases, indirect SDK calls, alternate credential locations, custom tools, file scanning from an ancestor directory, OS keychain access, or modifying extension code can bypass them. Host AWS default files and metadata endpoints are not made inaccessible merely by stripping environment variables. Do not promise that arbitrary assistant-run programs cannot access broader host credentials.
- Credentials supplied to an `aws_bash` program are accessible to that program. It can print or exfiltrate them; generic shell output is not secretly filtered. Keeping credential-fetch output private does not guarantee that credentials can never appear in a transcript.
- Profile names are allowlisted, not pinned AWS account/role identities. User-side changes to AWS configuration or Granted caches can affect what a name resolves to. No AWS identity verification call is made.
- Direct `aws sts assume-role` calls remain governed by AWS permissions, **without extension destination allowlisting or first-use approval**, by design. This extension does not offer a chaining interface and does not adopt credentials obtained by those calls.
- `aws_bash` runs commands locally through Pi's bash implementation. Other execution tools and remote backends are not covered.
- No AWS web-console sessions, profile CRUD, standalone SSO implementation, or isolation dependency are included. Actual AWS/SSO authentication has not been exercised by automated tests.

Use OS isolation/protected credential handling later if stronger guarantees become necessary. Restrict AWS permissions independently of this extension. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Development

No build step or runtime npm dependencies beyond Pi. [Granted](https://github.com/fwdcloudsec/granted) is an external runtime requirement. Pure helpers live in `src/*.js`, Pi wiring in `extensions/aws-assume/index.ts`, and tests use Node's built-in runner.

```bash
npm test
npm run pack:check
# Or:
pnpm test
pnpm run pack:check
```

For an installed-Pi loader/command/tool smoke test, point `PI_CODING_AGENT_ENTRY` at the installed package's `dist/index.js`:

```bash
PI_CODING_AGENT_ENTRY=/path/to/pi-coding-agent/dist/index.js npm test
```

Without this variable, installed-Pi tests are skipped. Interactive integration tests target Pi 1.2.0 on macOS and do not yet run in CI; run them locally before a release. Authentication tests use fake Granted executables and credentials in temporary directories—no model requests, real AWS credentials, or role assumptions. Live Granted authentication remains a user-run smoke test; the prototype was developed with Granted 0.38.0.

Every pull request that triggers CI must bump `version` in `package.json` and move the `Unreleased` changelog entries under a matching `## [<version>] - <date>` heading; CI fails otherwise. Pull requests that change only Markdown skipped by CI are exempt. After the merge to `main` passes CI, the Release workflow tags that commit `v<version>`. Merges that do not change the version are not tagged.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull-request guidance.

## License

[MIT](LICENSE) © Philip Hadviger.
