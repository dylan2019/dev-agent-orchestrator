# ADR 0001: Clean 1.0.0 Product Boundary

Status: Accepted for implementation

## Context

The legacy project exposed internal lifecycle operations as public MCP tools and relied on long instructions to make Codex call them in the correct order. Real use produced duplicate Tasks, Candidate replay, late review loops, activity without semantic progress, noisy logs, and difficult installation.

## Decision

Build a clean 1.0.0 with a five-tool public MCP API, a deterministic internal workflow driver, a Task aggregate with append-only Attempts and ScopeGrants, immutable CandidateSnapshots, transactional storage, risk-aware budgets, control review before independent review, and key-event-only logging.

Legacy runtime state and policies are not loaded by the new product.

## Consequences

- Workflow correctness moves from prompts into code.
- Public API surface is smaller and stable.
- Storage and state-machine work must be completed before Worker adapters.
- Existing remote history cannot truthfully represent the new 1.0.0 without either a new repository or an explicitly authorized history replacement.
- Stable release requires multi-platform CI and real dogfood evidence.
