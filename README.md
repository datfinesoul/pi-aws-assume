# pi-aws-assume

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Pi](https://github.com/earendil-works/pi) extension that runs assistant commands with temporary AWS IAM Identity Center credentials through [Granted](https://github.com/fwdcloudsec/granted). Each project defines which existing profiles it allows. By default, the assistant requests approval once for each concrete profile per session. Individual rules can enable automatic approval.

> [!IMPORTANT]
> - **Each project must enable access.** Define rules or select global rule IDs in `.pi/aws-assume.json` to enable role access and `aws_bash`. Some guards also require this policy. Policy-file write/edit guards apply whenever the extension loads. `assume_profile` remains visible for setup diagnostics but grants no access by itself.
> - **Separate shell tool.** Only `aws_bash` receives assumed credentials. Plain `bash` keeps the ambient AWS environment.
> - **Explicit use.** The assistant uses `aws_bash` only when the user or task clearly requires an allowed `/assume` profile. Otherwise, it uses plain `bash`.
> - **Not a credential sandbox.** The allowlist and approval do not restrict plain `bash` or other execution tools. See [Known limitations](#known-limitations).

## Installation

Requirements:

- **[Granted CLI](https://github.com/fwdcloudsec/granted)** must be installed and available on Pi's `PATH`. Configure your IAM Identity Center profiles first. Follow [Granted's setup guide](https://docs.granted.dev/getting-started). This extension does not install Granted or replace its authentication.
- **Interactive Pi 1.x, version 1.2.0 or newer.** See [Pi version compatibility](#pi-version-compatibility).
- **macOS or Linux.** Role access requires interactive mode. JSON, print, and RPC modes are unsupported. Status diagnostics remain available wherever the extension loads. Linux support is newer and less widely tested than macOS support.

In a project with a policy, the extension checks for Granted at startup without running it. If Granted is missing, the extension sends one notification. Role access remains unavailable, but status diagnostics remain available.

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

Project packages load only after Pi grants project trust. Run `/reload` or start a new session after installation. After an extension code update, fully restart Pi if AWS Assume reports cached helpers from an older version. `/reload` can retain imported JavaScript helpers.

Installation scope and [configuration](#configuration) are independent. Either installation reads the trusted working project's policy and the global rules that the policy selects. A global installation or rule library alone never enables role access.

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

> Disable the project-local Assume MVP before loading this package during migration. Otherwise, both copies register the command and tools. Unlike the prototype, this package does not override `bash`. Only `aws_bash` receives assumed credentials.
>
> Manually migrate your policy from `.pi/assume.json` to `.pi/aws-assume.json` outside the assistant. Convert each string entry to an `{ "id", "pattern" }` rule. The extension does not read the old path. It migrates no credentials or approvals.

</details>

## Usage

1. Create your project policy as described in [Configuration](#configuration).
2. Run `/reload`.

Without project rules or selected global rules, `/assume status` explains why role access is unavailable. Other `/assume` actions refuse to run.

| User command | Behavior |
|---|---|
| `/assume` | Choose from profiles that the project allows. |
| `/assume use <profile>` | Explicitly select an allowed profile, including names such as `status`. |
| `/assume <profile>` | Select an allowed profile with shorthand syntax, except reserved command names. |
| `/assume list [offset]` | List up to 100 concrete matching names without authentication. `nextOffset` identifies the next page. |
| `/assume status` | Show the active profile, policy rules, expiry, and first 100 profile/approval names with total counts. Show no secrets. |
| `/assume cancel` | Cancel pending authentication and queued role work. Preserve the previously active credentials and per-session approvals. |
| `/assume clear` | Clear active credentials. Cancel pending authentication. Preserve existing per-session approvals. |

For assistant-driven use, `assume_profile` selects the profile and `aws_bash` runs commands. Both tools are available only to the model. Neither tool is available through codemode scripts because either can open approval or authentication dialogs.

`assume_profile` remains visible without usable setup. Its `status` action returns `available: false`, a reason, and safety guidance. All other actions refuse to run until prerequisites pass. The extension exposes `aws_bash` only when role access is enabled.

`assume_profile` is a Pi extension tool, not a shell command, function, or alias. The assistant must not use `type` or `which` to locate it. It must not search shell startup files. If the tool declaration is absent, report a Pi tool-loading or activation problem. Ask the user to check extension loading and run `/reload`. Do not ask for a shell alias.

- `assume_profile` accepts an `action`: `list`, `status`, `assume`, `cancel`, or `clear`.
- `assume` requires a concrete `profile`, never a wildcard.
- `list` accepts an optional integer `offset`. It returns up to 100 names, `totalProfiles`, and `nextOffset`. The picker and completions show all discovered matches.
- `aws_bash` accepts the same input as `bash`. It uses Pi's configured shell and command prefix. Without an active profile, it refuses to run. It never substitutes ambient credentials.

Unless matching rules enable automatic approval, approval applies to each concrete profile, not each wildcard. See [Automatically approve matching profiles](#automatically-approve-matching-profiles). Approval for `example/team-a/readonly` does not approve `example/team-b/readonly`. Your own `/assume` selection counts as approval. Selecting a previously approved profile again in the same session does not prompt again.

A declined or failed switch preserves the previous active profile. Accepted approvals remain even if authentication fails.

**No automatic role activation.** Credentials and approvals exist only in memory. They reset on restart, `/reload`, `/new`, resume, fork, or shutdown. Neither session history nor Granted's cache restores them. You must select a profile again.

After the first successful assumption, a row above the editor shows the active profile and expiration in local time. For example, it can show `2026-10-15T19:40+9`. Clearing the profile shows `AWS: none`. A session reset hides the row until the next successful assumption. Pi's footer does not change.

Successive `aws_bash` calls and their CLI/SDK subprocesses receive the selected credentials. The extension does not change these environments or tools:

- Plain `bash`.
- The launching terminal.
- Pi's model-provider environment.
- User `!`/`!!` commands.
- Other extensions and execution tools.
- MCP servers.

## Configuration

| Layer | Location | Behavior |
|---|---|---|
| Bundled | `extensions/aws-assume/config.json` | Supplies no allowlist. The authentication timeout defaults to 60 seconds. |
| Global | `~/.pi/agent/aws-assume.json` | Supplies a personal timeout default and library of named rules. Follows `PI_CODING_AGENT_DIR`. Rules apply only by selected ID. |
| Project | `<project>/.pi/aws-assume.json` | Loads from the working directory only after Pi grants project trust. Overrides the timeout. Defines project rules and selects global rule IDs. |

All files define `profiles` as rules. Each rule requires `id` and `pattern`. The `autoApprove` field is optional. An omitted `autoApprove` means no opinion. Without a matching `true` rule, the profile requires confirmation.

A project's own rules always apply. Global rules, including their automatic-approval settings, apply only when the project lists their IDs in `global`. Bundled rules belong to the same selectable library. A global rule with the same ID replaces the entire bundled rule.

The optional `timeoutSeconds` setting merges independently of rule selection. Its precedence is project → global → bundled → 60 seconds. A project with rules or selected IDs always reads the global file for settings. This never imports unselected rules.

An invalid or unreadable global `aws-assume.json` disables role access in every project with rules or selected IDs. This also affects projects that select no global rules. This behavior is deliberate. Fix the global file outside Pi. Then run `/reload`.

**This allowlist requires explicit project selection, unlike automatic configuration merging in [other datfinesoul Pi extensions](https://github.com/datfinesoul?tab=repositories&q=topic%3Api-extension&type=&language=&sort=).** New global rule IDs never widen an existing project's access. The global file cannot enable access for projects.

A missing project policy disables role access regardless of global rules. A project policy with only settings, but no rules or selected IDs, also disables role access. Status diagnostics and model-facing safety guidance remain visible.

The policy loads at session start or `/reload`, not when files change. Invalid or unreadable participating files disable the whole policy. A notice identifies the file's layer but not its contents. Undefined global IDs are invalid. Conflicts between selected rule IDs and project rule IDs are also invalid.

The extension never writes policies, AWS profiles, or global Pi settings. Granted can write files as part of its own operation. See [Credentials and refresh](#credentials-and-refresh).

### Allow exact profiles

Create `.pi/aws-assume.json` **yourself outside the assistant**, with your existing profile names. For example:

```json
{
  "profiles": [{ "id": "readonly", "pattern": "example-readonly" }]
}
```

Never put credentials in the policy. If profile names are private, add `.pi/aws-assume.json` to your project's ignore rules yourself. The extension does not create the policy or edit ignore rules. Run `/reload` after changes.

### Allow a group of profiles

You can combine exact names and slash-aware glob patterns:

```json
{
  "profiles": [
    { "id": "team-readonly", "pattern": "example/*/readonly" },
    { "id": "audit", "pattern": "example/**/audit" },
    { "id": "readonly", "pattern": "example-readonly" }
  ]
}
```

Matching is case-sensitive and covers the whole profile name. `/` is a delimiter, not a filesystem path to normalize. Dots have no special hidden-file behavior.

- `*` matches zero or more characters within one segment.
- `?` matches exactly one character within one segment.
- `**` must occupy a whole segment and spans complete segments.
- Intermediate `**` can span zero segments.
- A trailing `/**` requires at least one descendant segment. It does not include the bare prefix.

| Rule | Examples |
|---|---|
| `example/*` | Matches `example/team`, but not `example/team/readonly`. |
| `example/*/readonly` | Matches `example/team/readonly`, but not `example/org/team/readonly`. |
| `example/**` | Matches `example/team` and `example/org/team/readonly`. Does not match bare `example` or `other/example/team`. |
| `example/**/readonly` | Matches `example/readonly`, `example/team/readonly`, and `example/org/team/readonly`. |
| `example/team-?/readonly` | Matches `example/team-a/readonly`, but not `example/team-ab/readonly`. |

### Use global rules in a project

Create your personal rules yourself in `~/.pi/agent/aws-assume.json`, or under `PI_CODING_AGENT_DIR`:

```json
{
  "profiles": [
    { "id": "readonly", "pattern": "example/**/readonly" },
    { "id": "audit", "pattern": "example/**/audit" }
  ]
}
```

Select the rules that a trusted project uses in its `.pi/aws-assume.json`. You can also define project rules:

```json
{
  "global": ["readonly"],
  "profiles": [{ "id": "team-admin", "pattern": "example/team/admin" }]
}
```

This project allows profiles matching `example/**/readonly` and `example/team/admin`. It imports neither `audit` nor future global rule IDs. Selection makes profiles eligible. It does not assume them. Approval remains necessary unless matching rules enable automatic approval. See [Automatically approve matching profiles](#automatically-approve-matching-profiles).

### Customize the authentication timeout

Set an optional global default in `~/.pi/agent/aws-assume.json`, or under `PI_CODING_AGENT_DIR`. The file can also contain global rules:

```json
{
  "timeoutSeconds": 120
}
```

A project's `.pi/aws-assume.json` can override this value independently of global rule selection:

```json
{
  "timeoutSeconds": 180,
  "profiles": [{ "id": "readonly", "pattern": "example/**/readonly" }]
}
```

If the project omits the setting, it inherits the global value. If both omit it, the timeout is 60 seconds. The timeout covers each Granted credential fetch, including browser authentication and refresh on demand. It controls both the progress-screen countdown and subprocess deadline. It does not change `aws_bash` command timeouts. Settings alone never enable role access.

### Automatically approve matching profiles

Add `autoApprove: true` to an individual project rule or a global rule that the project explicitly selects:

```json
{
  "profiles": [
    { "id": "readonly", "pattern": "example/*/readonly", "autoApprove": true },
    { "id": "admin", "pattern": "example/*/admin" }
  ]
}
```

The assistant can select matching readonly profiles without a confirmation dialog. Admin profiles still require first-use approval for each concrete name.

When rules overlap, **the project decides first**. Rule order does not matter:

1. Matching project rules that set `autoApprove` decide. Any explicit `false` requires confirmation. Otherwise, these rules automatically approve the profile.
2. Selected global rules decide only if no matching project rule sets `autoApprove`. Any explicit `false` requires confirmation. Otherwise, matching global rules that set `autoApprove` to `true` automatically approve the profile.
3. If neither layer decides, confirmation is required.

An omitted `autoApprove` means no opinion. Thus, a broad project rule such as `example/**` does not cancel a selected global rule's automatic approval. To require confirmation instead, add a project rule with `autoApprove: false`. Explicit `false` can only add confirmation, never remove it.

These rules also apply to explicitly supplied names that discovery did not list. Unselected global rules never grant access or automatic approval.

Automatic approval is never silent. At session start, a warning lists every effective `autoApprove: true` rule by ID, pattern, and layer. Each automatic approval of an assistant-selected profile produces a notice that names the profile. If you did not configure these rules, review the policy files outside Pi before continuing.

Automatic approval skips only the extension's profile confirmation. It does not skip authentication, keychain, or browser interaction. It never activates a role at startup or after a reset. The assistant must still explicitly select a concrete allowed profile. Run `/reload` after editing configuration yourself outside the assistant.

### Change or remove access

1. Edit or remove entries yourself outside the assistant.
2. Run `/reload` to apply changes and clear the active role and approvals.

Changing a global rule's pattern affects every project that selects its ID. To deactivate a project, remove its rules and `global` IDs, or delete its policy file. No extension command or tool edits the allowlist or AWS profiles.

### Field reference

| Field | Type | Rules |
|---|---|---|
| `global` | Array of strings, optional. Project file only. | Selects global rule IDs. Defaults to none. Allows at most 100 unique IDs. Each ID must exist in the global or bundled file. Project rules must not reuse these IDs. |
| `profiles` | Array of rule objects, optional. | Allows at most 100 rules with unique IDs per file. Project rules and selected rules together must total at most 100. |
| `profiles[].id` | String, required. | Stable ID with at most 128 characters. Uses concrete profile-name syntax. |
| `profiles[].pattern` | String, required. | Exact profile name or path-style glob with at most 128 characters. |
| `profiles[].autoApprove` | Boolean, optional. | An omitted value means no opinion. `true` skips confirmation for matching concrete profiles. `false` requires confirmation. Project rules that set it override selected global/bundled rules. Within a layer, `false` wins. |
| `timeoutSeconds` | Integer, optional. | Authentication/refresh timeout in seconds, from 1 to 2147483, Node's timer limit. Project overrides global, then bundled. Defaults to `60`. |

Unknown fields, other value types, and invalid rules disable the whole policy.

Patterns do not support these forms:

- Regexes.
- Bracket classes.
- Braces.
- Negation.
- Escaping.
- Empty slash segments.
- Embedded globstars such as `dev**`.

Concrete profile names must start with an ASCII letter or digit. They can contain only ASCII letters, digits, `_`, `.`, `@`, `/`, `+`, `:`, `=`, or `-`. They must not contain empty slash-delimited segments.

## How it works

### Assumptions and design choices

- **Project-controlled access.** A trusted project must define or select rules in `.pi/aws-assume.json`. Global installation alone grants no access through the extension.
- **Separate credential scope.** Only `aws_bash` receives selected temporary credentials. The extension first removes inherited AWS identity variables from that tool's environment. Plain `bash` retains ambient credentials and access to other host credential sources.
- **Awareness without authorization.** Status diagnostics and a model-facing context reminder remain available when role access is disabled. If a task requires an assumed profile but setup or authentication is unavailable, the assistant must stop and report the blocker. It must not substitute ambient credentials, search credential stores, obtain credentials directly through AWS/Granted, or edit AWS policy/profile files. The user manages setup outside Pi, then runs `/reload`. Tasks that do not require an assumed profile can still use plain `bash` with its ambient environment. This guidance is not technical enforcement.
- **Region selection.** Granted authentication and `aws_bash` use inherited `AWS_REGION`, then inherited `AWS_DEFAULT_REGION`, then the selected profile's AWS config `region`, then `us-east-1`. If inherited and configured regions cross the China/non-China partition boundary, the profile region takes precedence. This supports `cn-north-1` and `cn-northwest-1` without an inherited commercial region redirecting requests. It also protects commercial profiles from an inherited China region. Configure the operational `region` on China profiles instead of relying on the commercial fallback. A CLI `--region` or explicit SDK region still wins.
- **Memory-only state.** The extension never persists credentials or approvals. It never automatically reactivates a role. Granted's own cache is separate.
- **macOS/Linux, Granted, interactive mode.** This alpha does not support other platforms, credential tools, or non-interactive modes for role access.
- **Not a sandbox.** See [Known limitations](#known-limitations).

### Pi version compatibility

Pi does not check extension compatibility when updating packages. This extension checks the running Pi version at session start:

| Running Pi | Behavior |
|---|---|
| Older than 1.2.0 | Role access is unavailable. The extension sends a notice. |
| Any 1.x version from 1.2.0 | Role access is available without a version notice. |
| A different major version, or an unknown version | Role access remains unavailable until pi-aws-assume is updated. The extension sends a notice. |

To control when the extension updates, install a pinned tag or npm version instead of the default branch.

### Components

The extension registers `/assume`, model-only AWS tools, session hooks, a status widget, and best-effort tool-call guards. `aws_bash` reuses Pi's bash implementation.

When availability or the active profile changes, the extension adds an AWS context reminder before the next agent run. This includes reminders when setup is missing. Session shutdown or replacement clears role state.

### Profile discovery

For glob rules, discovery reads profile section names from AWS files at session start or `/reload`. The default files are `~/.aws/config` and `~/.aws/credentials`. `AWS_CONFIG_FILE` and `AWS_SHARED_CREDENTIALS_FILE` can select other paths.

Discovery performs these operations:

- Excludes SSO-session and service sections.
- Retains valid names.
- Sorts matching names.
- Removes duplicates.
- Supplies the names to the picker, completions, and list tool.

Limits are 2 MiB per file and 10,000 distinct names. Discovery never returns or logs credential values. It never runs credential processes or invokes AWS or Granted.

Exact-name rules remain listed even if discovery misses them. Granted validates these names on selection. Discovery failures produce warnings and omit wildcard expansion.

The listing is a snapshot. An explicitly supplied concrete name remains eligible if it matches a rule, even when discovery did not list it. New matches still require approval unless a matching rule enables automatic approval. `/reload` refreshes discovery and resets credentials and approvals. The extension never selects wildcard strings or passes them to Granted.

### Credentials and refresh

The extension directly invokes `granted credential-process --profile <name> --window 5m --auto-login`. It uses neither shell interpolation nor the `assume` shell alias. Granted manages its configuration, keychain/cache, and SSO browser login. It may write logs, cache files, and browser-integration files.

Granted's `credential-process` also invokes profile-registry auto-sync. Configured registries can therefore update AWS profiles. The extension does not disable this behavior or change Granted settings. If profile files must remain immutable, review Granted's registry configuration outside Pi before use.

The extension privately captures and validates credential output. It limits stdout to 64 KiB. Raw stdout/stderr never reaches tool results, notifications, errors, or session entries. Errors are deliberately generic. Diagnose Granted outside Pi.

When SSO is necessary, Granted opens the browser after approval or selection. A progress screen shows a spinner and countdown during selection or refresh. Press Escape, or your dialog-cancel key, to abort without clearing the previous role.

Authentication times out after the configured `timeoutSeconds`, which defaults to one minute. The screen closes independently of credential-fetch completion. Tool abort, session reset, and shutdown also cancel the subprocess. `/assume cancel` preserves active credentials. `/assume clear` discards them.

The extension withholds browser fallback URLs and device codes with Granted's diagnostics. If the browser cannot open, authenticate outside Pi and retry.

The extension accepts only temporary credentials with a session token and future expiration. It reuses them in memory. Within five minutes of expiry, it refreshes them on demand before the next `aws_bash` command. No background refresh timers run. No refresh occurs without an explicitly active role.

The extension serializes concurrent refresh and selection requests. Reset or clear invalidates pending work. Late results therefore cannot restore credentials.

Each `aws_bash` command receives a fresh environment copy. The extension removes these inherited variables:

- AWS credential and profile variables.
- AWS web-identity and container-credential variables.
- Custom AWS config and credential path variables.
- `GRANTED_*` session variables.

Operational `AWS_REGION` and `AWS_DEFAULT_REGION` follow the [region order](#assumptions-and-design-choices). At selection, the extension reads the profile's region from the AWS config file and retains only that value. Granted still uses the profile's configured **SSO authentication region**. That region is separate from the operational region.

A failed refresh prevents the pending shell command from running with stale credentials. Each launched command receives a credential snapshot. Switching or clearing a profile does not revoke that snapshot or change running or background processes. A long-running process can outlive its credentials.

### Known limitations

- **Plain `bash` is unrestricted by design.** It can use ambient AWS credentials and any profile. It can run Granted, read AWS files, or edit `.pi/aws-assume.json`. Policy edits take effect only after your `/reload`. New profiles require approval unless a matching rule enables automatic approval. Thus, a policy edit with `autoApprove: true` can remove confirmation entirely. Warnings make automatic approval visible but do not prevent it. Review policy changes that you did not make.
- **Profile selection checks.** The extension rejects names outside the allowlist before requesting approval or invoking Granted. In `aws_bash`, it rejects explicit `--profile` and `AWS_PROFILE`/`AWS_DEFAULT_PROFILE` assignments in common shell forms. This also applies to allowed names. Select through `assume_profile` instead. Omit profile flags.
- **Command and path checks in `aws_bash`.** The tool rejects common `assume`, `assumego`, and `granted` command invocations. It also rejects `aws configure`, `aws sso login`, and `aws sso logout`. It rejects literal credential/policy paths in absolute, `~/`, `$HOME/`, or `${HOME}/` form. Any mention of the `aws-assume.json` filename is rejected. These checks never apply to plain `bash`.
- **Built-in file guards.** While the extension is loaded, built-in writes/edits to project and global `aws-assume.json` policy files are always blocked. This includes symlink aliases. The guard applies without a policy, with an invalid policy, without Granted, or on an unsupported mode or platform. It prevents the assistant from creating a policy through built-in write/edit tools that would apply after `/reload`. An active project policy also blocks certain built-in file operations on credential stores. These include reads, writes, and edits under `~/.aws`, `~/.granted`, and configured AWS file paths. Plain `bash` is never guarded.
- **Incomplete enforcement.** These checks are not a shell parser, permission sandbox, or complete data-loss-prevention system. Variables, encoded commands, aliases, indirect SDK calls, alternate credential locations, and custom tools can bypass them. Ancestor-directory scans, OS keychain access, and extension-code changes can also bypass them. Removing environment variables does not make host AWS default files or metadata endpoints inaccessible. Do not promise that arbitrary assistant-run programs cannot access broader host credentials.
- **Commands can expose credentials.** A program run through `aws_bash` can access its supplied credentials. It can print them or send them elsewhere. The extension does not secretly filter generic shell output. Private credential-fetch output does not guarantee that credentials can never appear in a transcript.
- **Names do not pin identities.** The allowlist identifies profile names, not fixed AWS account or role identities. User changes to AWS configuration or Granted caches can change the identity that a name resolves to. The extension makes no AWS identity verification call.
- **Browser sign-in requires a display.** In a headless or SSH session without a display, Granted cannot open the login page. The extension withholds the printed URL with the rest of the credential-process output. The attempt then waits until the authentication timeout without a visible prompt. On the same host, run `assume <profile>` in a terminal to complete login. Forward the loopback over SSH if necessary. Then retry `/assume`.
- **Direct STS calls follow AWS permissions.** Direct `aws sts assume-role` calls require neither extension destination allowlisting nor first-use approval. This is deliberate. The extension offers no chaining interface. It does not adopt credentials from those calls.
- **Local execution only.** `aws_bash` runs commands locally through Pi's bash implementation. The extension does not cover other execution tools or remote backends.
- **Excluded features.** The extension includes no AWS web-console sessions, profile CRUD, standalone SSO implementation, or isolation dependency. Automated tests do not exercise actual AWS/SSO authentication.

Use OS isolation or protected credential handling later if stronger guarantees become necessary. Restrict AWS permissions independently of this extension. See [SECURITY.md](SECURITY.md) to report vulnerabilities.

## Development

The package requires no build step or runtime npm dependencies beyond Pi. [Granted](https://github.com/fwdcloudsec/granted) is an external runtime requirement. Pure helpers reside in `src/*.js`. Pi wiring resides in `extensions/aws-assume/index.ts`. Tests use Node's built-in runner.

```bash
npm test
npm run pack:check
# Or:
pnpm test
pnpm run pack:check
```

After editing `src/*.js`, fully restart Pi to load the new helpers. `/reload` can refresh the TypeScript entry point but retain native JavaScript imports. AWS Assume detects incompatible cached policy/session helpers. It then disables role access and sends a restart notice. Configuration-only changes still use `/reload`.

For an installed-Pi loader/command/tool smoke test, set `PI_CODING_AGENT_ENTRY` to the installed package's `dist/index.js`:

```bash
PI_CODING_AGENT_ENTRY=/path/to/pi-coding-agent/dist/index.js npm test
```

Without this variable, installed-Pi tests are skipped. Interactive integration tests target Pi 1.2.0. With the variable set, they run on macOS and Linux. They do not run in CI. Run them locally before a release.

Authentication tests use fake Granted executables and credentials in temporary directories. They make no model requests and use no real AWS credentials or role assumptions. Live Granted authentication remains a user-run smoke test. The prototype used Granted 0.38.0 during development.

Every pull request that triggers CI must bump `version` in `package.json` and move the `Unreleased` changelog entries under a matching `## [<version>] - <date>` heading; CI fails otherwise. Pull requests that change only Markdown skipped by CI are exempt. After the merge to `main` passes CI, the Release workflow tags that commit `v<version>`. Merges that do not change the version are not tagged.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull-request guidance.

## License

[MIT](LICENSE) © Philip Hadviger.
