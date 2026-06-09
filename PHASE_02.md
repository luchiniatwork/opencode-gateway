# Phase 2: Operational UX

## Current State

The repository has the Phase 1 gateway foundation in place: `index.ts` boots the service, `src/app.ts` composes config, SQLite repositories, dispatch, commands, runtime, and channels, and the implementation includes fake channel/runtime tests for the durable chat-to-session path.

Phase 2 should therefore extend the existing pipeline rather than replace it. `SPEC.md` remains the source of truth.

Current Phase 2-relevant implementation facts:

- `AgentRuntime` already defines `RuntimeEvent`, but only exposes `ensureSession`, synchronous `send`, `abort`, and `listSessions`.
- `OpenCodeRuntime` currently uses `session.prompt` and final-response polling, not `session.promptAsync` plus event observation.
- `src/app.ts` currently waits for dispatch to finish and then sends one final, busy, denied, or error response.
- `ChannelEvent.action` exists, and `OutboundMessage.actions` exists, but app orchestration ignores actions and Telegram does not render inline buttons yet.
- `defaults.inboundDebounceMs` exists in config, but no debounce path uses it.
- `conversation_bindings` already has `agent`, `model`, `busy_mode`, and `verbosity`, but `/agent` and `/model` are not implemented.
- `runs` persists active and finished turns, but there is no `pending_permissions` or `delivery_receipts` table yet.

## Phase 1 Contrast And Closure

`SPEC.md` Phase 1 made the gateway durable: config-driven routing, SQLite state, allowlisted Telegram access, session bindings, basic commands, logs, and health.

Phase 2 turns that durable gateway into an operationally useful chat control surface:

- Long-running OpenCode turns are started asynchronously instead of blocking the gateway until a final answer exists.
- OpenCode events are observed and normalized behind the local `AgentRuntime` boundary.
- Users see compact progress and final results in chat.
- OpenCode permission requests are routed to Telegram buttons with text fallbacks.
- Rapid-fire user messages are debounced before dispatch.
- `/agent` and `/model` expose persisted per-binding overrides.

Phase 1 is considered closed for Phase 2 purposes when an allowlisted Telegram DM can still send a normal message through the existing Phase 1 path, preserve session binding across restart, and use `/status`, `/new`, `/stop`, `/sessions`, `/use-session`, `/profiles`, and `/profile`.

## Scope

Implement:

- `AgentRuntime.sendAsync`, `AgentRuntime.observe`, and `AgentRuntime.respondToPermission`.
- Attach-mode `OpenCodeRuntime` support for SDK `session.promptAsync`, SDK event subscription, and permission response endpoints.
- Runtime event normalization for status, text deltas, tool updates, permission requests, final answers, and errors.
- Async turn orchestration that starts a run, observes events, updates progress, sends final output, and finishes the run record.
- Progress rendering with `off`, `compact`, `tools`, and `verbose` verbosity behavior.
- Telegram message editing for progress updates where possible.
- Telegram inline buttons for permission approvals.
- Text fallback commands for permission approval/denial.
- SQLite persistence for pending permissions and delivery receipts.
- Message debounce for non-command inbound text.
- MVP busy behavior: queue and `/stop`.
- Commands: `/agent` and `/model`.
- Tests for runtime async/event behavior, app orchestration, debounce, permissions, Telegram actions, and new commands.

Defer:

- Slack and Discord.
- Durable outbound delivery queue beyond basic delivery receipt persistence.
- Managed `opencode serve` process mode.
- Webhooks, cron, and question bridge.
- Media download and forwarding.
- Rich role/policy matrix beyond the existing owner/admin/user/blocked model.
- Automatic profile selection by binding or multiple bot accounts.
- Full `steer` busy mode unless OpenCode exposes a stable steering API.

## Implementation Slices

### 1. Runtime Boundary

