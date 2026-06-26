# Phase 4: Multi-Target

## Current State

The repository has the durable Telegram-first gateway and Phase 2 operational UX in place. `index.ts` boots the service, `src/app.ts` composes config, SQLite repositories, dispatch, commands, turn running, permissions, channels, logging, and `/health`, and the implementation has broad fake channel/runtime coverage for durable sessions, async turn handling, progress, permissions, debounce, queueing, `/agent`, and `/model`.

Phase 4 should therefore extend the existing target-aware architecture rather than replace it. `SPEC.md` remains the source of truth, and ADR `docs/arch/0001-turn-execution-strategy.md` remains binding: channel-originated chat turns must continue to use prompt-based final delivery, with events only as a progress/permission side channel.

Current Phase 4-relevant implementation facts:

- Config already supports named OpenCode targets with `attach` and `managed` modes, plus `serverUrl`, `workdir`, `configDir`, `defaultAgent`, and `defaultModel`.
- Config validation accepts `managed` targets when `workdir` is present, but `src/app.ts` rejects profile/default routing to non-`attach` targets during startup.
- SQLite already has `targets`, `profiles`, `conversation_bindings`, and `runs`; bindings store `profile_id`, `target_id`, OpenCode session, agent/model overrides, busy mode, and verbosity.
- `runs.target_id` snapshots the execution target, which is important for `/stop`, permission responses, and diagnostics after a binding moves.
- `DispatchResolver` is already target-aware through profiles. `/profile` keeps the current session when the target is unchanged and creates a fresh session when the selected profile changes target.
- Binding runtime defaults already resolve in the right order: binding override, profile default, target default, then none.
- `/agents`, `/agent`, `/models`, and `/model` already validate against the active target and persist per-binding overrides.
- Queued turns are prepared by re-running binding resolution, so queued messages start with the binding state that is current when they drain.
- `/stop` already uses the active run's target snapshot rather than the current binding target.
- `OpenCodeRuntime` is target-parametric, but still validates every target as `attach` and requires `serverUrl`; `configDir` and `defaultConfigDir` are persisted but not used by the runtime.
- `/health` currently reports every configured OpenCode target as `configured`; it does not expose live target readiness.
- Startup currently probes every attach target with `runtime.listAgents` and fails the whole gateway if any configured attach target is unavailable.
- `/bind`, `/unbind`, and `/targets` are not implemented.
- `accessPolicyId` and `commandPolicyId` exist on profiles but command authorization remains ad hoc.
- `pending_permissions` currently has a global uniqueness constraint on `opencode_permission_id`, which is risky once multiple OpenCode servers can emit IDs independently.

## Phase 2/3 Contrast And Closure

`SPEC.md` Phase 2 made the gateway operationally useful from chat: async turn orchestration, progress side channels, permission buttons and fallback commands, debounce, queueing, `/agent`, and `/model`.

`SPEC.md` Phase 3 describes Slack, Discord, and a durable delivery queue. Those pieces are not yet implemented. Phase 4 may still proceed because multi-target routing is orthogonal to channel breadth: the current Telegram adapter and fake channel/runtime tests are enough to prove target routing, managed target lifecycle, and binding semantics.

Phase 4 turns the current target-aware implementation into a real target operations layer:

- Users can inspect configured OpenCode targets from chat.
- Conversations can be explicitly rebound to named targets/workspaces.
- Profiles, explicit target bindings, sessions, agent/model defaults, busy mode, and verbosity interact predictably.
- Attach target failures no longer prevent unrelated chats from using healthy targets.
- Managed `opencode serve` targets can be started, probed, stopped, and restarted by the gateway.
- Health, status, and logs expose target readiness and routing decisions.

Phase 2 is considered closed for Phase 4 purposes when `bun run typecheck && bun test` passes and an allowlisted Telegram DM can still use the current Phase 2 path: normal turns, `/status`, `/new`, `/stop`, `/sessions`, `/use-session`, `/profiles`, `/profile`, `/agent`, `/model`, debounce, queueing, and permission approvals.

