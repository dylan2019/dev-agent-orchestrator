# Changelog

## Unreleased

### Fixed

- Reclaim the Project writer lease from an externally blocked Task when a new Task starts, so one crashed Runner can no longer lock a Project forever; resuming a blocked Task now re-acquires the lease or fails with a typed conflict.
- Remove an abandoned Candidate Worktree when a Task is cancelled, and report a failed removal instead of leaving the directory behind silently.
- Report Task Runner launch and abnormal termination with a bounded, redacted stderr tail instead of losing every pre-boot crash behind ignored stdio.
- Skip a duplicate Runner launch while the current Runner process is still alive, so repeated decisions cannot stack Runner processes on one Task.
- Derive the Runner registration grace from the persisted Task timestamp, so a restarted MCP server no longer mistakes a booting Task for a lost process.
- Verify Candidate file content by re-hashing instead of trusting `mtime`, so a file touched by indexing or antivirus software no longer fails inspection.

- Reconcile active Tasks periodically while MCP is connected, without overlapping scans or misclassifying a Worktree still being created; recover a lost Runner without a service restart.
- Resume blocked independent review or delivery only when the approved Candidate and, for delivery, the clean original target base are verified; uncertain Git integration exceptions remain blocked instead of restarting implementation.
- Reject filesystem-link escapes in Gate working directories and Candidate file inspection.
- Detect Gate dependency cycles at execution time and honor declared acceptance dependencies.
- Preserve repeated key log events and classify execution failures by exact typed error code, including a distinct `WORKER_RESULT_ERROR` for native CLI `ERROR` status, while keeping Reviewer CLI/schema faults separate from Candidate `FAIL` verdicts.
- Allow a short-lived Worker to complete when it exits before process-identity registration.

## 1.0.0 - 2026-09-14

### Added

- Five-tool public MCP API with deterministic internal workflow advancement.
- Task aggregate with Attempts, append-only ScopeGrants, CandidateSnapshots, Gate results, two-stage review, and idempotent Delivery.
- Transactional SQLite WAL state, append-only events, optimistic revisions, unique writer leases, Gate cache, and runtime process registry.
- Four independent Worker Adapters: Cursor, Antigravity, WorkBuddy, and ZCode.
- Affected Gate DAG with relevant-subtree cache keys; acceptance is never cached.
- Independent Runner processes, Worker process identity tracking, PID-reuse protection, timeout, cancellation, and restart reconciliation.
- CLI initialization, doctor, and Codex MCP install/uninstall commands.
- Key-event-only bounded logging with runtime filtering of unknown fields and sensitive values.
- Cross-platform CI, npm release package, CycloneDX SBOM, and SHA-256 release checksums.

### Security

- Worker tasks cannot change model or routing at runtime.
- Candidate changes invalidate prior Gate, control-review, independent-review, and Delivery evidence.
- Scope expansion is strict, append-only, and bound to the Candidate fingerprint inspected by Codex.
- Final acceptance cannot modify the approved Candidate, and the committed tree must equal the approved tree.
- Target integration is ff-only.