- Extend `src/opencode/types.ts` with `RuntimeTurnHandle` and `ObserveRuntimeTurnInput`.
- Add `sendAsync(input: SendRuntimeMessageInput): Promise<RuntimeTurnHandle>` to `AgentRuntime`.
- Add `observe(input: ObserveRuntimeTurnInput): AsyncIterable<RuntimeEvent>` to `AgentRuntime`.
- Add `respondToPermission(input: PermissionResponseInput): Promise<void>` to `AgentRuntime`.
- Keep synchronous `send` for compatibility and tests during the transition.
- Make the runtime interface the only place that knows OpenCode SDK event and permission shapes.
- Keep channel adapters independent from OpenCode runtime details.

### 2. OpenCode Async Adapter

- Implement `OpenCodeRuntime.sendAsync` using SDK `session.promptAsync`.
- Generate a gateway-owned message ID before calling `promptAsync` and pass it to OpenCode.
- Return a `RuntimeTurnHandle` containing the session ID, generated message ID, target ID, and initial status.
- Keep model parsing behavior consistent with existing synchronous `send`.
- Preserve the existing attachment rejection unless OpenCode file parts are implemented explicitly.
- Keep attach-mode validation unchanged; managed mode remains deferred.

### 3. Event Observation And Normalization

- Implement `OpenCodeRuntime.observe` using SDK `event.subscribe`.
- Filter events to the target session and, where possible, the gateway-generated message ID.
- Normalize `session.status` and `session.idle` events to runtime status events.
- Normalize `message.part.updated` text deltas to `text_delta` events.
- Normalize tool parts to `tool_start`, `tool_update`, and `tool_end` events.
- Normalize OpenCode permission events to `permission_request` events.
- Normalize assistant completion into a single `final` event with text, cost, and token usage.
- Normalize transport or SDK failures to `error` events.
- Avoid leaking raw SDK event payloads to channel adapters; keep raw payloads only in debug logs or `details` fields where useful.

### 4. Database

- Add migration `002_phase_2_operational_ux`.
- Add `pending_permissions` with the shape from `SPEC.md`.
- Add `delivery_receipts` with the shape from `SPEC.md`.
- Add `src/db/repositories/pending-permissions.ts`.
- Add `src/db/repositories/delivery-receipts.ts`.
- Store async message IDs in `runs.opencode_message_id` as soon as `sendAsync` succeeds.
- Keep `runs_one_active_per_binding` unchanged so one binding has at most one active turn.
- Add repository methods needed by the runner: create pending permission, resolve pending permission, get pending permission by ID, create delivery receipt, and list receipts for a run.

### 5. Turn Runner

- Add a small orchestration layer, likely `src/gateway/turn-runner.ts` or `src/delivery/runner.ts`.
- Keep `DispatchResolver` focused on access, profile, target, session, and binding resolution.
- Move async run lifecycle into the turn runner.
- For a normal inbound message, create a `runs` row, call `runtime.sendAsync`, store the message ID, and begin observation.
- Send final output when a `final` runtime event arrives.
- Finish the run as `completed`, `aborted`, or `error` based on runtime events and abort results.
- Ensure observation stops when the app shuts down, the run completes, or `/stop` aborts the session.
- Log target, profile, session, run, and message IDs for start, progress, permission, final, abort, and error transitions.

### 6. Progress Rendering

- Add `src/delivery/renderer.ts`.
- Send a short working acknowledgement after about 2 seconds if no final answer has arrived.
- Prefer editing one progress message when the channel supports `edit`.
- Fall back to sending sparse progress messages when editing is unavailable.
- Respect binding/profile verbosity:
- `off`: final answer only.
- `compact`: working acknowledgement plus final answer.
- `tools`: include tool start/end summaries.
- `verbose`: include detailed tool updates and debug-oriented status.
- Avoid sending every text delta as a chat message.
- Keep final answer separate from progress output.
- Preserve Markdown for final answers and split long platform messages safely through the channel adapter.

### 7. Telegram Edit And Actions

