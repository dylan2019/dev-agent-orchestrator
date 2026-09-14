# Architecture

## 1. Bounded contexts

### Configuration

Owns Project profiles, Worker profiles, routing by risk, Gate definitions, and execution budgets. Configuration is immutable for a running Attempt and is fingerprinted when a Task is created.

### Orchestration

Owns the Task aggregate and validates every transition. It does not spawn processes, execute Git, persist files, or implement MCP.

### Candidate

Owns the isolated Worktree, changed-file manifest, content fingerprint, immutable snapshots, and safe migration to a newer target base.

### Verification

Selects the affected Gate DAG, caches results by relevant input hashes, records Codex control review, and runs independent review against an immutable CandidateSnapshot.

### Delivery

Runs final acceptance, creates the candidate commit, validates its tree, performs ff-only integration, and optionally pushes. Delivery is idempotent.

### Runtime

Owns Worker adapters, process supervision, timeouts, cancellation, structured results, and bounded diagnostic evidence. Runtime reports facts; it never decides workflow transitions.

## 2. Dependency direction

```text
interfaces -> application -> domain
infrastructure -> application ports
adapters -> runtime ports
domain -> no external dependency
```

The domain layer cannot import MCP, Git, SQLite, filesystem, process, or Worker adapter modules.

## 3. Domain objects

### Project

Stable repository identity, target branch, Worktree root, instruction files, Gate DAG, routing policy, and budgets.

### Task

Stable business objective and risk. A Task remains the same object across rework, recovery, and scope expansion.

### Attempt

One Worker execution with a fixed Worker profile, model, configuration fingerprint, ScopeGrant revision, start time, budget, result, and termination reason.

### ScopeGrant

Append-only authorization revision containing normalized paths, approver, reason, timestamp, and the Candidate fingerprint inspected at approval time.

### CandidateSnapshot

Immutable tuple of base commit, Git tree/content fingerprint, changed-file manifest, and creation evidence. Reviews and Gate runs always reference a snapshot ID.

### GateRun

Gate definition fingerprint, relevant input hash, status, timestamps, bounded result, and optional cache source.

### ControlReview

Codex decision over a CandidateSnapshot: request rework or approve for independent review.

### IndependentReview

Reviewer profile, model, CandidateSnapshot, verdict, findings, and structured result fingerprint.

### Delivery

Acceptance evidence, approved CandidateSnapshot, commit/tree identities, integration status, push status, and idempotency key.

## 4. State machine

```text
CREATED
  -> SCOPING
  -> IMPLEMENTING
  -> VERIFYING
  -> AWAITING_CONTROL_REVIEW
  -> INDEPENDENT_REVIEWING
  -> AWAITING_FINAL_APPROVAL
  -> ACCEPTING
  -> COMMITTED
```

Controlled branches:

```text
IMPLEMENTING -> SCOPE_APPROVAL_REQUIRED -> IMPLEMENTING
VERIFYING -> REWORK_REQUIRED -> IMPLEMENTING
INDEPENDENT_REVIEWING -> REWORK_REQUIRED -> IMPLEMENTING
any non-terminal state -> EXTERNAL_BLOCKED -> previous state
any non-terminal state -> CANCELLED
```

There is no generic `failed` state. Every blocked or unsuccessful transition has a typed reason and a deterministic set of legal next actions.

## 5. Transition invariants

- Only the Task owning the Project writer lease may enter IMPLEMENTING.
- A ScopeGrant can only preserve or expand prior authorization; it cannot silently shrink or replace it.
- Every current Candidate file must be covered by the ScopeGrant used for the next Attempt.
- Candidate changes invalidate affected Gate runs, ControlReview, IndependentReview, and pending Delivery.
- IndependentReview must use a different Worker profile from the implementation Attempt.
- Acceptance input must match the independently approved CandidateSnapshot.
- Candidate fingerprint must remain stable before, during, and after acceptance.
- The committed tree must equal the approved CandidateSnapshot tree.
- Target integration is ff-only and idempotent.

## 6. Application services

Application commands are small and explicit:

- `DoctorProject`
- `StartTask`
- `ObserveTask`
- `InspectCandidate`
- `DecideTask`
- `AdvanceTask` (internal only)

`AdvanceTask` is the sole automatic workflow driver. Public interfaces never call Worker, Gate, Review, or Delivery infrastructure directly.

## 7. Runtime budgets

Each Task owns cumulative budgets and each Attempt owns execution budgets:

- wall-clock duration
- attempts
- implementation runs
- review runs
- tool events
- captured bytes
- time since Candidate fingerprint changed
- changed files
- changed lines

Continuous runtime activity without Candidate progress transitions to `EXTERNAL_BLOCKED` with reason `semantic_stall`. It is not classified as healthy progress.

## 8. Storage

The storage port requires transactions, unique leases, append-only events, optimistic revision checks, and crash-safe durability. The production adapter uses stable SQLite WAL through a maintained runtime dependency; Node experimental SQLite APIs are not permitted.

Large process streams and Candidate file bodies are not stored in the database. Candidate content remains in Git/Worktree storage, and logs contain only the events defined by the logging contract.

## 9. Compatibility

This is a clean 1.0.0 product. It does not load legacy `task.json`, legacy policy files, or legacy Worktrees. An optional offline legacy inspector may be built later, but it cannot participate in the new runtime or mutate legacy state.
