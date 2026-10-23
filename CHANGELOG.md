# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] - 2026-10-23

### Fixed

- Support AWS China profiles in `cn-north-1` and `cn-northwest-1` during Granted authentication and assumed shell execution. Granted now uses the selected profile's configured region unless an inherited region takes precedence within the same partition. An inherited China/non-China region mismatch no longer redirects the profile to the other partition. Existing region precedence within a partition and the `us-east-1` fallback remain unchanged.

## [0.3.1] - 2026-10-20

### Fixed

- Clarify that ordinary AWS requests and requests to use existing environment credentials can use plain `bash` without an AWS Assume policy or active profile. Missing setup blocks only extension-managed profile access; tasks requiring an assumed profile must still stop rather than substitute credentials when that profile is unavailable.

## [0.3.0] - 2026-10-17

### Changed

- Allow role access on Linux as well as macOS. The macOS-only guard is removed; Linux support is newer and less widely exercised. Interactive mode is still required, and status diagnostics remain visible wherever the extension loads.
- Reject Windows explicitly with a clear reason instead of relying on Granted executable discovery to fail with an incidental "not installed" message.

### Fixed

- Stop the `/assume` progress screen from hanging after a successful IAM Identity Center browser login. Granted passes its stderr to the browser it launches, so the browser held the pipe the extension waited on and the `close` event was delayed until the browser closed. Discarding the subprocess stderr keeps only stdout piped, so completion no longer depends on the browser. Cancelling the stalled screen previously showed an error and the next attempt used the cached SSO token.
- Never signal Granted's process group when cancelling or timing out. On Linux the login browser is a descendant in that group, so the previous group `SIGKILL` could close every browser window and tab. The extension now terminates Granted alone and escalates to `SIGKILL` for that process only if needed.

## [0.2.0] - 2026-10-17

### Added

- Optional `timeoutSeconds` for Granted authentication and lazy refresh: project overrides global, with a 60-second default. Both the progress screen and credential subprocess use the configured deadline. Settings alone never enable role access.
- Optional per-rule `autoApprove` to skip first-use confirmation for matching concrete profiles. Omitted means no opinion. Only project rules and explicitly selected global rules participate: matching project rules that set it decide, with `false` winning among them; selected global rules decide only when no matching project rule sets it; otherwise confirmation is required. Roles still require explicit selection and never activate automatically.
- Warn at session start when the effective policy contains `autoApprove` rules, listing their IDs, patterns, and layers, and notify each time a profile is approved by such a rule, so a policy change you did not make cannot grant silent access.

### Changed

- Read the global configuration for timeout defaults whenever the project defines or selects rules, even without selected global rule IDs. Unselected global rules still grant no access or auto-approval; invalid or unreadable global configuration therefore fails role access closed in every project that defines or selects rules.
- Block built-in writes/edits to the project and global `aws-assume.json` whenever the extension is loaded, not only with active role access, so the assistant cannot create a policy that takes effect at the next `/reload`. Credential-store guards keep their active-policy scope; plain `bash` is unchanged.
- Include `autoApproveRules` (pattern, setting, and layer) in active-session status metadata so configured automatic approval is visible independently of remembered per-profile approvals.

### Fixed

- Detect incompatible JavaScript policy/session helpers retained during `/reload` after a code update. Keep role access disabled with a full-restart notice instead of throwing on the old policy return shape, reporting a stale trust reason, or silently ignoring auto-approval settings. Add same-process upgrade regression tests using the installed Pi loader; configuration-only changes still use `/reload`.

## [0.1.0-beta.2] - 2026-10-16

### Changed

- Accept every Pi version of the supported major at or above the minimum without a notice; the last-tested-version warning is removed. Minimum-version, unknown-version, and different-major checks still disable role access with a notice.
- Keep `assume_profile` visible for status diagnostics when setup, mode, trust, platform, version, or Granted prevents role access. Other actions still fail closed and `aws_bash` stays hidden until prerequisites pass.
- Explain unavailable role access in model-facing context instead of silently disappearing. Instruct the assistant to stop and report blockers for tasks requiring assumed profiles, not hunt for credentials, fall back to ambient credentials, bypass the extension, or edit AWS policy/profile files. Plain `bash` remains unchanged; this is guidance, not isolation.
- Separate user and model messaging. `/assume` notices state `assume: role access is unavailable.` and the reason; assistant-directed guidance appears only in tool results, tool errors, and the model-facing reminder. The reminder no longer suggests `aws_bash` while it is unavailable.
- Merges to `main` that bump the version are tagged `v<version>` automatically after CI passes, and pull requests that trigger CI must bump the version with a matching changelog section.

## [0.1.0-beta.1] - 2026-10-16

### Added

- Initial standalone AWS Assume package, extracted from the project-local MVP, with `/assume` and the model-only `assume_profile` tool.
- Policy files with one schema of `{ "id", "pattern" }` rules: bundled `config.json` (empty), a global rule library in `aws-assume.json` (following `PI_CODING_AGENT_DIR`), and trusted project `.pi/aws-assume.json`. A project's own rules always apply; global rules apply only when the project selects their IDs in `global`, so later global additions never reach existing projects. Per-profile session approval, exact names and slash-aware globs, and concrete-name discovery are supported.
- Best-effort protection against assistant writes to global policy as well as project policy. `aws_bash` rejects any mention of the `aws-assume.json` file name and home-relative (`~/`, `$HOME/`, `${HOME}/`) spellings of protected credential and policy paths. Blocked edits to protected files tell the assistant to hand the change to the user: the full file path, the intended content as a code snippet, and a `/reload` reminder.
- A separate model-only `aws_bash` tool that runs commands with the selected profile's temporary credentials and refuses to run without an active profile; Pi's `bash` tool is never replaced and keeps the ambient AWS environment.
- In-memory temporary credentials for `aws_bash`, lazy refresh, cancellable authentication with a one-minute deadline and countdown, and an active-profile/expiration widget.
- Best-effort shell/file guardrails and documentation of credential exposure, Granted side effects, and direct STS behavior.
- Startup Pi version check: inactive below Pi 1.2.0 or on another major version, warning on newer untested 1.x versions.
- Region resolution for `aws_bash`: inherited `AWS_REGION`, inherited `AWS_DEFAULT_REGION`, the profile's configured region, then `us-east-1`.
- Pure-logic tests, optional installed-Pi integration tests using fake credentials, standard community files, CI, and package validation.

### Changed

Relative to the project-local MVP:

- The extension is inactive, silent, and registers no usable tools, guards, or reminders unless the project defines rules or selects global rules; an invalid participating policy file fails the whole policy closed with a notice naming the file's layer, not its contents.
- Shell guards apply only to `aws_bash` and match Granted/assume as command words and `.aws`/`.granted` as whole path segments, so ordinary mentions such as `grep granted` are no longer blocked.
- The hidden AWS context reminder is added only when the active profile changes, not before every agent run.
- Renamed the prototype policy path from `.pi/assume.json` to `.pi/aws-assume.json` and replaced its string entries with `{ "id", "pattern" }` rules; migration is manual, with no fallback to the old path or format.