- Extend `TelegramBotApiLike` with `editMessageText`, `answerCallbackQuery`, and callback query handling.
- Implement `ChannelAdapter.edit` in `src/channels/telegram/adapter.ts`.
- Render `OutboundMessage.actions` as Telegram inline keyboards.
- Listen for Telegram callback queries and emit `ChannelEvent.action`.
- Normalize action IDs and values without embedding OpenCode SDK details in Telegram code.
- Answer callback queries after app orchestration handles them so Telegram does not leave users with a loading spinner.
- Keep existing text message normalization and group mention filtering behavior unchanged.

### 8. Permission Request Routing

- Add `src/interactive/permissions.ts`.
- On `RuntimeEvent.permission_request`, create a `pending_permissions` row.
- Send a concise approval message to the active conversation using `OutboundMessage.actions`.
- Include tool/command name, risk summary, target, session, and timeout where available.
- Support Telegram buttons for approve once and deny.
- Add an optional always-allow action only if explicitly enabled by config or kept behind a conservative default.
- Handle `ChannelEvent.action` for permission approvals and denials.
- Add text fallback commands: `/permission approve <id>`, `/permission deny <id>`, and optionally `/permission always <id>`.
- Require owner/admin for permission responses by default.
- Call `runtime.respondToPermission` and update the pending permission status.
- Edit or reply to the original approval message so chat history shows approved, denied, expired, superseded, or failed.

### 9. Debounce

- Add `src/messages/debounce.ts`.
- Debounce non-command text messages per conversation using `config.defaults.inboundDebounceMs`.
- Default to 1500 ms.
- Do not debounce slash commands.
- Do not debounce `ChannelEvent.action` events.
- Do not debounce permission fallback commands.
- Merge rapid text messages with blank lines in arrival order.
- Preserve the latest message metadata needed for routing and reply target.
- Flush pending debounced messages on app shutdown where feasible; otherwise document that in-memory debounce windows are best-effort.

### 10. Busy Behavior And Queueing

- Implement MVP `queue` behavior for messages that arrive while a binding has an active run.
- Keep the queue in memory for Phase 2; durable queueing belongs in Phase 3 unless delivery reliability becomes a blocker.
- Send a concise queued status message when a message is queued.
- Automatically start the next queued message after the active run finishes.
- Keep `/stop` aborting the active run.
- Decide whether `/stop` should clear queued messages; recommended Phase 2 behavior is to abort the active run and leave queued messages unless the user sends `/stop all` later.
- Preserve current `reject` behavior for bindings configured with `busy_mode = 'reject'`.
- Optionally implement `interrupt` by aborting the active run and immediately starting the new message if it is simple to do safely.
- Return a clear not-implemented response for `steer` if encountered.

### 11. Agent And Model Commands

- Add repository methods to update `conversation_bindings.agent` and `conversation_bindings.model`.
- Add `/agent` to show the effective agent for the current binding.
- Add `/agent <name>` to set a per-binding agent override.
- Add `/agent default` or `/agent clear` to remove the override.
- Add `/model` to show the effective model for the current binding.
- Add `/model <id>` to set a per-binding model override.
- Add `/model default` or `/model clear` to remove the override.
- Require owner/admin for setting or clearing overrides.
- Allow normal users to view current effective values.
- Include effective agent and model in `/status`.
- Ensure future `sendAsync` calls use the effective binding/profile/target agent and model values.

### 12. App Composition And Orchestration

- Update `src/app.ts` to route `ChannelEvent.message` through command handling, debounce, binding resolution, queueing, and the turn runner.
- Update `src/app.ts` to route `ChannelEvent.action` through the interactive permission service.
- Keep outbound target construction in app orchestration so channel code does not own dispatch decisions.
- Register new repositories after migrations run.
- Stop turn observers, debounce timers, and queue workers during gateway shutdown.
- Continue sending denied and command responses synchronously.
- Keep app integration tests using fake channel and fake runtime so Phase 2 behavior does not require a live OpenCode server.

### 13. Observability And Health

