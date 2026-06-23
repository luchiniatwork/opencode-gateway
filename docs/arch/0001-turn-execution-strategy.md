# ADR 0001: Turn Execution Strategy

## Status

Accepted

## Context

The gateway routes chat messages into OpenCode sessions and stores one active run per conversation binding. If a run stays active after OpenCode has actually finished, later chat messages are rejected as busy and the user sees silence or stale recovery advice.

We hit this class of regression when final-answer-only Telegram conversations depended on async SSE observation for final delivery. OpenCode accepted prompts, but final event correlation could fail because event envelopes, message ids, replayed events, late text parts, and `/messages` reconciliation did not always match the gateway's assumptions. Permission cards also require event observation, so simply removing observation would have broken the remote approval UX.

## Decision

Turn execution is planned by source, not by a vague async/sync label:

- `finalSource`: `prompt` or `events`
- `progressSource`: `none` or `events`
- `permissionSource`: `none` or `events`

Final-answer-only modes (`off`, `compact`) use `finalSource: prompt`. They must not depend on OpenCode SSE for final delivery. They may use event observation only as a permission side channel.

Progress modes (`tools`, `verbose`) use `finalSource: events` and `progressSource: events` so the gateway can render tool/status progress and final completion from the same observed turn.

Permission observation is independent from progress. If interactive permissions are enabled, `permissionSource` is `events` even for compact/off turns.

The local gateway run lock is an operational safety boundary. Timeouts and `/stop` must release the local active run even if remote OpenCode event streams, message reconciliation, or abort calls fail.

## Consequences

- Compact/off turns use OpenCode's synchronous prompt path for final answers.
- Tools/verbose turns continue to use async prompt and SSE event observation.
- Permission cards can still appear for compact/off turns through a permission-only observer.
- Regression tests should assert turn-plan behavior directly instead of treating `promptAsync` as synonymous with a gateway turn.
- `/status`, `/health`, and logs should expose enough active-run and permission state to diagnose where a blocking failure occurred.

## Non-Goals

- This does not make OpenCode event shapes stable.
- This does not implement durable queueing.
- This does not require a specific VCS or workspace workflow.