Phase 3 is not a prerequisite for Phase 4, but Phase 4 must not make future Slack/Discord work harder. All target logic must remain outside channel adapters.

## Scope

Implement:

- Explicit target binding semantics that separate profile routing from runtime target routing.
- SQLite/repository support for tracking whether a binding's target comes from the profile default or an explicit `/bind`.
- Scoped pending permission uniqueness suitable for multiple OpenCode targets.
- A target supervisor/service that owns target readiness, attach probes, managed process lifecycle, and live health state.
- Managed `opencode serve` support for configured workspaces.
- Non-fatal target startup and health handling: unhealthy targets should not stop unrelated targets/chats from working.
- Commands: `/targets`, `/bind <target>`, and `/unbind`.
- Centralized default command authorization for target/session/profile/agent/model/permission commands.
- `/status` and `/health` updates that expose target health and target binding source.
- Target-unavailable user messages that are concise, actionable, and secret-safe.
- Tests for config, migrations, repositories, supervisor behavior, commands, dispatch, app orchestration, health, and managed target process lifecycle using fakes where possible.
- A managed-target example config and a real manual smoke path.

Defer:

- Slack and Discord adapters.
- Durable inbound/outbound queueing beyond the current in-memory busy queue and delivery receipt persistence.
- Full CLI target CRUD such as `targets add`, `targets remove`, and `doctor`; Phase 4 may add chat inspection/binding first.
- Webhooks, cron, and question bridge.
- Media download and forwarding.
- A broad custom policy DSL or enterprise RBAC system.
- Automatic profile selection by channel/conversation binding and one bot/account per profile.
- VCS workflow enforcement or automatic repository mutation around managed workspaces.
- A web dashboard for target/process health.

## Implementation Slices

### 1. Target Semantics And Binding Model

- Treat profile routing and target routing as separate decisions, matching `SPEC.md` section 6.4.
- Introduce a target binding source concept:
  - `profile_default`: the binding target follows the active profile's `defaultTargetId`.
  - `explicit_bind`: the binding target was explicitly selected with `/bind`.
- Recommended effective target behavior:
  - First non-command message creates a binding using the default profile and that profile's default target.
  - `/bind <target>` sets `target_source = 'explicit_bind'`, creates a fresh session on the selected target, and future turns use that target until `/unbind` or another `/bind`.
  - `/unbind` clears the explicit target override and returns the binding to the active profile's default target.
  - `/profile <id>` preserves an explicit target binding when the new profile is allowed to use that target.
  - `/profile <id>` uses the selected profile's default target when the binding source is `profile_default`.
  - `/new` and `/reset` create a new session on the current effective target.
  - `/use-session <id>` validates the session on the current effective target.
- Do not silently delete OpenCode sessions when target bindings change; old sessions remain discoverable through `/sessions` on the relevant target.
- Keep the current `runs.target_id` snapshot behavior. Active runs must continue on the target where they started even if the conversation binding moves.
- Preserve current queued-turn semantics: queued turns start with the binding state current at drain time, not enqueue time.
- Update user-facing copy to call out target source explicitly where useful:
  - `Target: AI Sharing repo (ai-sharing) (explicit bind, healthy)`
  - `Profile default target: Default workspace (default)`
- Update tests that currently assume `/profile <id>` always moves to the selected profile's target; the new behavior depends on `target_source`.

### 2. Config Schema And Validation

- Extend target config carefully without making Phase 4 a process-supervisor framework.
- Keep existing target fields:
  - `id`
  - `name`
  - `mode`
  - `serverUrl`
  - `workdir`
  - `configDir`
  - `defaultAgent`
  - `defaultModel`
- Add a small managed-target configuration object, for example:

  ```json5
  {
    id: "ai-sharing",
    name: "AI Sharing repo",
    mode: "managed",
    workdir: "/home/tiago_theoai_ai/repos/work/ai-sharing",
    configDir: "/home/tiago_theoai_ai/repos/work/ai-sharing/tiago-setup",
    defaultAgent: "cto",
    managed: {
      command: "opencode",
      host: "127.0.0.1",
      port: 0,
      startupTimeoutMs: 15000,
      stopTimeoutMs: 5000,
      healthCheckIntervalMs: 10000,
      healthCheckTimeoutMs: 2000,
      restart: "on-failure"
    }
  }
  ```