- Add structured logs for async run accepted, observer started, observer stopped, progress sent, permission requested, permission resolved, final sent, queue added, queue drained, and debounce flushed.
- Include `source`, `channel`, `accountId`, `conversationKey`, `profileId`, `targetId`, `sessionId`, `runId`, and OpenCode message ID where available.
- Keep logs secret-safe; do not log Telegram tokens, config secrets, or full permission payloads if they can contain sensitive command arguments.
- Extend health output with active run count if cheap to compute.
- Optionally expose queue depth and pending permission count in health if repositories make it straightforward.

### 14. Tests

- Add unit tests for `OpenCodeRuntime.sendAsync` request construction.
- Add unit tests for OpenCode event normalization.
- Add unit tests for `respondToPermission` response mapping.
- Add DB migration and repository tests for pending permissions and delivery receipts.
- Add renderer tests for `off`, `compact`, `tools`, and `verbose` modes.
- Add debounce tests for rapid messages, command bypass, and per-conversation isolation.
- Add command tests for `/agent`, `/model`, and permission fallback commands.
- Add Telegram adapter tests for inline keyboard rendering, edit message behavior, and callback query normalization.
- Add app integration test: fake async runtime emits progress and final; gateway sends progress and final.
- Add app integration test: fake runtime emits permission request; fake channel action approves it; runtime receives permission response.
- Add app integration test: busy `queue` mode queues a second message and dispatches it after the first run finishes.
- Add app integration test: `/stop` aborts an active async run and finishes the run as aborted.

## Permission Semantics

Recommended Phase 2 behavior:

- Permission approvals are safety decisions, not normal chat messages.
- Permission requests are stored before any approval message is sent.
- Permission actions require owner/admin by default.
- Button approvals are the primary UX on Telegram.
- Text fallback commands are available for debugging and accessibility.
- Approve once maps to OpenCode's one-time approval response.
- Deny maps to OpenCode's rejection response.
- Always allow is disabled by default unless a config flag explicitly enables it.
- Permission cards should be resolved visibly in chat by editing or replying to the original message.

## Busy And Queue Semantics

Recommended Phase 2 behavior:

- `queue` is the default busy mode.
- Queueing is in-memory and per binding.
- Queued messages preserve arrival order after debounce.
- A queued message uses the binding state that is current when the queued turn starts, not necessarily when it was queued.
- `/stop` aborts the active run but does not discard queued messages by default.
- If users need queue clearing, add an explicit `/stop all` or `/queue clear` later rather than overloading `/stop` immediately.
- Durable queued delivery should wait for Phase 3's delivery queue unless real usage proves restart safety is needed sooner.

## Definition Of Done

Phase 2 is done when:

- `bun run typecheck` passes.
- `bun test` passes.
- An allowlisted Telegram DM can start a long-running OpenCode task without blocking the gateway event loop.
- Progress appears in chat according to the active verbosity mode.
- Final answers still render correctly and preserve Markdown where Telegram allows it.
- `/stop` aborts an active async OpenCode turn.
- OpenCode permission requests produce Telegram approval buttons.
- Telegram approval and denial buttons call back into OpenCode and update local pending permission state.
- Permission text fallback commands work.
- Rapid non-command messages are debounced into one prompt.
- Queue busy mode dispatches a second message after the active turn completes.
- `/agent` and `/model` show, set, clear, and persist per-binding overrides.
- `/status` shows effective agent and model along with existing routing state.
- Gateway restart still preserves chat-to-session bindings.
- Logs remain structured JSON and do not leak secrets.

## Key Decisions

- Continue using direct `@opencode-ai/sdk` behind the local `AgentRuntime` wrapper for Phase 2.
- Use SDK `session.promptAsync` and SDK event subscription for async execution and observation.
- Generate gateway-owned OpenCode message IDs for async turns so run records have stable handles.
- Keep Phase 2 queueing in memory; reserve durable outbound and inbound queueing for Phase 3.
- Make Telegram buttons the primary permission UX and fallback slash commands the secondary UX.
- Keep always-allow permission responses disabled by default unless explicitly configured.
- Do not introduce a gateway planner, worker model, or intent parser; normal natural-language work still goes directly to OpenCode.
