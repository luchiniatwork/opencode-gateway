# AGENTS.md

## Sources of truth
- `SPEC.md` is the product/architecture source of truth; `PHASE_01.md` and `PHASE_02.md` are implementation plans, so verify roadmap claims against code before repeating them.
- This is a Bun + TypeScript service. Use `bun.lock`/`package.json`; there is no npm/yarn workflow or CI config in this repo.

## Commands
- Install: `bun install`.
- Main verification: `bun run typecheck && bun test`.
- Focus a test file: `bun test src/app.test.ts` or any specific `*.test.ts` path.
- Serve with a config: `bun index.ts serve --config <path>` or `bun run serve -- --config <path>`; running without config starts only the no-config app shell.
- Dev watch: `bun run dev -- --config <path>`.
- Build package CLI: `bun run build` (`dist/index.js` with shebang). Standalone binary: `bun run build:bin`. Both: `bun run build:all`.
- Real smoke: `TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOW_FROM=123456789 OPENAI_API_KEY=... bun run smoke:real -- --config examples/config.smoke.jsonc`; it expects a local OpenCode 1.16.2 server at `http://127.0.0.1:4096` unless the config is changed.
- No lint or formatter script exists; do not invent one as required verification.

## Architecture and boundaries
- `index.ts` is the CLI/bootstrap; `src/app.ts` is the composition root for config, SQLite migrations/seeds, repositories, dispatch, commands, turn running, channels, logging, and `/health`.
- Inbound text flows: channel adapter -> `src/app.ts` -> command router first -> dispatch resolver -> turn runner -> `AgentRuntime` -> channel delivery.
- Channel adapters depend on `src/channels/types.ts` and must not call the OpenCode SDK directly. Keep SDK details behind `src/opencode/types.ts` and `src/opencode/client.ts`.
- Use explicit `.ts` extensions on local imports; `tsconfig.json` is set up for Bun/bundler resolution with `allowImportingTsExtensions`.
- Config files are JSONC: comments/trailing commas allowed, `{env:NAME}` / `{env:NAME?}` expanded from `process.env`, `~` expanded, and relative paths resolved against the config file directory. There is no dotenv loader.
- `managed` targets exist in the schema, but `src/app.ts` currently rejects profile routing to non-`attach` targets.
- SQLite is the only persistence layer (`bun:sqlite`). Migrations live in `src/db/migrations.ts`; app startup seeds targets/profiles/access rules and marks stale active runs as aborted.
- `channels.telegram.allowFrom` seeds `access_rules` as `owner`; unknown or blocked senders are denied before commands or runtime dispatch.
- Telegram DMs are accepted automatically; groups/supergroups must be listed in `channels.telegram.groups`, and `requireMention` defaults to true. Conversation keys are canonicalized in `src/channels/telegram/conversation.ts`.
- Current commands: `/help`, `/status`, `/new`, `/reset`, `/stop`, `/sessions`, `/use-session`, `/profiles`, `/profile`. `/agent`, `/model`, debounce, queueing, and permission UX are roadmap/partial unless code says otherwise.
- Current app starts async turns through `AgentRuntime.startTurn`; `busyMode` values are persisted, but an active run currently returns a busy message and suggests `/stop` rather than queueing.
- Telegram callback actions are normalized by the adapter, but `src/app.ts` currently ignores non-message events; `OpenCodeRuntime.respondToPermission` is still unimplemented.
- Progress messages are only emitted for `tools` or `verbose` verbosity; `off` and `compact` are final-answer-only.

## Testing conventions
- Tests use `bun:test`, fake channels/runtimes, temp dirs, and `:memory:` SQLite; prefer that style over tests requiring live Telegram or OpenCode.
- Integration-ish wiring coverage is mainly in `src/app.test.ts`, dispatch in `src/dispatch/resolver.test.ts`, async run behavior in `src/gateway/turn-runner.test.ts`, and SDK normalization in `src/opencode/client.test.ts`.