- Recommended defaults:
  - `managed.command`: `opencode`
  - `managed.host`: `127.0.0.1`
  - `managed.port`: `0` or omitted means choose an available local port.
  - `managed.startupTimeoutMs`: 15 seconds.
  - `managed.stopTimeoutMs`: 5 seconds.
  - `managed.healthCheckIntervalMs`: 10 seconds.
  - `managed.healthCheckTimeoutMs`: 2 seconds.
  - `managed.restart`: `on-failure`.
- Validate:
  - Attach targets require `serverUrl`.
  - Managed targets require `workdir`.
  - Managed targets may omit `serverUrl` when the supervisor chooses a local port.
  - `managed.port` is either `0` or a valid TCP port.
  - Timeouts and intervals are non-negative integers with reasonable upper bounds.
  - Target IDs remain unique and stable; names remain unique for display.
  - Profile `defaultTargetId` references a configured target.
  - Policy IDs, if configured, reference known policy entries once policy config exists.
- Continue expanding `~`, config-relative paths, and `{env:NAME}` / `{env:NAME?}` exactly as today.
- Keep secret-safe config errors. Never include token/env values in validation messages.
- Before implementing managed launch flags, verify OpenCode's current CLI shape for `serve`, hostname, port, workdir/directory, and config directory. Do not guess and accidentally bake a stale CLI contract into the gateway.

### 3. Database And Repositories

- Add migration `004_phase_4_multi_target`.
- Add target source to `conversation_bindings`:

  ```sql
  ALTER TABLE conversation_bindings
    ADD COLUMN target_source TEXT NOT NULL DEFAULT 'profile_default'
    CHECK (target_source IN ('profile_default', 'explicit_bind'));
  ```

- Update TypeScript DB types:
  - Add `TargetBindingSource = 'profile_default' | 'explicit_bind'`.
  - Add `targetSource` to `ConversationBindingRecord`.
  - Thread `targetSource` through create/update repository inputs.
- Add conversation binding repository methods:
  - `updateTarget({ conversationKey, targetId, opencodeSessionId, sessionName, targetSource, agent?, model? })`.
  - `clearExplicitTarget({ conversationKey, targetId, opencodeSessionId, sessionName, agent?, model? })`.
  - `listByTargetId(targetId)` if useful for diagnostics.
  - Avoid hard-deleting bindings for `/unbind` in Phase 4 unless a later decision explicitly changes `/unbind` semantics.
- Add run repository methods:
  - `listActiveByTargetId(targetId)`.
  - Optionally `finishActiveByTargetId({ targetId, status, error })` if managed crash handling needs it.
- Fix pending permission uniqueness for multi-target operation:
  - Replace global uniqueness on `opencode_permission_id` with uniqueness scoped at least by `run_id` and `opencode_permission_id`.
  - Repository lookup by OpenCode permission ID should consider the active run/target context where possible.
- Do not persist volatile child process health in SQLite for Phase 4. Keep process PID, restart count, and last probe state in memory unless real restart recovery requires persistence later.
- Keep migrations idempotent and compatible with existing databases created by Phase 1/2.

### 4. Target Supervisor And Runtime Target Resolution

- Add a dedicated target service layer, likely under `src/targets/`:
  - `types.ts`
  - `supervisor.ts`
  - `managed.ts`
  - `health.ts`
- The target supervisor owns:
  - attach target probes
  - managed process startup
  - managed process readiness checks
  - managed process stop/restart
  - effective runtime target resolution
  - live target health snapshots
- Keep `OpenCodeRuntime` focused on HTTP/SDK calls. It should not spawn processes.
- Add an interface along these lines:

  ```ts
  interface TargetSupervisor {
    start(): Promise<void>;
    stop(): Promise<void>;
    resolve(target: TargetRecord): Promise<RuntimeTarget>;
    probe(targetId: string): Promise<TargetHealthSnapshot>;
    health(): Record<string, TargetHealthSnapshot>;
    restart?(targetId: string): Promise<TargetHealthSnapshot>;
  }
  ```

