# Dev Agent Orchestrator

Production-oriented local delivery orchestration for Git repositories.

The orchestrator owns workflow correctness. Codex owns product intent, architecture decisions, scope approval, candidate review, and final delivery approval. External workers are untrusted implementation or independent-review executors.

The public workflow is intentionally small:

```text
doctor -> start -> observe -> inspect candidate -> decide
```

## Product contract

- One Task represents one stable business objective.
- Retries, rework, and scope expansion create Attempts, never replacement Tasks.
- A Task owns one Candidate whose immutable snapshots are identified by content fingerprints.
- Scope is append-only through ScopeGrant revisions.
- Deterministic affected gates run before Codex control review.
- Independent review runs only after Codex approves the candidate for review.
- Final acceptance and ff-only integration run only after the approved candidate fingerprint passes independent review.
- Production logs contain state transitions and bounded summaries only.

## Public interfaces

The MCP server exposes five tools:

- `orchestrator_doctor`
- `orchestrator_start`
- `orchestrator_observe`
- `orchestrator_get_candidate`
- `orchestrator_decide`

The CLI exposes four setup and diagnostic commands:

```text
dev-agent-orchestrator init <repository>
dev-agent-orchestrator doctor
dev-agent-orchestrator mcp install
dev-agent-orchestrator mcp uninstall
```

Implementation starts only after the architecture, state-machine, logging, security, and release contracts in `docs/` are frozen.
