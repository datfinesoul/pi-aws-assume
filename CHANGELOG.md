# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial standalone AWS Assume package, extracted from the project-local MVP, with `/assume` and the model-only `assume_profile` tool.
- Layered AWS policy: empty bundled defaults, global `aws-assume.json` (following `PI_CODING_AGENT_DIR`), and trusted project `.pi/aws-assume.json`, with stable-ID field overrides, additions, and disabled-rule removal. Legacy profile strings remain supported.
- Explicit project opt-in even with global defaults; missing/empty/disabled project policies stay inactive. Per-profile session approval, exact names and slash-aware globs, and concrete-name discovery remain supported.
- Best-effort protection against assistant writes to global policy as well as project policy.
- A separate model-only `aws_bash` tool that runs commands with the selected profile's temporary credentials and refuses to run without an active profile; Pi's `bash` tool is never replaced and keeps the ambient AWS environment.
- In-memory temporary credentials for `aws_bash`, lazy refresh, cancellable authentication with a one-minute deadline and countdown, and an active-profile/expiration widget.
- Best-effort shell/file guardrails and documentation of credential exposure, Granted side effects, and direct STS behavior.
- Startup Pi version check: inactive below Pi 1.2.0 or on another major version, warning on newer untested 1.x versions.
- Region resolution for `aws_bash`: inherited `AWS_REGION`, inherited `AWS_DEFAULT_REGION`, the profile's configured region, then `us-east-1`.
- Pure-logic tests, optional installed-Pi integration tests using fake credentials, standard community files, CI, and package validation.

### Changed

Relative to the project-local MVP:

- The extension is inactive, silent, and registers no usable tools, guards, or reminders without project opt-in and at least one effective profile rule; invalid participating policy layers fail the entire merge closed with a generic notice.
- Shell guards apply only to `aws_bash` and match Granted/assume as command words and `.aws`/`.granted` as whole path segments, so ordinary mentions such as `grep granted` are no longer blocked.
- The hidden AWS context reminder is added only when the active profile changes, not before every agent run.
- Renamed the prototype policy path from `.pi/assume.json` to `.pi/aws-assume.json`; migration is manual, with no fallback to the old path.