- For attach targets:
  - `resolve` returns the configured target when `serverUrl` exists.
  - Probes should mark target `healthy` or `unhealthy`, but not fail gateway startup by default.
  - A target can still be used optimistically if health is stale; runtime errors should update health.
- For managed targets:
  - `resolve` starts the process if it is not already healthy.
  - It returns an effective `RuntimeTarget` with a concrete `serverUrl`.
  - It preserves `workdir`, `configDir`, default agent, and default model.
- Update `OpenCodeRuntime.validateAttachTarget` into a more accurate validation:
  - Runtime operations require an effective `serverUrl`.
  - Error text must not say `Phase 1 only supports attach mode` anymore.
  - A managed target should normally be resolved by the supervisor before reaching `OpenCodeRuntime`.
- In `src/app.ts`, inject target resolution into dispatch/commands/runtime calls rather than having channel code know about it.
- Ensure tests can use a fake target supervisor without launching real OpenCode.

### 5. Managed `opencode serve` Process Lifecycle

- Implement managed process support behind the supervisor using Bun's process APIs.
- Launch one child process per managed target instance.
- Consume stdout and stderr so the child cannot block on full pipes.
- Add structured logs for:
  - managed target starting
  - managed target ready
  - managed target stdout/stderr summary lines, if safe and useful
  - managed target exit
  - managed target restart scheduled
  - managed target stopped
- Readiness:
  - Wait for the configured startup timeout.
  - Probe the effective OpenCode server URL using a cheap endpoint or `runtime.listAgents` through the SDK wrapper.
  - Mark `healthy` only after a successful probe.
  - Mark `unhealthy` or `error` with the last error if readiness times out.
- Shutdown:
  - Stop accepting new channel work first.
  - Stop debouncers, observers, and queues as app shutdown does today.
  - Gracefully signal managed children.
  - Force kill after `stopTimeoutMs`.
  - Always consume final process output and log exit status.
- Restart behavior:
  - Start with `restart: 'on-failure'` and conservative exponential backoff.
  - Do not restart processes intentionally stopped by gateway shutdown.
  - Avoid restart storms with max attempts or capped backoff.
  - Mark target `restarting` while waiting.
  - If a managed process dies while a run is active, mark target unhealthy and let the turn runner surface runtime/observer failure; optionally finish active runs for that target if no runtime event can arrive.
- Edge cases to test:
  - `opencode` binary missing.
  - fixed port collision.
  - dynamic port assignment.
  - missing/inaccessible `workdir`.
  - missing/inaccessible `configDir`.
  - child exits before readiness.
  - child exits during an active run.
  - gateway startup fails after a managed process starts; cleanup must stop the child.
- Do not enforce a VCS workflow. Managed mode may warn in docs about workspace concurrency, but the gateway must not mutate Git/Jujutsu state or require a branch model.

### 6. Target Health And Observability

- Replace static target health in `src/observability/health.ts` with supervisor-provided live health.
- Target health statuses should include at least:
  - `configured`
  - `starting`
  - `healthy`
  - `unhealthy`
  - `restarting`
  - `stopped`
  - `error`
- Health snapshots should expose, where safe:
  - mode
  - status
  - effective server URL for local managed targets
  - PID for managed targets
  - started time or uptime
  - restart count
  - last probe time
  - last error summary
  - active run count per target if cheap
- Keep `/health` useful for both humans and process monitors.
- Recommended `ok` semantics:
  - `ok` means the gateway process and channel loop are alive.
  - An optional or unused target being unhealthy should make health visibly degraded but should not necessarily make `ok: false`.
  - If the default profile target is unhealthy, expose that prominently.
- Add logs with the standard context fields:
  - `source`
  - `channel`
  - `accountId`
  - `conversationKey`
  - `profileId`
  - `targetId`
  - `sessionId`
  - `runId`
