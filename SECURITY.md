# Security Policy

## Supported version

The `1.0.x` release line and schema `1.0.0` are supported.

## Trust boundary

The orchestrator treats Worker output as untrusted and enforces isolated Worktrees, ScopeGrant validation, Candidate fingerprints, process identity checks, independent review, acceptance integrity, and ff-only delivery.

It is not an operating-system sandbox. Worker CLIs inherit the current account's filesystem and network permissions. Sensitive repositories should run under a least-privilege account, container, or virtual machine.

## Sensitive data

Production logs do not persist prompts, reasoning, assistant deltas, source bodies, raw process streams, environment values, credentials, authorization headers, cookies, or private keys. Local configuration and runtime state are excluded from release artifacts.

## Reporting

Use the repository's private security-reporting channel. Do not include credentials, private repository content, internal paths, or raw runtime logs in a public issue.
