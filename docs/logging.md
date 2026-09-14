# Production Logging Contract

## Default events

Only the following event families are persisted:

- task created
- state changed
- lease acquired or released
- Worker started or finished
- scope requested or approved
- Candidate snapshot created
- Gate started or finished
- control review recorded
- independent review started or finished
- delivery started or finished
- process terminated
- typed error

## Required fields

```json
{
  "timestamp": "2026-09-14T14:00:00.000+08:00",
  "level": "info",
  "event": "gate.finished",
  "taskId": "task-id",
  "attempt": 2,
  "state": "VERIFYING",
  "durationMs": 1234,
  "outcome": "pass"
}
```

Fields are omitted when irrelevant. Repeated heartbeats and unchanged state are not logged.

## Forbidden content

Production logs never contain:

- prompts or instruction-file contents
- reasoning, thinking, chain of thought, or assistant deltas
- token-by-token output
- source file bodies or complete patches
- tool arguments or results containing file contents
- authorization headers, cookies, credentials, environment values, or private keys
- full stdout/stderr streams
- repeated health messages

Worker completion stores only a bounded, redacted final summary plus usage counters and stable error classification.

## Debug sessions

Raw diagnostic capture is disabled by default. An operator may create an explicit local debug session with a maximum byte limit and expiry. Debug data is stored separately, is never injected into model context, is never included in release artifacts, and is deleted automatically at expiry.

## Retention

- domain events: retained with the Task
- production logs: size- and age-bounded
- successful Task Worktrees: removed after verified integration
- cancelled/terminal Candidate data: retained for a bounded recovery period, then removed unless pinned
- debug data: short TTL only