- Keep logs secret-safe:
  - Do not log Telegram tokens.
  - Do not log full environment maps passed to managed processes.
  - Do not log full permission payloads if they may contain sensitive command arguments.
  - Log managed command path and sanitized args only.
- Update `/status` to include:
  - binding ID
  - current target source
  - current target health
  - profile default target
  - active run target when it differs from current binding target
  - command policy label

### 7. Dispatch Resolver And Binding Operations

- Keep `DispatchResolver` focused on authorization, profile, target, session, and binding resolution.
- Add resolver methods:
  - `bindTarget(message, targetId)`.
  - `unbindTarget(message)`.
  - Optionally `listTargetsForMessage(message)` if command filtering needs policy-aware target lists.
- `bindTarget` behavior:
  - Authorize sender before any runtime work.
  - Resolve target by ID first; target names can remain display-only in Phase 4 to avoid parsing ambiguity.
  - Check command/access policy before mutation.
  - If no binding exists, use the default profile and create a new session on the selected target.
  - If the target is unchanged and already explicit, return a no-op result.
  - If the target changes, create a new session on the new target.
  - Preserve agent/model overrides only when available on the new target.
  - Clear invalid overrides and report them to the user.
  - Do not abort active runs automatically; active run target snapshots already protect `/stop` and permission response routing.
- `unbindTarget` behavior:
  - Authorize sender before any runtime work.
  - If no binding exists, do not create one.
  - If the binding target is already `profile_default`, return a no-op explanation.
  - Refuse to unbind while an active run exists for the binding.
  - Refuse or clearly warn while queued turns exist for the binding; recommended Phase 4 behavior is to refuse until the queue drains.
  - Return to the active profile's default target.
  - If returning to a different target, create a new session on that target.
  - Validate and clear agent/model overrides unavailable on the profile default target.
- `/profile` behavior with target source:
  - If `target_source = 'profile_default'`, switching profile may switch target to the new profile's default target as today.
  - If `target_source = 'explicit_bind'`, switching profile keeps the explicit target if policy allows it.
  - If the explicit target is not allowed by the new profile policy, either reject the profile switch or clear the explicit bind with explicit user-facing text. Recommended Phase 4 default: reject and tell the user to `/unbind` or choose a permitted target.
- Ensure future `startTurn` calls use the effective target, agent, model, busy mode, and verbosity after these binding changes.

### 8. Commands And Command Policy

- Add commands:
  - `/targets`
  - `/targets <id>` if detail view is easy.
  - `/bind <target-id>`
  - `/unbind`
- Update `/help` to include target commands.
- Add a central command authorization helper, likely under `src/security/commands.ts`.
- Replace ad hoc command authorization checks with a default command policy matrix.
- Recommended default authorization:

  | Command group | Default roles |
  | --- | --- |
  | Normal chat | owner, admin, user |
  | `/help`, `/status` | owner, admin, user |
  | `/targets`, `/profiles`, show `/profile` | owner, admin, user |
  | `/agents`, `/models`, show `/agent`, show `/model` | owner, admin, user |
  | `/new`, `/reset`, `/stop` | owner, admin, user |
  | `/sessions` | owner, admin, user, filtered to allowed target |
  | `/use-session` | owner, admin by default |
  | `/profile <id>` | owner, admin by default; user only by policy |
  | `/bind`, `/unbind` | owner, admin by default |
  | Set/clear `/agent`, set/clear `/model` | owner, admin |
  | Permission approval/denial | owner, admin by default |

- Use existing profile fields:
  - `accessPolicyId` should describe which users/roles may enter/use the profile and which targets it may route to.
  - `commandPolicyId` should describe command role overrides for that profile.
- Keep policy implementation intentionally small for Phase 4:
  - Support built-in defaults first.
  - Add named policies only if the config shape is clear and covered by tests.
  - Do not build a general-purpose RBAC DSL.
- `/targets` output should not create a binding or session.
- `/targets` should mark:
  - current target
  - profile default target
  - explicit bind target
  - target mode
  - health status
  - default agent/model, if safe to show
