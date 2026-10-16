# pi-aws-assume

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Pi](https://github.com/earendil-works/pi) extension for selecting existing AWS IAM Identity Center profiles through an installed [Granted](https://github.com/fwdcloudsec/granted) CLI. In projects that opt in with a profile policy, it adds an `aws_bash` tool that runs commands with the selected profile's temporary credentials, with project allowlisting and once-per-profile session approval. This is a workflow guardrail, **not a credential sandbox**.

> [!IMPORTANT]
> **What this extension does and does not do**
>
> - It does nothing without project opt-in through `.pi/aws-assume.json` and at least one effective profile rule: no tools, no guards, no prompts, and no change to Pi's shell.
> - It never replaces or changes Pi's `bash` tool. Plain `bash` keeps your ambient AWS environment, including `AWS_PROFILE`, a default profile, or any other credentials Pi was launched with.
> - Assumed profiles apply only to the separate `aws_bash` tool. The allowlist and approval control `aws_bash`, not what plain `bash` can do.
> - The assistant is instructed to use `aws_bash` only when the user or task clearly requires one of the project's `/assume` profiles, and otherwise to use plain `bash`.
>
> See [Assumptions and design choices](#assumptions-and-design-choices) before relying on it.

## Installation

This alpha targets interactive terminal Pi 1.x (1.2.0 or newer) on macOS. Linux is deferred; JSON, print, and RPC modes leave role functionality inactive. Granted must already be installed and on Pi's `PATH`. In a project with a policy, startup checks the executable without invoking it. If missing, the extension notifies once and stays inactive; it does not install anything or attempt alternative authentication. See [Pi version compatibility](#pi-version-compatibility) for how other Pi versions are handled.

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

Installation scope and [configuration layers](#configuration) are independent: global and project installations both merge bundled defaults, global rules, and the trusted working project's policy. Global rules alone never activate the extension; each project must opt in.

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

> When migrating from the project-local Assume MVP, disable that prototype before loading this package so the command and tools are not registered twice. Unlike the prototype, this package does not override `bash`; assumed credentials apply only to `aws_bash`. Manually migrate your policy from `.pi/assume.json` to `.pi/aws-assume.json` outside the assistant. The old path is not read, and no credentials or approvals are migrated.

</details>

## Usage

Create your project policy as described in [Configuration](#configuration), then `/reload`. Without project opt-in and at least one effective profile rule, `/assume` only explains that the extension is inactive.

| User command | Behavior |
|---|---|
| `/assume` | Choose from project-allowed profiles. |
| `/assume use <profile>` | Explicitly select an allowed profile, including names such as `status`. |
| `/assume <profile>` | Shorthand selection, except reserved command names. |
| `/assume list [offset]` | List up to 100 concrete matching names without authenticating; `nextOffset` gives the next page. |
| `/assume status` | Show active profile, policy rules, expiry, and the first 100 profile/approval names with total counts; no secrets. |
| `/assume cancel` | Cancel pending authentication and queued role work without clearing the previously active credentials or per-session approvals. |
| `/assume clear` | Clear active credentials and cancel pending authentication. Existing per-session approvals remain. |

The assistant selects a profile with `assume_profile` and then runs commands that need it with `aws_bash`. Both are model-only tools, registered only in projects with a usable policy, and described to the model as tools to use only when the user or task clearly requires an allowed `/assume` profile. When that is unclear, the assistant is told not to use them.

`assume_profile` takes `action` equal to `list`, `status`, `assume`, `cancel`, or `clear`; a concrete `profile` is required for `assume`. The list action accepts an optional integer `offset` and returns pages of 100 names with `totalProfiles` and `nextOffset`. The picker/completions include the full discovered match list, not wildcard rules. Neither tool is callable through codemode scripts, because both can open approval or authentication dialogs.

`aws_bash` takes the same input as `bash` and uses Pi's configured shell and command prefix. It refuses to run when no profile is active, instead of falling back to ambient or default credentials.

The first assistant selection of each allowed concrete profile prompts for approval. Approval is never attached to a wildcard rule: approving `example/team-a/readonly` does not approve `example/team-b/readonly`, even when both match the same rule. Your own `/assume` selection counts as approval. Switching back to an approved profile in the same uninterrupted session does not prompt again. Declining or failing a switch leaves the previous active profile unchanged and reports the failure. An accepted approval is remembered even if authentication subsequently fails.

No profile is active automatically. Credentials and approvals live only in memory and are discarded on restart, `/reload`, `/new`, resume, fork, or shutdown. History and Granted cache entries never reactivate a role or restore approvals. An explicit selection is always required after reset.

An AWS row appears above the editor only after the first successful profile assumption in the current session. It shows the active profile on the left and credential expiration right-aligned on the same line. Expiration uses local time in the compact format `2026-10-15T19:40+9`, with minute precision and a numeric UTC offset (`+5:30` for fractional-hour offsets). Clearing the role removes the expiration and shows `AWS: none`; a reload or session reset hides the row until another successful assumption. The row does not replace Pi's footer.

Once selected, successive **`aws_bash` calls** receive the profile's temporary credentials. CLI/SDK programs launched through those calls inherit them. Plain `bash`, the launching terminal, Pi's own AWS/model-provider environment, user `!`/`!!` commands, other execution tools, subprocesses in other extensions, and MCP servers are not changed.

## Configuration

| Layer | Location | Behavior |
|---|---|---|
| Bundled | `extensions/aws-assume/config.json` | Empty defaults; no shipped allowlist. |
| Global | `~/.pi/agent/aws-assume.json` | Personal default rules; follows `PI_CODING_AGENT_DIR`. |
| Project | `<project>/.pi/aws-assume.json` | Read from the working directory only after Pi grants project trust; opts the project in and overrides/adds rules. |

Rules merge from bundled → global → project by stable `id`. Matching IDs override only the supplied fields; new IDs add rules; `"enabled": false` removes that rule. A string remains shorthand for `{ "id": "<string>", "pattern": "<string>" }`, so existing policies continue to work. Disabled rules retain their other fields internally so an explicit higher-layer `"enabled": true` can re-enable them. Removing one rule is not a deny pattern: another enabled rule may still allow the same profile.

**Explicit project opt-in is required.** Set `"enabled": true` in the project policy to use global defaults, even with an empty project `profiles` array. Existing non-empty project policies also count as opt-in. A missing project policy, `{"profiles": []}`, or project `"enabled": false` keeps the extension silently inactive regardless of global rules. The top-level `enabled` setting controls project opt-in only; use each rule's `enabled` field to disable a global rule. No effective rules also means inactive.

Policy is loaded once per session start/reload, not automatically adopted after file edits. Invalid or unreadable participating layers fail the entire merge closed and report a generic error without exposing raw contents. Global/bundled layers are not read for projects that have not opted in. The extension has no profile-writing API and never directly writes AWS profiles, either policy, or global Pi settings. Granted's own configured side effects are separate; see [Credentials and refresh](#credentials-and-refresh).

### Allow exact profiles

Create `.pi/aws-assume.json` **yourself outside the assistant**, using only your intended existing profiles. This generic example is not an active policy:

```json
{
  "profiles": ["example-readonly"]
}
```

Add your actual `.pi/aws-assume.json` to your project's ignore rules if its names are private; the extension does not create the file or edit ignore rules. Never include credentials in the policy. Run `/reload` after changes.

### Allow a group of profiles

Exact names and slash-aware glob patterns can be mixed:

```json
{
  "profiles": ["example/*/readonly", "example/**/audit", "example-readonly"]
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

### Use global defaults in a project

Create your personal rules yourself in `~/.pi/agent/aws-assume.json` (or under `PI_CODING_AGENT_DIR`):

```json
{
  "profiles": [
    { "id": "readonly", "pattern": "example/**/readonly" },
    { "id": "audit", "pattern": "example/**/audit" }
  ]
}
```

Then explicitly opt a trusted project in with `.pi/aws-assume.json`:

```json
{ "enabled": true, "profiles": [] }
```

Global rules become eligible, not approved or assumed. First assistant use still prompts once per concrete profile per session.

### Override, add, or remove a rule

For the global defaults above, this project narrows `readonly`, removes `audit`, and adds a project-specific admin profile:

```json
{
  "enabled": true,
  "profiles": [
    { "id": "readonly", "pattern": "example/team/readonly" },
    { "id": "audit", "enabled": false },
    { "id": "team-admin", "pattern": "example/team/admin" }
  ]
}
```

To disable a legacy global string rule, use that entire string as the ID, such as `{ "id": "example/**/readonly", "enabled": false }`. A new enabled ID must supply a pattern; an override may inherit it. Disabling one ID does not subtract profiles still matched by another rule.

### Change or remove access

Edit or remove entries yourself outside the assistant, then `/reload`. To deactivate the extension in the project even when global rules exist, use `{"enabled": false, "profiles": []}`, use `{"profiles": []}`, or remove the project file. A reload clears the active role and approvals; policy changes are not applied to an already-running session automatically. No command or tool edits the allowlist or AWS profiles.

### Field reference

| Field | Type | Rules |
|---|---|---|
| `enabled` | Boolean, optional | Project opt-in: `true` explicitly opts in, `false` opts out; omitted preserves legacy non-empty-array opt-in. Global/bundled values do not opt a project in. |
| `profiles` | Array of strings or rule objects, required | At most 100 unique IDs per layer and 100 distinct IDs across the merge, including disabled rules. |
| `profiles[].id` | String, required for objects | Stable ID, at most 128 characters, using the same syntax as names/patterns. Duplicate IDs within a layer are invalid. |
| `profiles[].pattern` | String, required for new enabled rules | Exact profile name or path-style glob, at most 128 characters; inherited when omitted by an override. |
| `profiles[].enabled` | Boolean, optional | Defaults to enabled for new rules; inherited on override. `false` removes the rule, `true` explicitly re-enables it. |

Unknown fields and invalid rules fail the whole policy closed. Regexes, bracket classes, braces, negation, escaping, empty slash segments, and embedded globstars such as `dev**` are not supported. Concrete profile names start with an ASCII letter or digit, contain only ASCII letters, digits, `_`, `.`, `@`, `/`, `+`, `:`, `=`, or `-`, and have no empty slash-delimited segments.

## How it works

### Assumptions and design choices

- **Opt-in per project.** The extension activates only in an interactive, trusted project that opts in through `.pi/aws-assume.json` and has at least one effective rule after merging bundled, global, and project policies. Otherwise it registers no usable tools, guards, reminders, or widget, and it does not notify. A global installation is therefore inert in projects that have not opted in.
- **Plain `bash` is never changed.** It keeps the AWS environment Pi was launched with, including a default profile, `AWS_PROFILE`, SSO caches, or instance metadata. The assistant can still run `aws --profile <anything> …` through plain `bash` with your ambient setup. The allowlist and approval cover only `aws_bash`.
- **Assumed profiles apply only to `aws_bash`.** It removes inherited AWS identity variables, adds the selected profile's temporary credentials, and refuses to run without an active profile.
- **The model decides when to use it.** Tool descriptions and a short reminder tell the assistant to use `assume_profile` and `aws_bash` only when the user or task clearly requires one of the project's allowed profiles, and not to use them when that is unclear. This is guidance, not enforcement.
- **Region order in `aws_bash`.** An inherited `AWS_REGION`, then an inherited `AWS_DEFAULT_REGION`, then the selected profile's `region` in your AWS config file, then `us-east-1`. A CLI `--region` or explicit SDK region still wins. An inherited region therefore applies to every selected profile.
- **Memory only.** Credentials and approvals are never written to disk by the extension and reset on restart, `/reload`, `/new`, resume, fork, or shutdown.
- **macOS, Granted, interactive mode.** Other platforms, other credential tools, and non-interactive modes are out of scope for this alpha.
- **Not a sandbox.** See [Known limitations](#known-limitations).

### Pi version compatibility

Pi does not check extension compatibility when updating packages, so the extension checks the running Pi version at session start:

| Running Pi | Behavior |
|---|---|
| Older than 1.2.0 | Inactive, with a notice. |
| 1.2.0 up to the last tested 1.x version | Active. |
| A newer 1.x version | Active, with a one-time warning per session that the version is untested. |
| A different major version, or an unknown version | Inactive, with a notice, until pi-aws-assume is updated. |

To control when the extension updates, install a pinned tag or npm version instead of the default branch.

### Components

The extension registers `/assume`, the model-only `assume_profile` and `aws_bash` tools, session lifecycle hooks, a widget, and best-effort tool-call guards. `aws_bash` reuses Pi's bash tool implementation, configured shell, and command prefix. When the active profile changes, a short hidden AWS context reminder is added before the next agent run. In-memory role state is cleared on session shutdown/replacement. It does not change the launching shell or provide a security boundary.

### Profile discovery

When glob rules exist, the trusted extension reads section names from `~/.aws/config` and `~/.aws/credentials` (or `AWS_CONFIG_FILE`/`AWS_SHARED_CREDENTIALS_FILE`) at session start/reload. It retains only valid profile names; file values/credentials are never returned, logged, or used to run credential processes during discovery. Files are capped at 2 MiB each and discovery at 10,000 distinct names. Matching discovered names are sorted and deduplicated for the picker, completions, and list tool. SSO-session/service sections are not profiles. No CLI, AWS request, browser login, or role assumption is needed to list them.

Exact-name entries remain listed even if discovery cannot find them; Granted validates them on selection. Discovery failures produce a generic warning and omit wildcard expansion. An explicitly supplied concrete name can still be selected if it matches a rule; the listing is a snapshot, not the authorization authority. Newly added matching profiles become eligible, **not automatically approved**. `/reload` refreshes the picker and discards existing role/approval state. Wildcard strings themselves can never be selected, approved, or passed to Granted.

### Credentials and refresh

The extension directly invokes the resolved Granted executable as `granted credential-process --profile <name> --window 5m --auto-login`, without shell interpolation. Granted retains responsibility for its existing configuration, keychain/cache, and SSO browser login. This interface does not run the `assume` shell alias. It may still write Granted's normal logs/cache/browser integration files. In the inspected upstream code, `credential-process` also invokes profile-registry auto-sync; configured registries can therefore update AWS profiles. This adapter does not disable that behavior or change your Granted settings. If profile files must be strictly immutable, address registry configuration outside Pi before a live trial; this MVP cannot promise that trusted Granted will never update them.

Credential stdout is privately captured and validated, with a 64 KiB limit. Raw stdout/stderr is never forwarded into Pi tool results, notifications, error messages, or session entries. Errors are intentionally generic; diagnose Granted configuration outside Pi. If SSO is needed, Granted opens the browser after approval/selection. A cancellable progress screen with a spinner and seconds-remaining countdown appears while credentials are resolved, including during refresh before an `aws_bash` call. Press Escape (or your configured dialog-cancel key) to abort authentication without clearing the previous active role. Authentication times out after one minute. The progress screen owns its deadline and closes independently of credential-fetch completion. Tool abort and session reset/shutdown also cancel the subprocess. `/assume cancel` provides a separate cancellation action when the command interface is available; `/assume clear` additionally discards active credentials. Browser fallback URLs/device codes are not displayed because Granted diagnostics are withheld; if a browser cannot open, authenticate outside Pi and retry.

Only temporary credentials with a session token and a future expiration are accepted. They are reused in memory and refreshed on demand before the next `aws_bash` command within five minutes of expiry. No background refresh timers run, and no refresh occurs without an explicitly active role. Concurrent refresh/selection requests are serialized. Reset/clear invalidates pending work so late results cannot restore credentials.

`aws_bash` commands receive a fresh environment copy with inherited AWS credential/profile/web-identity/container-credential variables, custom AWS config/credential path variables, and `GRANTED_*` session variables removed. Operational `AWS_REGION` and `AWS_DEFAULT_REGION` follow the [region order](#assumptions-and-design-choices); the profile's region is read from the AWS config file at selection, keeping only that value. Granted still uses the profile's configured **SSO authentication region**, which is separate from the operational region.

Failed refresh prevents the pending shell command from executing with stale credentials. Each launched command receives a credential snapshot. Switching or clearing does not revoke that snapshot or change already-running/background processes, and a long-running process can outlive its credentials.

### Known limitations

- **Plain `bash` is unrestricted by design.** It can use your ambient AWS credentials and any profile, run Granted, read AWS files, or edit `.pi/aws-assume.json`. Policy edits only take effect after your `/reload`, and new profiles still need approval, but review policy changes you did not make.
- The extension denies non-allowlisted names before asking approval or invoking Granted. In `aws_bash`, explicit `--profile` and `AWS_PROFILE`/`AWS_DEFAULT_PROFILE` assignments are rejected in common shell forms, even for allowed names: select through `assume_profile` and omit profile flags.
- In `aws_bash`, common `assume`/`assumego`/`granted` command invocations, `aws configure`, `aws sso login`/`logout`, and literal references to credential/policy paths are rejected. Plain `bash` is never checked.
- In projects with an active policy, built-in file reads under `~/.aws`/`~/.granted` and configured AWS file paths are blocked, and built-in writes/edits to these stores or the project/global `aws-assume.json` policies are blocked, including symlink aliases.
- These checks are **not a shell parser, permission sandbox, or complete data-loss-prevention system**. Variables, encoded commands, aliases, indirect SDK calls, alternate credential locations, custom tools, file scanning from an ancestor directory, OS keychain access, or modifying extension code can bypass them. Host AWS default files and metadata endpoints are not made inaccessible merely by stripping environment variables. Do not promise that arbitrary assistant-run programs cannot access broader host credentials.
- Credentials supplied to an `aws_bash` program are accessible to that program. It can print or exfiltrate them; generic shell output is not secretly filtered. Keeping credential-fetch output private does not guarantee that credentials can never appear in a transcript.
- Profile names are allowlisted, not pinned AWS account/role identities. User-side changes to AWS configuration or Granted caches can affect what a name resolves to. No AWS identity verification call is made.
- Direct `aws sts assume-role` calls remain governed by AWS permissions, **without extension destination allowlisting or first-use approval**, by design. This extension does not offer a chaining interface and does not adopt credentials obtained by those calls.
- `aws_bash` runs commands locally through Pi's bash implementation. Other execution tools and remote backends are not covered.
- No AWS web-console sessions, profile CRUD, standalone SSO implementation, or isolation dependency are included. Actual AWS/SSO authentication has not been exercised by automated tests.

Use OS isolation/protected credential handling later if stronger guarantees become necessary. Restrict AWS permissions independently of this extension. See [SECURITY.md](SECURITY.md) for vulnerability reporting.

## Development

No runtime npm dependencies beyond the Pi host and no build step. Granted is an external runtime prerequisite, not an npm dependency. Pure helpers are in `src/*.js`; Pi wiring is in `extensions/aws-assume/index.ts`; tests use Node's built-in runner.

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

Without that variable, installed-Pi tests are explicitly skipped. Interactive integration tests run on macOS only and are not run in CI yet; run them locally against the Pi version you target before a release. All authentication tests use a fake Granted executable and fake credentials in temporary directories: no model requests, actual AWS credentials, or real role assumptions. The integration targets Pi 1.2.0. Live Granted compatibility/authentication remains a user-run smoke test; the prototype was developed with Granted 0.38.0 installed.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull-request guidance.

## License

[MIT](LICENSE) © Philip Hadviger.
