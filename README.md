# opencode-gateway

OpenCode with a messaging front door.

`opencode-gateway` is intended to be a small, self-hosted gateway that connects chat surfaces like Telegram, Slack, Discord, webhooks, and scheduled jobs to OpenCode. The gateway should handle transport, routing, state, and chat UX while keeping OpenCode as the agentic control plane.

This is a new project. The repository is currently at the starting point, and [`SPEC.md`](./SPEC.md) is the source of truth for the intended direction.

## Idea

OpenCode already provides the important runtime pieces: sessions, agents, tools, permissions, model configuration, events, and the HTTP/SDK surface. What is missing is a durable messaging layer that lets a user interact with OpenCode naturally from mobile-friendly surfaces.

The gateway should provide that layer without becoming a second agent framework.

```text
Telegram / Slack / Discord / Webhooks / Cron
        |
        v
OpenCode Gateway
  - channel adapters
  - auth and pairing
  - session bindings
  - command handling
  - progress rendering
  - permission and question UX
        |
        v
OpenCode Runtime Adapter
        |
        v
OpenCode server and configured agents
```

## Principles

- OpenCode owns intelligence. Normal natural-language work goes to OpenCode.
- The gateway owns transport. Platform APIs, retries, formatting, access control, and chat ergonomics live here.
- Sessions are durable. A chat conversation should stay bound to the same OpenCode session until the user resets or rebinds it.
- Remote control should be safe. Unknown users are denied or paired, dangerous commands are restricted, and OpenCode permission prompts are surfaced explicitly.
- Operational state should be inspectable. Users should be able to see the active channel, profile, target, session, run status, agent, and model.

## First Target

The first useful version should be intentionally narrow:

- Run as a local Bun/TypeScript service.
- Connect one Telegram bot to an existing `opencode serve` instance.
- Send Telegram messages into an OpenCode session.
- Return OpenCode responses back to Telegram.
- Preserve chat-to-session bindings in SQLite.
- Support a small set of gateway commands like `/help`, `/status`, `/new`, `/stop`, `/sessions`, `/profile`, `/agent`, and `/model`.
- Add simple allowlist or pairing-based access control.

After that, the project can grow into Slack, Discord, webhooks, cron jobs, richer profiles, managed OpenCode server lifecycle, native permission approvals, and messaging-native question prompts.

## What This Is Not

- Not a replacement for OpenCode.
- Not a planner/worker/reviewer runtime.
- Not a reimplementation of OpenCode tools, permissions, MCP, memory, agents, or model routing.
- Not a broad multi-platform bot before the OpenCode-first path works well.

## Development

Install dependencies:

```bash
bun install
```

Run the current entry point:

```bash
bun run index.ts
```

Run the real Phase 1 smoke workflow against a local config:

```bash
TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOW_FROM=123456789 \
OPENAI_API_KEY=... \
  bun run smoke:real -- --config examples/config.smoke.jsonc
```

The smoke script validates the real config and Telegram bot token, sends a real prompt through the OpenCode SDK wrapper, then starts the gateway so an allowlisted Telegram account can verify `/status`, a normal OpenCode turn, and restart/session reuse. It expects OpenCode `1.16.2` at `http://127.0.0.1:4096`; update `examples/config.smoke.jsonc` or pass another config path if your server is elsewhere. The example selects `openai/gpt-5.5` and uses `examples/opencode-smoke/opencode.json` to configure OpenAI's US regional base URL, `https://us.api.openai.com/v1`.

To include Telegram permission card acceptance, add `--permission-smoke`. The script uses a temporary gateway database by default, prepares the Telegram DM binding and a fresh OpenCode session for each case, then guides you through sending permission-trigger prompts, approve/deny buttons, and a `/permission` fallback command while it verifies SQLite state. Pass `--reuse-smoke-state` only when you intentionally want to reuse the configured smoke database. `Always allow` remains disabled by default; enable `interactive.permissions.allowAlways` in the config and pass `--permission-always` to smoke it last.

Build the installable package CLI:

```bash
bun run build
```

This writes `dist/index.js`, adds the `opencode-gateway` shebang, and marks it executable. The package exposes that file through `package.json` `bin`, so later installs can run `opencode-gateway` directly.

Build a standalone executable for release-style installs:

```bash
bun run build:bin
```

Build both artifacts:

```bash
bun run build:all
```

Smoke-check the generated CLIs:

```bash
./dist/index.js help
./dist/opencode-gateway help
```

The current service is still an early gateway slice. Real channel and OpenCode runtime wiring will be added as the implementation continues.
