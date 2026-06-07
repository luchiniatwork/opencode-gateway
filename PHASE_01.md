# Phase 1: MVP Gateway

## Current State

The repository is still a starter Bun/TypeScript project. `SPEC.md` is the source of truth, `index.ts` only logs a starter message, and there is no `src/`, runtime adapter, persistence layer, config loader, or command surface yet.

Phase 1 should therefore establish the first durable architecture slice rather than refactor existing implementation code.

## Scope

Implement:

- Config loader with JSONC support, env secret expansion, defaults, and validation.
- SQLite persistence using Bun's built-in `bun:sqlite`.
- Migrations for `targets`, `profiles`, `conversation_bindings`, `runs`, `access_rules`, and `schema_migrations`.
- Local `AgentRuntime` boundary with an attach-mode `OpenCodeRuntime`.
- Telegram adapter for one bot via polling.
- Simple allowlist access control.
- Durable chat-to-session binding.
- Default profile support plus explicit `/profiles` and `/profile` switching.
- Commands: `/help`, `/status`, `/new`, `/reset`, `/stop`, `/sessions`, `/use-session`, `/profiles`, `/profile`.
- Structured JSON logs.
- Basic `GET /health` endpoint.
- Unit and integration tests using fake channel/runtime implementations.

Defer:

- Progress event streaming.
- Debounce.
- Permission buttons.
- `/agent` and `/model`.
- Managed `opencode serve`.
- Webhooks, cron, and question bridge.
- Slack and Discord.

## Implementation Slices

### 1. Project Foundation

- Add `src/app.ts` as the composition root.
- Replace starter `index.ts` with CLI/bootstrap entry.
- Add package scripts: `dev`, `serve`, `test`, `typecheck`.
- Add dependencies likely needed: `@opencode-ai/sdk`, `grammy`, `zod`, `jsonc-parser`.
- Keep the HTTP surface minimal with Bun's server APIs unless a web framework becomes clearly useful.

### 2. Config

- Add `src/config/schema.ts` and `src/config/load.ts`.
- Support `~`, `{env:NAME}`, and `{env:NAME?}` style secret references.
- Validate targets, profiles, defaults, Telegram config, gateway host/port, and database path.
- Fail fast with actionable config errors.
- Seed configured targets, profiles, and access rules into SQLite on startup.

### 3. Database

- Add `src/db/client.ts`, `src/db/migrations.ts`, and repository modules under `src/db/repositories/`.
- Use idempotent migrations.
- Store one active `conversation_bindings` row per canonical conversation key.
- Track `runs` for active and finished OpenCode turns.
- Use `access_rules` for allowlisted senders and roles.

### 4. Core Types

- Add normalized gateway types under `src/channels/types.ts`.
- Add runtime boundary types under `src/opencode/types.ts`.
- Add outbound message types under `src/messages/types.ts`.
- Keep channel adapters independent from OpenCode SDK shapes.

### 5. Runtime Adapter

- Implement attach-only `OpenCodeRuntime`.
- Expose `ensureSession`, `send`, `abort`, and `listSessions`.
- Hide direct SDK usage behind `src/opencode/client.ts`.
- If SDK event APIs are awkward, keep Phase 1 final-response-only and leave event observation for Phase 2.

### 6. Dispatch And Bindings

- Add `src/dispatch/resolver.ts`.
- On inbound non-command messages, resolve sender access, active profile, target, and session binding.
- If no binding exists, create an OpenCode session and persist it.
- If a binding exists, reuse its session.
- On `/new` or `/reset`, create a new OpenCode session and update the binding.
- On `/use-session <id>`, validate the session if possible and rebind the conversation.

### 7. Commands

- Add `src/commands/registry.ts`.
- Commands should be explicit slash commands only.
- `/status` should show channel, conversation key, role, profile, target, session, active run, and health.
- `/profile` with no argument should show the current profile.
- `/profile <id>` should switch the current conversation binding to that profile.
- `/sessions` should list recent runtime sessions and mark the current one.
- `/stop` should abort the active run if one exists.

### 8. Telegram Adapter

- Add modules under `src/channels/telegram/`.
- Use canonical keys like `telegram:default:dm:<id>` and add group/topic forms as needed.
- Start with DM support.
- Add basic group mention filtering if config includes groups.
- Send plain text or Markdown-safe responses.
- Do not implement media in Phase 1.

### 9. Observability

- Add `src/observability/logging.ts`.
- Emit JSON logs with `component`, `channel`, `accountId`, `conversationKey`, `profileId`, `targetId`, `sessionId`, and `runId` when available.
- Add `src/observability/health.ts`.
- Health should report gateway status, channel status, target status, active profiles, and version.

### 10. Tests

- Unit tests for config loading, env expansion, command parsing, access decisions, conversation key generation, migrations, binding resolution, and profile switching.
- Integration test: fake channel plus fake runtime creates a binding, survives app restart, and reuses the session.
- Integration test: `/new` updates the binding while old sessions remain listable through the fake runtime.
- Integration test: unauthorized sender is denied before command/runtime dispatch.

## Profile Switch Semantics

Recommended Phase 1 behavior:

- `/profile <id>` updates the active conversation binding to the selected profile.
- If the selected profile uses a different target, create a fresh session for that profile/target.
- If the user wants an existing session, they use `/sessions` and then `/use-session <id>`.
- Do not add extra session-history tables yet unless the OpenCode SDK cannot list sessions well enough.

## Definition Of Done

Phase 1 is done when:

- `bun run typecheck` passes.
- `bun test` passes.
- Gateway starts from a config file.
- Unknown Telegram users are denied.
- An allowlisted Telegram DM can send a message to OpenCode.
- Restarting the gateway preserves the same chat-to-session mapping.
- `/status`, `/new`, `/stop`, `/sessions`, `/use-session`, `/profiles`, and `/profile` work.
- `/health` returns useful JSON.
- Logs are structured JSON and do not leak secrets.

## Key Decision

Use `bun:sqlite`, `grammy`, `zod`, `jsonc-parser`, and direct `@opencode-ai/sdk` behind the local `AgentRuntime` wrapper unless there is a separate decision to evaluate `@liontree/opencode-agent-sdk` first.