- Example `/targets` output:

  ```text
  🎯 OpenCode targets:
  * default: Default workspace [attach, healthy] current, profile default
  - ai-sharing: AI Sharing repo [managed, healthy]
  - ops: Ops workspace [managed, unhealthy: startup timed out]

  Use /bind <target-id> to bind this conversation to a target.
  ```

- Example `/bind` output:

  ```text
  Bound conversation to AI Sharing repo (ai-sharing).
  Previous target: Default workspace (default)
  Current session: session_abc
  Profile: CTO (cto)
  Agent: cto (profile default)
  Model: openai/gpt-5.5 (profile default)
  ```

- If an active run exists while binding changes, include:

  ```text
  Active run run_123 continues on previous target default. Future turns use ai-sharing.
  ```

- Example `/unbind` output:

  ```text
  Cleared explicit target bind.
  Target now follows profile CTO (cto): Default workspace (default).
  Current session: session_xyz.
  ```

### 9. App Composition And Startup/Shutdown Orchestration

- Replace `validatePhase1RuntimeTargets` with Phase 4 target initialization.
- Replace fatal `validateOpenCodeTargetsReachable` with non-fatal target health initialization.
- Recommended startup order:
  1. Parse config.
  2. Open SQLite.
  3. Run migrations.
  4. Seed targets, profiles, and access rules.
  5. Mark stale active runs aborted as today.
  6. Create repositories.
  7. Create the target supervisor.
  8. Start/probe targets according to configured lifecycle policy.
  9. Create the runtime wrapper that resolves targets through the supervisor.
  10. Create dispatch resolver, permission service, turn runner, command router, debounce service, and channels.
  11. Start channels.
  12. Start health endpoint.
- Startup should not fail solely because one configured OpenCode target is unavailable unless that target is required by a strict config flag added later.
- If startup fails after any managed process starts, cleanup must stop those processes.
- Recommended shutdown order:
  1. Mark app not accepting new work.
  2. Stop debouncer.
  3. Abort app-level signal.
  4. Stop turn runner/observers/queues.
  5. Stop channels.
  6. Stop health server.
  7. Stop managed target supervisor.
  8. Close SQLite.
- Keep outbound target construction in app orchestration; channel adapters remain transport-only.
- Keep fake channel/fake runtime/fake supervisor tests as the main integration strategy.

### 10. Target Failure UX And Runtime Error Handling

- Target failures should produce concise, actionable user-facing responses.
- If a target is known unhealthy before dispatch:
  - Do not create a run if no OpenCode prompt was sent.
  - Reply with target ID/name, status, and a short last-error summary.
  - Preserve the existing binding so the user/admin can retry after recovery.
- Example:

  ```text
  OpenCode target ai-sharing is unavailable.
  Last error: managed process exited before readiness.
  Future messages will retry this target, or use /bind <target-id> to switch.
  ```

- If a target fails after a run starts:
  - Let the turn runner finish the run as `error` or `aborted` based on runtime/observer behavior.
  - Expire pending permissions for the run as today.
  - Release the active run lock even if remote abort/probe calls fail.
  - Keep queued messages queued only if the target is expected to recover quickly; recommended Phase 4 default is to start queued messages when the queue drains and let target resolution decide whether to fail fast.
- `/stop` behavior should remain robust:
  - Attempt remote abort with the run's target snapshot.
  - If remote abort fails because the target is down, still release the local active run and report the remote abort failure.
- Health and logs should make it obvious whether failure occurred in:
  - target resolution
  - managed process startup
  - OpenCode HTTP/SDK call
  - event side-channel observation
  - delivery back to the chat channel
- Do not retry normal natural-language prompts automatically in a way that could duplicate side effects unless OpenCode/runtime idempotency is explicitly available.

### 11. Examples, Documentation, And Real Smoke

- Add `examples/config.managed.jsonc` showing:
  - one attach target
  - one managed target
  - two profiles pointing at different targets
  - explicit comments for required environment variables
  - conservative permission settings
