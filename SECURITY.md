# Security Policy

## Supported versions

Security updates are provided for the latest released version on a best-effort basis.

## Reporting a vulnerability

Please do not report vulnerabilities in a public issue. Use GitHub's private vulnerability reporting feature on the repository's **Security** tab. If private reporting is unavailable, contact the maintainer through the contact method listed on the GitHub profile at <https://github.com/datfinesoul>.

Include a description of the issue, affected versions, reproduction steps, potential impact, and any suggested remediation. You should receive an acknowledgment within seven days. Please allow a reasonable amount of time for investigation and remediation before public disclosure.

## Security model

Pi extensions execute with the same operating-system permissions as Pi. Review extension source before installation and protect both the package files and AWS Assume configuration from untrusted modification. Project policy in `.pi/aws-assume.json` is loaded only after Pi grants project trust and can define its own rules and select global rules by ID; review it before trusting a repository. Global rules never apply to a project that does not select them. Global and project policy files are protected against built-in assistant writes on a best-effort basis when the extension is active, not against arbitrary local execution. This extension provides best-effort profile-selection guardrails, not a credential sandbox or security boundary. Assumed profiles apply only to its `aws_bash` tool; Pi's plain `bash` tool is never changed and keeps the ambient AWS environment, so the allowlist does not limit what plain `bash` can access. Arbitrary local programs may access host credential stores or print credentials supplied to them. Granted remains responsible for authentication and may update its caches or configured profile registries. Direct STS role assumption is governed by AWS permissions, not the extension allowlist. Availability diagnostics are independent of role authorization: `assume_profile` remains model-visible for status when role access is disabled, and model-facing guidance explains the blocker. When an assumed profile is required but unavailable, the assistant must stop and report it rather than search credential stores, fall back to ambient credentials, invoke AWS/Granted directly to obtain credentials, or edit AWS policy/profile files. This is behavioral guidance, not a sandbox; plain `bash` remains unchanged. Review the [known limitations](README.md#known-limitations) and restrict AWS permissions independently.
