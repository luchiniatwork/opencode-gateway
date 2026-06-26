# ADR 0001: Turn Execution Strategy

## Status

Accepted

## Context

The gateway routes chat messages into OpenCode sessions and stores one active run per conversation binding. If a run stays active after OpenCode has actually finished, later chat messages are rejected as busy and the user sees silence or stale recovery advice.

We hit this class of regression when final-answer-only Telegram conversations depended on async SSE observation for final delivery. OpenCode accepted prompts, but final event correlation could fail because event envelopes, message ids, replayed events, late text parts, and `/messages` reconciliation did not always match the gateway's assumptions. Permission cards also require event observation, so simply removing observation would have broken the remote approval UX.

## Decision

Turn execution is planned by source, not by a vague async/sync label. The
critical boundary is that final-answer delivery must remain independent from
optional progress observation:

- `finalSource`: `prompt` or `events`
- `progressSource`: `none` or `events`
- `permissionSource`: `none` or `events`

Channel-originated chat turns use `finalSource: prompt` regardless of verbosity.
They must not depend on OpenCode SSE for final delivery. Event observation is a
side channel only: it may provide progress messages and permission cards while
the prompt is running, but failure to correlate progress events must not make the
final answer disappear.

Progress modes (`tools`, `verbose`) use `progressSource: events` so the gateway
can render tool/status/todo/sub-agent progress. Final completion still comes
from the prompt response. Final-answer-only modes (`off`, `compact`) use
`progressSource: none`; `compact` may keep a channel-native activity indicator
(for example Telegram `typing...`) alive while the turn runs, but it does not
send durable progress messages to chat.

Permission observation is independent from progress. If interactive permissions are enabled, `permissionSource` is `events` even for compact/off turns.

The local gateway run lock is an operational safety boundary. Timeouts and `/stop` must release the local active run even if remote OpenCode event streams, message reconciliation, or abort calls fail.

## Consequences

- All channel-originated chat turns use OpenCode's synchronous prompt path for
  final answers.
- Compact turns use transient channel activity indicators when available; the gateway should not send generic “working...” heartbeat messages.
- Tools/verbose turns use SSE event observation only as a progress side channel.
- Permission cards can still appear for compact/off turns through a permission-only observer.
- Regression tests should assert turn-plan behavior directly and verify that
  verbosity changes rendering, not final-answer execution semantics.
- `/status`, `/health`, and logs should expose enough active-run and permission state to diagnose where a blocking failure occurred.

## Executable Checks

This decision is only useful if tests enforce it. The following checks are part
of the architecture, not incidental coverage:

- `src/gateway/turn-runner.test.ts` has a verbosity/permission matrix asserting
  every channel-originated turn starts the runtime with `mode: "sync"`, uses
  `finalSource: "prompt"`, and only changes `progressSource` / `permissionSource`.
- `src/opencode/client.test.ts` asserts sync turns can observe tool progress
  while the final answer comes from `session.prompt`.
- `src/opencode/client.test.ts` asserts progress observer subscription failure,
  event-stream failure, and unknown/no-op progress events do not prevent prompt
  final delivery.
- `src/gateway/turn-runner.ts` has a runtime tripwire that rejects any normal
  channel turn plan attempting to use event-stream final delivery.

## Non-Goals

- This does not make OpenCode event shapes stable.
- This does not implement durable queueing.
- This does not require a specific VCS or workspace workflow.