- Update `README.md` only if needed to point to Phase 4 managed smoke usage.
- Add a manual smoke path, for example:

  ```bash
  TELEGRAM_BOT_TOKEN=... TELEGRAM_ALLOW_FROM=123456789 \
    OPENAI_API_KEY=... \
    bun run smoke:real -- --config examples/config.managed.jsonc
  ```

- Consider extending `scripts/smoke-real.ts` only after fake integration coverage is solid.
- Smoke acceptance should verify:
  - `/targets` lists attach and managed targets.
  - `/bind <managed-target>` starts or uses managed OpenCode.
  - A normal message reaches the managed target and returns a final answer.
  - `/status` shows explicit bind and healthy target.
  - `/unbind` returns to profile default target.
  - Gateway shutdown stops the managed process.
- Document operational guidance without enforcing policy:
  - one OpenCode server per workspace versus shared server
  - config directory isolation
  - model/agent defaults
  - permission posture for remote control
  - VCS/concurrency safety for managed workspaces
  - backup/retention for gateway and OpenCode state

### 12. Tests

- Config tests:
  - Managed target parses with required `workdir`.
  - Managed target may omit `serverUrl` when supervised.
  - Managed lifecycle defaults are applied.
  - Relative `workdir` and `configDir` remain config-file-relative.
  - Invalid managed port/timeouts fail clearly.
  - Attach target still requires `serverUrl`.
  - Config errors do not leak secret values.
- DB and repository tests:
  - Migration `004_phase_4_multi_target` is idempotent.
  - Existing bindings default to `target_source = 'profile_default'`.
  - Bindings can set and clear explicit target source.
  - Binding target update can preserve or clear agent/model overrides.
  - Pending permission uniqueness is scoped by run.
  - Runs can be listed by target.
- Target supervisor tests with fakes:
  - Attach target probe healthy/unhealthy.
  - Managed target starts and resolves to an effective server URL.
  - Managed target readiness timeout marks unhealthy.
  - Managed target stop is graceful and then forceful after timeout.
  - Managed target crash updates health and schedules restart when configured.
  - Supervisor cleanup stops already-started children after partial startup failure.
- Runtime adapter tests:
  - `OpenCodeRuntime` accepts an effective target with `serverUrl` regardless of original mode.
  - Runtime error messages no longer reference Phase 1 attach-only restrictions.
  - SDK client cache invalidates or keys correctly when a managed target's effective server URL changes.
  - Directory query behavior remains unchanged for `workdir`.
- Dispatch resolver tests:
  - First message creates binding with `profile_default` target source.
  - `/bind` creates a session on selected target and sets `explicit_bind`.
  - `/bind` no-ops clearly when target is unchanged.
  - `/bind` clears unavailable agent/model overrides.
  - `/unbind` clears explicit bind and returns to profile default target.
  - `/unbind` refuses while an active run exists.
  - `/profile` preserves explicit target when allowed.
  - `/profile` follows new profile default target when source is `profile_default`.
  - `/use-session` validates against the current effective target.
- Command tests:
  - `/help` lists `/targets`, `/bind`, and `/unbind`.
  - `/targets` lists targets without creating a binding.
  - `/targets` marks current, explicit, and profile default target.
  - `/bind` requires owner/admin by default.
  - `/unbind` requires owner/admin by default.
  - Command policy helper enforces the default matrix.
  - `/status` includes target source, target health, profile default target, and policy.
- App integration tests:
  - Gateway starts when one target is unhealthy and another is healthy.
  - Message to healthy target still works when another target is unhealthy.
  - Message to unhealthy current target returns a target error without creating a run.
  - Managed target starts before first use or during target resolution.
  - Managed target is stopped on app shutdown.
  - `/bind` during an active run moves future turns while `/stop` still aborts the original run target.
  - Queued messages drain using the current effective target after `/bind` or `/unbind`.
  - Permission approval uses the run target snapshot after binding changes.
- Real smoke:
  - One attach target and one managed target.
  - `/targets`, `/bind`, normal turn, `/status`, `/unbind`, shutdown.

