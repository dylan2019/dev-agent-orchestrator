# Changelog

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
