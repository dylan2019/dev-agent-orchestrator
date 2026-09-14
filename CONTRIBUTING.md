# Contributing

## Required local checks

```shell
npm ci
npm run format:check
npm run lint
npm run check
npm test
npm audit --audit-level=high
npm run release:check
```

## Architecture rules

- Domain code must not import MCP, Git, SQLite, filesystem, processes, or Worker Adapters.
- Public MCP remains limited to doctor, start, observe, Candidate inspection, and decisions.
- Workflow transitions belong to the domain state machine, not prompts or interfaces.
- Every state mutation uses optimistic revision checking and an append-only event.
- Worker, model, Project, and routing fingerprints are immutable for a Task.
- New lifecycle, security, crash-recovery, Git, or logging behavior requires a failing test first.
- Production logs may contain key summaries and counters only.
- Do not commit runtime state, local configuration, Worktrees, logs, credentials, or generated debug data.

## Pull requests

Keep changes bounded. Include the invariant affected, failure mode, verification evidence, and compatibility impact. Cross-platform behavior must pass Windows, Ubuntu, and macOS CI.