## Target Binding Semantics

Recommended Phase 4 behavior:

- A binding has an active profile and an effective target.
- The effective target either follows the active profile's default target or comes from an explicit `/bind`.
- `/bind` is an explicit target override for the conversation, not a profile switch.
- `/unbind` clears only the explicit target override; it does not delete the whole binding or delete OpenCode sessions.
- `/profile <id>` changes profile defaults but preserves an explicit target when policy allows it.
- If the target changes, create a fresh OpenCode session on the new target by default.
- Old OpenCode sessions remain discoverable through `/sessions` on their target.
- Active runs continue on their snapshotted target.
- Queued messages use the binding state current when they start.

## Managed Target Semantics

Recommended Phase 4 behavior:

- Managed targets are local-first `opencode serve` processes supervised by the gateway.
- Managed targets are started eagerly on gateway startup when configured, but failures are non-fatal by default.
- A managed target can also be started or restarted lazily during target resolution if it is stopped/unhealthy and policy allows retry.
- The gateway owns process lifecycle, health checks, and restart backoff.
- OpenCode still owns agents, tools, permissions, sessions, and model behavior.
- The gateway must not inspect or mutate repository VCS state to make managed mode work.
- The gateway should document concurrency/VCS risks for users running multiple managed OpenCode servers against the same workspace.

## Command Policy Semantics

Recommended Phase 4 behavior:

- Unknown and blocked senders are denied before commands or runtime dispatch, as today.
- Owners and admins can inspect and change targets, sessions, profiles, agents, and models by default.
- Normal users can chat, inspect status, inspect available profiles/targets, stop their own active run, and reset their own session by default.
- Normal users cannot bind targets, switch profiles, use arbitrary sessions, set agents/models, or approve permissions unless policy explicitly allows it.
- Policy logic should be centralized so future commands do not repeat ad hoc role checks.
- The initial policy implementation should be intentionally small and testable.

## Definition Of Done

Phase 4 is done when:

- `bun run typecheck` passes.
- `bun test` passes.
- Config accepts both attach and managed OpenCode targets.
- Managed targets can start `opencode serve`, become healthy, and stop on gateway shutdown.
- Unhealthy targets do not prevent the gateway from serving unrelated healthy targets.
- `/targets` lists configured targets with mode, current/default markers, and health.
- `/bind <target>` explicitly binds the conversation to a target and creates a session there.
- `/unbind` clears the explicit target bind and returns to the active profile's default target.
- `/profile` behavior respects target source semantics.
- `/status` shows target source, target health, and profile default target.
- `/health` exposes live target health instead of static `configured` statuses.
- `/stop` and permission approval still use the run target snapshot after binding/profile changes.
- Agent/model overrides continue to resolve as binding override, profile default, target default, then none.
- Invalid agent/model overrides are cleared or rejected when moving to a target where they are unavailable.
- Command authorization for target/session/profile/agent/model/permission operations is centralized and covered by tests.
- Logs remain structured JSON and do not leak secrets or full sensitive payloads.
- A real smoke can route one conversation to an attach target and another or the same conversation to a managed target.

## Key Decisions

- Proceed with Phase 4 even though Phase 3 Slack/Discord and durable delivery queue are not implemented; multi-target is valuable and orthogonal to channel breadth.
- Keep `OpenCodeRuntime` as the HTTP/SDK adapter and put managed process lifecycle in a separate target supervisor.
- Make target failures non-fatal to gateway startup by default.
- Add an explicit target binding source rather than overloading `conversation_bindings.target_id` with hidden semantics.
- Preserve explicit `/bind` across `/profile` switches when policy allows it.
- Define `/unbind` as clearing the explicit target bind, not deleting the whole binding.
- Start managed targets eagerly for clear operational feedback, while allowing non-fatal unhealthy state and future lazy restart.
- Keep command policy centralized but intentionally small in Phase 4.
- Do not introduce a gateway planner, worker model, intent parser, VCS workflow enforcer, or replacement agent runtime. OpenCode remains the control plane.
