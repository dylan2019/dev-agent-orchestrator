# Engineering Contract

- Treat the domain model as the source of truth. Infrastructure must not own workflow decisions.
- Model work through Project, Task, Attempt, ScopeGrant, CandidateSnapshot, GateRun, ReviewRun, and Delivery.
- Keep changes production-ready: no TODO comments, placeholder behavior, swallowed exceptions, or unbounded concurrency.
- Preserve candidate integrity, least privilege, independent review, and ff-only delivery.
- Never persist prompts, reasoning, assistant deltas, credentials, or raw tool output in production logs.
- Add a failing test before fixing a workflow, crash-recovery, security, or lifecycle defect.
- Prefer platform APIs; add a dependency only when it supplies a necessary production guarantee.

