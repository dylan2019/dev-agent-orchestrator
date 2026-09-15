# Dev Agent Orchestrator

[![CI](https://github.com/dylan2019/dev-agent-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/dylan2019/dev-agent-orchestrator/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

> Current release: `1.0.0`. Configuration and durable-state schema: `1.0.0`.

Production-oriented local delivery orchestration for Git repositories. The orchestrator owns workflow correctness. Codex owns product intent, architecture decisions, scope approval, Candidate review, and final delivery approval. External Workers are untrusted implementation or independent-review executors.

```text
Codex -> implementation Worker -> affected Gate DAG -> Codex review
      -> independent Reviewer -> final approval -> acceptance -> ff-only delivery
```

## Why this design

- One Task represents one stable business objective.
- Rework and scope expansion create Attempts, never replacement Tasks.
- ScopeGrant revisions are append-only and fingerprint-bound.
- CandidateSnapshots make every Gate, review, and delivery decision optimistic and stale-safe.
- Codex reviews the Candidate before independent review cost is paid.
- Runtime budgets stop semantically stalled work and unbounded process output.
- Production logs contain key state transitions only—never prompts, reasoning, assistant deltas, source bodies, or raw streams.

## Requirements

- Node.js 24 or later
- Git
- Codex CLI
- two different supported Worker CLIs

Supported Worker Adapters: Cursor Agent, Antigravity, WorkBuddy, and ZCode.

## Install

From a release package:

```shell
npm install --global ./dev-agent-orchestrator-1.0.0.tgz
```

From source:

```shell
npm ci
npm run build
npm link
```

## Initialize

No manual JSON editing is required:

```shell
dev-agent-orchestrator init /absolute/path/to/repository \
  --implementation-model cursor-grok-4.6-xhigh \
  --review-model gemini-3.8-flash-high
```

`init` detects Git, Worker commands, the current target branch, an external Worktree root, project instructions, and an `acceptance-ci.ps1` or `acceptance-ci.sh` script when present. Use `--implementation-adapter` and `--review-adapter` to select other products. Non-standard Worker installations can use `--implementation-command`, `--implementation-args-json`, `--review-command`, and `--review-args-json`.

For lockfile-based Node projects, `init` also creates a pre-Worker setup Gate that runs `npm ci`. Setup may create ignored runtime assets, but the orchestrator fingerprints the Git Candidate before and after every setup Gate and rejects any source change.

Validate every external dependency before use:

```shell
dev-agent-orchestrator doctor
```

## Install the Codex MCP server

```shell
dev-agent-orchestrator mcp install
```

This delegates registration to the supported `codex mcp add` command. Restart Codex after installation, then use `/mcp` to confirm the server is connected. Remove it with `dev-agent-orchestrator mcp uninstall`.

## Public MCP API

The server intentionally exposes five tools:

| Tool                         | Purpose                                                               |
| ---------------------------- | --------------------------------------------------------------------- |
| `orchestrator_doctor`        | Validate Project, Gate, Worker, model, storage, and runtime contracts |
| `orchestrator_start`         | Create one stable Task and start its internal workflow                |
| `orchestrator_observe`       | Read or wait for Task revision changes and legal decisions            |
| `orchestrator_get_candidate` | Read a manifest, bounded patch, or one file patch                     |
| `orchestrator_decide`        | Approve scope, request rework, approve Candidate/delivery, or cancel  |

Worker execution, Gate scheduling, independent review, crash reconciliation, acceptance, commit creation, and ff-only integration are internal operations. Codex cannot reorder or skip them.

## State flow

```text
CREATED
  -> IMPLEMENTING
  -> VERIFYING
  -> AWAITING_CONTROL_REVIEW
  -> INDEPENDENT_REVIEWING
  -> AWAITING_FINAL_APPROVAL
  -> ACCEPTING
  -> COMMITTED
```

Typed controlled states include `SCOPE_APPROVAL_REQUIRED`, `REWORK_REQUIRED`, `EXTERNAL_BLOCKED`, `CANCELLED`, and terminal `EXHAUSTED`. There is no ambiguous generic `failed` state.

## Configuration

The generated configuration is stored under `DEV_AGENT_ORCHESTRATOR_HOME` or `~/.dev-agent-orchestrator`. It contains absolute local paths and must not be committed. See [`config/config.example.json`](config/config.example.json) and [`config/orchestrator.schema.json`](config/orchestrator.schema.json).

Risk-specific routing and execution budgets are mandatory. Candidate size is reported for review, but file and line counts are not delivery blockers; scope authorization, resource limits, review, and final acceptance remain enforced.

## Logging and privacy

Default JSONL logs record only state changes, Worker counters, scope decisions, Candidate counts, Gate outcomes, review outcomes, delivery outcomes, and typed errors. Logs are size-bounded and rotated.

Prompts, instruction contents, reasoning, thinking, assistant/token deltas, source bodies, patches, tool bodies, credentials, and raw stdout/stderr are never persisted by default. See [`docs/logging.md`](docs/logging.md).

## Security boundary

Worktrees, ScopeGrants, Candidate fingerprints, process identities, independent review, acceptance integrity, and ff-only delivery are enforced. External Worker CLIs still execute with the operating-system permissions of the current account; use a least-privilege user, VM, or container for sensitive repositories.

## Development

```shell
npm run format:check
npm run lint
npm run check
npm test
npm audit --audit-level=high
npm run release:check
```

Architecture and release contracts are in [`docs/`](docs/architecture.md). Contributions must preserve the five-tool public boundary and all delivery invariants.
