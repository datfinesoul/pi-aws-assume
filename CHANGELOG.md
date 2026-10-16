# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Accept every Pi version of the supported major at or above the minimum without a notice; the last-tested-version warning is removed. Minimum-version, unknown-version, and different-major checks still disable role access with a notice.
- Keep `assume_profile` visible for status diagnostics when setup, mode, trust, platform, version, or Granted prevents role access. Other actions still fail closed and `aws_bash` stays hidden until prerequisites pass.
- Explain unavailable role access in model-facing context instead of silently disappearing. Instruct the assistant to stop and report blockers for tasks requiring assumed profiles, not hunt for credentials, fall back to ambient credentials, bypass the extension, or edit AWS policy/profile files. Plain `bash` remains unchanged; this is guidance, not isolation.
- Separate user and model messaging. `/assume` notices state `assume: role access is unavailable.` and the reason; assistant-directed guidance appears only in tool results, tool errors, and the model-facing reminder. The reminder no longer suggests `aws_bash` while it is unavailable.

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

