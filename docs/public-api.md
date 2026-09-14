# Public API

## `orchestrator_doctor`

Validates configuration, repository identity, target branch, Worktree isolation, enabled Worker contracts, model availability, Gate executables, durable storage, and stale leases. It performs no model inference by default.

## `orchestrator_start`

Creates one Task aggregate and returns immediately. Inputs are objective, risk, optional Project ID, and optional initial scope. Worker/model overrides are not public inputs.

## `orchestrator_observe`

Returns a compact Task view or waits for a revision change. It includes current state, elapsed time, cumulative budgets, last Candidate progress, current operation, blocking reason, and legal next decisions.

## `orchestrator_get_candidate`

Returns a manifest by default. A bounded full patch or one file patch requires an explicit mode. Every response includes the CandidateSnapshot fingerprint used for optimistic decisions.

## `orchestrator_decide`

Applies one optimistic, state-checked control decision:

- approve scope expansion
- request implementation rework
- approve Candidate for independent review
- approve final delivery
- cancel Task

Every decision requires the observed Task revision and, where applicable, the observed CandidateSnapshot fingerprint. Stale decisions fail without mutation.

## Internal operations

Worker execution, Gate runs, Reviewer execution, retries, recovery, acceptance, commit creation, and integration are not public MCP tools. They are driven by the application workflow and persisted as domain events.

