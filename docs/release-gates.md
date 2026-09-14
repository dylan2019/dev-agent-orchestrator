# Release Gates

No stable release is created from a developer workstation until every gate below passes.

## Static quality

- formatting
- strict TypeScript compilation
- lint
- dependency audit
- license and tracked-file scan
- generated JSON Schema validation
- package/release metadata consistency

## Domain and persistence

- legal and illegal state-transition matrix
- optimistic revision conflict
- atomic writer lease
- crash-safe event append and snapshot rebuild
- idempotent command replay
- typed failure and recovery decisions

## Candidate and Git

- Worktree containment
- path normalization and sensitive-file denial
- append-only scope expansion
- Candidate fingerprint stability
- target-base advancement and controlled migration
- acceptance mutation rejection
- approved-tree equality
- ff-only integration and idempotent retry

## Runtime

- process identity and PID reuse rejection
- process-tree termination
- hard timeout
- semantic-stall budget
- bounded concurrency
- Worker result parsing
- no model/provider fallback
- Windows, Ubuntu, and macOS behavior

## Logging

- no prompt
- no reasoning/thinking
- no assistant deltas
- no source bodies
- no credentials
- no raw streams by default
- bounded retention
- one event per meaningful transition

## End-to-end

- normal implementation
- scope expansion without replacement Task
- deterministic Gate failure and rework
- Codex control review before independent review
- independent review failure and rework
- final approval and delivery
- crash recovery at every durable state
- cancellation at every non-terminal state

## Public usability

- clean installation on all supported operating systems
- `init` produces a valid configuration without manual JSON editing
- `doctor` explains every actionable failure
- one documented golden path completes in under ten minutes excluding model latency
- TypeScript, Java multi-module, and mixed frontend/backend example repositories
- twenty real dogfood Tasks with no state repair or Candidate replay

