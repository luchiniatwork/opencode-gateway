import type { InboundAttachment, InboundMessage, SendReceipt } from "../channels/types.ts";
import type { DeliveryReceiptRepository } from "../db/repositories/delivery-receipts.ts";
import type { PendingPermissionRepository } from "../db/repositories/pending-permissions.ts";
import type { RunRepository } from "../db/repositories/runs.ts";
import type { ConversationBindingRecord, PendingPermissionRecord, RunRecord } from "../db/types.ts";
import { createProgressRenderer, type ProgressDelivery, type ProgressRenderer } from "../delivery/renderer.ts";
import type { ResolvedDispatch } from "../dispatch/resolver.ts";
import type { OutboundMessage } from "../messages/types.ts";
import type { GatewayLogContext, GatewayLogLevel } from "../observability/logging.ts";
import type { AgentRuntime, RuntimeAttachment, RuntimeEvent, RuntimeTurnHandle } from "../opencode/types.ts";

export interface TurnRunnerOptions {
  runtime: AgentRuntime;
  runs: RunRepository;
  pendingPermissions?: PendingPermissionRepository;
  deliveryReceipts?: DeliveryReceiptRepository;
  progressDelayMs?: number;
  runTimeoutMs?: number;
  startTimeoutMs?: number;
  permissionTtlMs?: number;
  observePermissions?: boolean;
  prepareQueuedTurn?(input: PrepareQueuedTurnInput): Promise<PrepareQueuedTurnResult> | PrepareQueuedTurnResult;
  onPermissionRequest?(input: TurnRunnerPermissionRequestInput): Promise<void> | void;
  now?: () => Date;
  log?: (level: GatewayLogLevel, message: string, context?: GatewayLogContext) => void;
}

export interface TurnRunnerPermissionRequestInput {
  permission: PendingPermissionRecord;
  event: Extract<RuntimeEvent, { type: "permission_request" }>;
  run: RunRecord;
  message: InboundMessage;
  resolution: ResolvedDispatch;
  delivery: ProgressDelivery;
}

export interface RuntimeTurnPlan {
  finalSource: "prompt" | "events";
  progressSource: "none" | "events";
  permissionSource: "none" | "events";
}

export interface ActiveTurnDiagnostics {
  runId: string;
  bindingId: string;
  startedAt: string;
  ageMs: number;
  plan: RuntimeTurnPlan;
  lastEventType?: RuntimeEvent["type"];
  lastEventAt?: string;
}

export interface QueueDiagnostics {
  bindingId: string;
  size: number;
  oldestEnqueuedAt?: string;
  oldestAgeMs?: number;
}

export interface PrepareQueuedTurnInput {
  queuedId: string;
  enqueuedAt: string;
  input: StartTurnInput;
}

export type PrepareQueuedTurnResult =
  | { status: "ready"; input: StartTurnInput }
  | { status: "skip"; reason?: string; messages?: OutboundMessage[] };

export interface StartTurnInput {
  message: InboundMessage;
  resolution: ResolvedDispatch;
  delivery: ProgressDelivery;
  signal?: AbortSignal;
}

export type StartTurnResult =
  | { status: "started"; resolution: ResolvedDispatch; run: RunRecord; handle: RuntimeTurnHandle }
  | { status: "queued"; resolution: ResolvedDispatch; run: RunRecord; queuedId: string; queueSize: number }
  | { status: "busy"; resolution: ResolvedDispatch; run: RunRecord }
  | { status: "error"; resolution: ResolvedDispatch; run: RunRecord; error: string };

export interface AbortActiveTurnInput {
  binding: ConversationBindingRecord;
  target: ResolvedDispatch["target"];
  reason?: string;
}

export type AbortActiveTurnResult =
  | { status: "aborted"; run: RunRecord; remoteAbortError?: string }
  | { status: "no_active_run" }
  | { status: "error"; run: RunRecord; error: string };

export interface TurnRunner {
  start(input: StartTurnInput): Promise<StartTurnResult>;
  abortActive(input: AbortActiveTurnInput): Promise<AbortActiveTurnResult>;
  getActiveDiagnostics(bindingId: string): ActiveTurnDiagnostics | undefined;
  getQueueDiagnostics(bindingId: string): QueueDiagnostics | undefined;
  listQueueDiagnostics(): QueueDiagnostics[];
  stop(): Promise<void>;
}

interface ActiveObserver {
  runId: string;
  bindingId: string;
  startedAt: string;
  plan: RuntimeTurnPlan;
  lastEventType?: RuntimeEvent["type"];
  lastEventAt?: string;
  controller: AbortController;
  task: Promise<void>;
  cleanup(): void;
}

interface RecordedPendingPermission {
  permission: PendingPermissionRecord;
  notify: boolean;
}

interface QueuedTurn {
  id: string;
  enqueuedAt: string;
  input: StartTurnInput;
}

interface PendingPermissionExpiryNotification {
  delivery: ProgressDelivery;
  message: InboundMessage;
  reason: string;
}

export function createTurnRunner(options: TurnRunnerOptions): TurnRunner {
  const { runtime, runs, pendingPermissions, deliveryReceipts } = options;
  const runTimeoutMs = options.runTimeoutMs ?? 5 * 60_000;
  const startTimeoutMs = options.startTimeoutMs ?? 30_000;
  const permissionTtlMs = options.permissionTtlMs ?? 15 * 60_000;
  const observePermissions = options.observePermissions ?? false;
  const now = options.now ?? (() => new Date());
  const activeByRunId = new Map<string, ActiveObserver>();
  const activeRunIdByBindingId = new Map<string, string>();
  const queuedByBindingId = new Map<string, QueuedTurn[]>();
  const drainingBindingIds = new Set<string>();
  let nextQueuedTurnId = 0;
  let stopped = false;

  function log(level: GatewayLogLevel, message: string, context: GatewayLogContext = {}): void {
    options.log?.(level, message, context);
  }

  return {
    async start(input): Promise<StartTurnResult> {
      stopped = false;
      const { message, resolution } = input;
      const activeRun = runs.getActiveByBindingId(resolution.binding.id);

      if (activeRun) {
        if (resolution.binding.busyMode === "queue") {
          const queued = enqueueTurn(input);

          log("info", "turn queued", {
            ...runLogContext(message, resolution, activeRun),
            queuedId: queued.id,
            queueSize: queueSize(resolution.binding.id),
          });

          return {
            status: "queued",
            resolution,
            run: activeRun,
            queuedId: queued.id,
            queueSize: queueSize(resolution.binding.id),
          };
        }

        return { status: "busy", resolution, run: activeRun };
      }

      return startNow(input);
    },

    async abortActive(input): Promise<AbortActiveTurnResult> {
      const run = runs.getActiveByBindingId(input.binding.id);

      if (!run) return { status: "no_active_run" };

      let remoteAbortError: string | undefined;

      try {
        await runtime.abort({
          target: input.target,
          sessionId: run.opencodeSessionId,
          turnId: run.opencodeMessageId,
          reason: input.reason,
        });
      } catch (error) {
        remoteAbortError = formatError(error);

        log("warn", "remote OpenCode abort failed; releasing local run", {
          source: "channel",
          targetId: input.target.id,
          sessionId: run.opencodeSessionId,
          runId: run.id,
          opencodeMessageId: run.opencodeMessageId,
          error: remoteAbortError,
        });
      }

      abortObserver(run.id);
      const aborted = runs.finishIfActive({ id: run.id, status: "aborted", error: remoteAbortError }) ?? runs.getById(run.id) ?? run;
      await expirePendingPermissionsForRun(run.id, {
        source: "channel",
        targetId: input.target.id,
        sessionId: run.opencodeSessionId,
        runId: run.id,
        opencodeMessageId: run.opencodeMessageId,
      });

      log(remoteAbortError ? "warn" : "info", "turn run aborted", {
        source: "channel",
        targetId: input.target.id,
        sessionId: run.opencodeSessionId,
        runId: run.id,
        opencodeMessageId: run.opencodeMessageId,
        remoteAbortError,
      });

      scheduleDrainQueue(input.binding.id);

      return { status: "aborted", run: aborted, remoteAbortError };
    },

    getActiveDiagnostics(bindingId): ActiveTurnDiagnostics | undefined {
      const runId = activeRunIdByBindingId.get(bindingId);
      if (!runId) return undefined;

      const observer = activeByRunId.get(runId);
      if (!observer) return undefined;

      return {
        runId: observer.runId,
        bindingId: observer.bindingId,
        startedAt: observer.startedAt,
        ageMs: Math.max(now().getTime() - Date.parse(observer.startedAt), 0),
        plan: observer.plan,
        lastEventType: observer.lastEventType,
        lastEventAt: observer.lastEventAt,
      };
    },

    getQueueDiagnostics(bindingId): QueueDiagnostics | undefined {
      return queueDiagnostics(bindingId);
    },

    listQueueDiagnostics(): QueueDiagnostics[] {
      return [...queuedByBindingId.keys()]
        .map(queueDiagnostics)
        .filter((diagnostics): diagnostics is QueueDiagnostics => Boolean(diagnostics));
    },

    async stop(): Promise<void> {
      stopped = true;
      const observers = [...activeByRunId.values()];

      queuedByBindingId.clear();

      for (const observer of observers) {
        observer.controller.abort();
      }

      await Promise.allSettled(observers.map((observer) => observer.task));
    },
  };

  async function startNow(input: StartTurnInput): Promise<Exclude<StartTurnResult, { status: "queued" | "busy" }>> {
    const { message, resolution } = input;

    const run = runs.create({
      bindingId: resolution.binding.id,
      targetId: resolution.target.id,
      opencodeSessionId: resolution.binding.opencodeSessionId,
    });
    const baseContext = runLogContext(message, resolution, run);
    const plan = createRuntimeTurnPlan(resolution, observePermissions);

    log("info", "turn run created", { ...baseContext, turnPlan: plan });

    const controller = new AbortController();
    const abortFromParent = () => controller.abort();
    const mode = runtimeTurnMode(plan);

    assertChannelTurnPlan(plan, mode);

    input.signal?.addEventListener("abort", abortFromParent, { once: true });

    try {
      const startTask = runtime.startTurn({
        target: resolution.target,
        sessionId: resolution.binding.opencodeSessionId,
        text: message.text,
        attachments: mapAttachments(message.attachments),
        agent: resolution.agent,
        model: resolution.model,
        metadata: messageMetadata(message),
        mode,
        observePermissions: plan.permissionSource === "events",
        observeProgress: plan.progressSource === "events",
        signal: controller.signal,
      });
      const started = await withStartTimeout(startTask, startTimeoutMs, () => {
        controller.abort();
      });
      const { handle } = started;
      const runWithMessage = runs.setOpenCodeMessageId(run.id, handle.id) ?? { ...run, opencodeMessageId: handle.id };

      log("info", "turn run accepted", { ...baseContext, opencodeMessageId: handle.id });
      observeRun({
        ...input,
        run: runWithMessage,
        handle,
        events: started.events,
        plan,
        controller,
        cleanupParentSignal: () => {
          input.signal?.removeEventListener("abort", abortFromParent);
        },
      });

      return { status: "started", resolution, run: runWithMessage, handle };
    } catch (error) {
      input.signal?.removeEventListener("abort", abortFromParent);
      controller.abort();
      const messageText = formatError(error);
      const finishedRun = runs.finishIfActive({ id: run.id, status: "error", error: messageText }) ?? run;

      log("error", "turn run start failed", { ...baseContext, error: messageText });

      return { status: "error", resolution, run: finishedRun, error: messageText };
    }
  }

  function enqueueTurn(input: StartTurnInput): QueuedTurn {
    const queued: QueuedTurn = {
      id: `queued-${(nextQueuedTurnId += 1)}`,
      enqueuedAt: now().toISOString(),
      input,
    };
    const bindingId = input.resolution.binding.id;
    const queue = queuedByBindingId.get(bindingId) ?? [];

    queue.push(queued);
    queuedByBindingId.set(bindingId, queue);

    return queued;
  }

  async function drainQueue(bindingId: string): Promise<void> {
    if (stopped) return;
    if (drainingBindingIds.has(bindingId)) return;

    const initialQueue = queuedByBindingId.get(bindingId);
    const initialQueueSize = initialQueue?.length ?? 0;
    const firstQueuedTurn = initialQueue?.[0];

    drainingBindingIds.add(bindingId);

    try {
      while (!stopped && !runs.getActiveByBindingId(bindingId)) {
        const queued = dequeueTurn(bindingId);
        if (!queued) return;
        if (queued.input.signal?.aborted) continue;

        const prepared = await prepareQueuedTurnForStart(queued);
        if (prepared.status === "skip") {
          log("info", "queued turn skipped", {
            ...messageLogContext(queued.input.message, queued.input.resolution),
            queuedId: queued.id,
            reason: prepared.reason,
            queueSize: queueSize(bindingId),
          });
          await deliverQueuedSkipMessages(queued, prepared.messages);
          continue;
        }

        if (prepared.input.signal?.aborted) continue;

        log("info", "queued turn starting", {
          ...messageLogContext(prepared.input.message, prepared.input.resolution),
          queuedId: queued.id,
          queueSize: queueSize(bindingId),
        });

        const result = await startNow(prepared.input);

        if (result.status === "started") return;

        await deliverQueuedStartError(queued, prepared.input, result.error);
      }
    } finally {
      if (initialQueueSize > 0 && queueSize(bindingId) === 0) {
        log("info", "queue drained", {
          ...(firstQueuedTurn ? messageLogContext(firstQueuedTurn.input.message, firstQueuedTurn.input.resolution) : { bindingId }),
          bindingId,
          initialQueueSize,
        });
      }

      drainingBindingIds.delete(bindingId);
    }
  }

  async function prepareQueuedTurnForStart(queued: QueuedTurn): Promise<PrepareQueuedTurnResult> {
    if (!options.prepareQueuedTurn) return { status: "ready", input: queued.input };

    try {
      const prepared = await options.prepareQueuedTurn({
        queuedId: queued.id,
        enqueuedAt: queued.enqueuedAt,
        input: queued.input,
      });

      if (prepared.status === "ready") {
        log("info", "queued turn prepared", {
          ...messageLogContext(prepared.input.message, prepared.input.resolution),
          queuedId: queued.id,
        });
      }

      return prepared;
    } catch (error) {
      const message = formatError(error);

      log("error", "queued turn preparation failed", {
        ...messageLogContext(queued.input.message, queued.input.resolution),
        queuedId: queued.id,
        error: message,
      });

      return {
        status: "skip",
        reason: "prepare_failed",
        messages: [{ kind: "error", format: "plain", text: `OpenCode error: ${message}` }],
      };
    }
  }

  function dequeueTurn(bindingId: string): QueuedTurn | undefined {
    const queue = queuedByBindingId.get(bindingId);
    if (!queue) return undefined;

    const queued = queue.shift();
    if (queue.length === 0) queuedByBindingId.delete(bindingId);

    return queued;
  }

  async function deliverQueuedStartError(queued: QueuedTurn, input: StartTurnInput, error: string): Promise<void> {
    try {
      await input.delivery.send({ kind: "error", format: "plain", text: `OpenCode error: ${error}` });
    } catch (deliveryError) {
      log("error", "queued turn start error delivery failed", {
        ...messageLogContext(input.message, input.resolution),
        queuedId: queued.id,
        error: formatError(deliveryError),
      });
    }
  }

  async function deliverQueuedSkipMessages(queued: QueuedTurn, messages: OutboundMessage[] | undefined): Promise<void> {
    if (!messages || messages.length === 0) return;

    for (const message of messages) {
      try {
        await queued.input.delivery.send(message);
      } catch (deliveryError) {
        log("error", "queued turn skip delivery failed", {
          ...messageLogContext(queued.input.message, queued.input.resolution),
          queuedId: queued.id,
          messageKind: message.kind,
          error: formatError(deliveryError),
        });
      }
    }
  }

  function scheduleDrainQueue(bindingId: string): void {
    void drainQueue(bindingId).catch((error) => {
      log("error", "queue drain failed", { bindingId, error: formatError(error) });
    });
  }

  function queueSize(bindingId: string): number {
    return queuedByBindingId.get(bindingId)?.length ?? 0;
  }

  function queueDiagnostics(bindingId: string): QueueDiagnostics | undefined {
    const queue = queuedByBindingId.get(bindingId);
    if (!queue || queue.length === 0) return undefined;

    const oldest = queue[0];

    return {
      bindingId,
      size: queue.length,
      oldestEnqueuedAt: oldest?.enqueuedAt,
      oldestAgeMs: oldest ? Math.max(now().getTime() - Date.parse(oldest.enqueuedAt), 0) : undefined,
    };
  }

  function observeRun(
    input: StartTurnInput & {
      run: RunRecord;
      handle: RuntimeTurnHandle;
      events: AsyncIterable<RuntimeEvent>;
      plan: RuntimeTurnPlan;
      controller: AbortController;
      cleanupParentSignal: () => void;
    },
  ): void {
    const observer: ActiveObserver = {
      runId: input.run.id,
      bindingId: input.resolution.binding.id,
      startedAt: input.run.startedAt,
      plan: input.plan,
      controller: input.controller,
      cleanup() {
        input.cleanupParentSignal();
        activeByRunId.delete(input.run.id);
        if (activeRunIdByBindingId.get(input.resolution.binding.id) === input.run.id) {
          activeRunIdByBindingId.delete(input.resolution.binding.id);
        }
      },
      task: Promise.resolve(),
    };

    const task = runObserver(input, input.controller.signal).finally(async () => {
      observer.cleanup();
      await drainQueue(input.resolution.binding.id);
    });
    observer.task = task;
    activeByRunId.set(input.run.id, observer);
    activeRunIdByBindingId.set(input.resolution.binding.id, input.run.id);

    log("info", "turn run observer started", {
      ...runLogContext(input.message, input.resolution, input.run),
      opencodeMessageId: input.handle.id,
      turnPlan: input.plan,
    });
  }

  async function runObserver(
    input: StartTurnInput & { run: RunRecord; handle: RuntimeTurnHandle; events: AsyncIterable<RuntimeEvent> },
    signal: AbortSignal,
  ): Promise<void> {
    const context = {
      ...runLogContext(input.message, input.resolution, input.run),
      opencodeMessageId: input.handle.id,
    };
    const progress = createProgressRenderer({
      verbosity: input.resolution.binding.verbosity,
      delayMs: options.progressDelayMs,
      send: input.delivery.send,
      edit: input.delivery.edit,
      setTyping: input.delivery.setTyping,
      onProgress: (message) => {
        log("info", "turn run progress sent", { ...context, messageKind: message.kind });
      },
      onReceipt: (message, receipt) => {
        recordDeliveryReceipt(input.run.id, message, receipt, context);
      },
      onError: (error) => {
        log("error", "turn run progress failed", { ...context, error: formatError(error) });
      },
    });
    let timedOut = false;
    let timeoutTask = Promise.resolve();
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutTask = finishTimedOutRun(input, context, progress);
      abortObserver(input.run.id);
    }, runTimeoutMs);

    try {
      for await (const event of input.events) {
        if (timedOut) return;
        if (signal.aborted) return;

        recordObservedEvent(input.run.id, event);

        const terminal = await handleRuntimeEvent(event, input, context, progress);
        if (terminal) return;
      }

      if (timedOut) {
        await timeoutTask;
      } else if (!signal.aborted) {
        await progress.finalize();
        const messageText = "OpenCode event stream ended before a final response.";
        runs.finishIfActive({ id: input.run.id, status: "error", error: messageText, opencodeMessageId: input.handle.id });
        await expirePendingPermissionsForRun(input.run.id, context, {
          delivery: input.delivery,
          message: input.message,
          reason: "the event stream ended before a final response",
        });
        await deliverSafely(input, { kind: "error", format: "plain", text: `OpenCode error: ${messageText}` }, context);
        log("error", "turn run observer ended without final", { ...context, error: messageText });
      }
    } catch (error) {
      if (timedOut) {
        await timeoutTask;
        return;
      }

      if (signal.aborted) return;

      const messageText = formatError(error);
      await progress.finalize();
      runs.finishIfActive({ id: input.run.id, status: "error", error: messageText, opencodeMessageId: input.handle.id });
      await expirePendingPermissionsForRun(input.run.id, context, {
        delivery: input.delivery,
        message: input.message,
        reason: "the observer failed",
      });
      await deliverSafely(input, { kind: "error", format: "plain", text: `OpenCode error: ${messageText}` }, context);
      log("error", "turn run observer failed", { ...context, error: messageText });
    } finally {
      clearTimeout(timeout);
      await timeoutTask.catch((error) => log("error", "turn run timeout handling failed", { ...context, error: formatError(error) }));
      progress.cancel();
      log("info", "turn run observer stopped", context);
    }
  }

  async function finishTimedOutRun(
    input: StartTurnInput & { run: RunRecord; handle: RuntimeTurnHandle },
    context: GatewayLogContext,
    progress: ProgressRenderer,
  ): Promise<void> {
    const messageText = `OpenCode did not produce a final response within ${runTimeoutMs}ms.`;

    await progress.finalize();
    const finished = runs.finishIfActive({ id: input.run.id, status: "error", error: messageText, opencodeMessageId: input.handle.id });
    if (!finished) return;

    await expirePendingPermissionsForRun(input.run.id, context, {
      delivery: input.delivery,
      message: input.message,
      reason: "the run timed out",
    });
    await deliverSafely(input, { kind: "error", format: "plain", text: `OpenCode error: ${messageText}` }, context);
    log("error", "turn run timed out", { ...context, error: messageText });
  }

  async function handleRuntimeEvent(
    event: RuntimeEvent,
    input: StartTurnInput & { run: RunRecord; handle: RuntimeTurnHandle },
    context: GatewayLogContext,
    progress: ProgressRenderer,
  ): Promise<boolean> {
    switch (event.type) {
      case "final": {
        await progress.finalize();
        await deliverSafely(
          input,
          {
            kind: "final",
            format: "markdown",
            text: event.text?.trim() || "OpenCode completed without a text response.",
          },
          context,
        );
        runs.finishIfActive({ id: input.run.id, status: "completed", opencodeMessageId: input.handle.id });
        await expirePendingPermissionsForRun(input.run.id, context, {
          delivery: input.delivery,
          message: input.message,
          reason: "the run completed",
        });
        log("info", "turn run final sent", context);
        return true;
      }
      case "error": {
        await progress.finalize();
        runs.finishIfActive({ id: input.run.id, status: "error", error: event.message, opencodeMessageId: input.handle.id });
        await expirePendingPermissionsForRun(input.run.id, context, {
          delivery: input.delivery,
          message: input.message,
          reason: "the run failed",
        });
        await deliverSafely(input, { kind: "error", format: "plain", text: `OpenCode error: ${event.message}` }, context);
        log("error", "turn run failed", { ...context, error: event.message, retryable: event.retryable });
        return true;
      }
      case "permission_request": {
        const recorded = recordPendingPermission(input.run.id, event, context);

        if (recorded?.notify) {
          await notifyPermissionRequest({
            permission: recorded.permission,
            event,
            run: input.run,
            message: input.message,
            resolution: input.resolution,
            delivery: input.delivery,
          }, context);
        }

        await progress.handle(event);
        return false;
      }
      case "status":
        if (event.status === "aborted") {
          progress.cancel();
          runs.finishIfActive({ id: input.run.id, status: "aborted", opencodeMessageId: input.handle.id });
          await expirePendingPermissionsForRun(input.run.id, context, {
            delivery: input.delivery,
            message: input.message,
            reason: "the run was aborted",
          });
          log("info", "turn run observed abort", context);
          return true;
        }

        if (event.status === "error") {
          await progress.finalize();
          const message = "OpenCode session reported an error.";
          runs.finishIfActive({ id: input.run.id, status: "error", error: message, opencodeMessageId: input.handle.id });
          await expirePendingPermissionsForRun(input.run.id, context, {
            delivery: input.delivery,
            message: input.message,
            reason: "the session reported an error",
          });
          await deliverSafely(input, { kind: "error", format: "plain", text: `OpenCode error: ${message}` }, context);
          log("error", "turn run observed error status", context);
          return true;
        }

        await progress.handle(event);
        return false;
      default:
        await progress.handle(event);
        return false;
    }
  }

  async function deliverSafely(
    input: StartTurnInput & { run: RunRecord },
    message: OutboundMessage,
    context: GatewayLogContext,
  ): Promise<SendReceipt | undefined> {
    try {
      const receipt = await input.delivery.send(message);
      if (receipt) recordDeliveryReceipt(input.run.id, message, receipt, context);
      return receipt;
    } catch (error) {
      log("error", "turn run delivery failed", { ...context, error: formatError(error), messageKind: message.kind });
      return undefined;
    }
  }

  function recordPendingPermission(
    runId: string,
    event: Extract<RuntimeEvent, { type: "permission_request" }>,
    context: GatewayLogContext,
  ): RecordedPendingPermission | undefined {
    if (!pendingPermissions) return undefined;
    const existing = pendingPermissions.getByOpenCodePermissionId(event.id);
    if (existing?.status === "pending" && existing.runId === runId && existing.actionMessageReceiptId) {
      log("info", "turn run permission request already has an action card", {
        ...context,
        permissionId: existing.id,
        opencodePermissionId: event.id,
      });

      return { permission: existing, notify: false };
    }

    if (existing && existing.status !== "pending") {
      log("info", "turn run permission request already resolved", {
        ...context,
        permissionId: existing.id,
        opencodePermissionId: event.id,
        previousRunId: existing.runId,
        previousStatus: existing.status,
      });

      return { permission: existing, notify: false };
    }

    const expiresAt = new Date(now().getTime() + permissionTtlMs).toISOString();

    try {
      const permission = pendingPermissions.upsertByOpenCodePermissionId({
        runId,
        opencodePermissionId: event.id,
        summary: event.summary,
        details: event.details,
        expiresAt,
      });

      log(existing ? "warn" : "info", existing ? "turn run permission request refreshed" : "turn run permission requested", {
        ...context,
        permissionId: permission.id,
        opencodePermissionId: event.id,
        previousRunId: existing?.runId,
        previousStatus: existing?.status,
      });

      return { permission, notify: true };
    } catch (error) {
      log("error", "turn run permission persistence failed", {
        ...context,
        opencodePermissionId: event.id,
        error: formatError(error),
      });
      return undefined;
    }
  }

  async function notifyPermissionRequest(
    input: TurnRunnerPermissionRequestInput,
    context: GatewayLogContext,
  ): Promise<void> {
    if (!options.onPermissionRequest) return;

    try {
      await options.onPermissionRequest(input);
    } catch (error) {
      log("error", "turn run permission notification failed", {
        ...context,
        permissionId: input.permission.id,
        opencodePermissionId: input.event.id,
        error: formatError(error),
      });
    }
  }

  function recordDeliveryReceipt(
    runId: string,
    message: OutboundMessage,
    receipt: SendReceipt,
    context: GatewayLogContext,
  ): void {
    if (!deliveryReceipts) return;

    try {
      deliveryReceipts.create({
        runId,
        channel: receipt.channel,
        accountId: receipt.accountId,
        conversationKey: receipt.conversationKey,
        platformMessageId: receipt.platformMessageId,
        kind: message.kind,
      });
    } catch (error) {
      log("error", "turn run delivery receipt persistence failed", {
        ...context,
        messageKind: message.kind,
        platformMessageId: receipt.platformMessageId,
        error: formatError(error),
      });
    }
  }

  async function expirePendingPermissionsForRun(
    runId: string,
    context: GatewayLogContext,
    notification?: PendingPermissionExpiryNotification,
  ): Promise<void> {
    if (!pendingPermissions) return;

    try {
      const expired = pendingPermissions.expirePendingByRunId(runId);
      if (expired.length === 0) return;

      log("info", "turn run pending permissions expired", {
        ...context,
        pendingPermissionIds: expired.map((permission) => permission.id),
      });

      if (notification) {
        for (const permission of expired) {
          await notifyExpiredPermission(permission, notification, context);
        }
      }
    } catch (error) {
      log("error", "turn run pending permission expiration failed", {
        ...context,
        error: formatError(error),
      });
    }
  }

  async function notifyExpiredPermission(
    permission: PendingPermissionRecord,
    notification: PendingPermissionExpiryNotification,
    context: GatewayLogContext,
  ): Promise<void> {
    if (!permission.actionMessageReceiptId) return;

    const message = expiredPermissionMessage(permission, notification.reason);

    if (notification.delivery.edit) {
      try {
        await notification.delivery.edit(expiredPermissionReceipt(permission, notification.message), message);
        log("info", "permission request card expired", { ...context, permissionId: permission.id });
        return;
      } catch (error) {
        log("warn", "permission request expiry edit failed", {
          ...context,
          permissionId: permission.id,
          error: formatError(error),
        });
      }
    }

    try {
      const receipt = await notification.delivery.send(message);
      if (receipt) recordDeliveryReceipt(permission.runId, message, receipt, context);
    } catch (error) {
      log("error", "permission request expiry delivery failed", {
        ...context,
        permissionId: permission.id,
        error: formatError(error),
      });
    }
  }

  function abortObserver(runId: string): void {
    const observer = activeByRunId.get(runId);
    if (!observer) return;

    observer.controller.abort();
    observer.cleanup();
  }

  function recordObservedEvent(runId: string, event: RuntimeEvent): void {
    const observer = activeByRunId.get(runId);
    if (!observer) return;

    observer.lastEventType = event.type;
    observer.lastEventAt = now().toISOString();
  }
}

function runLogContext(message: InboundMessage, resolution: ResolvedDispatch, run: RunRecord): GatewayLogContext {
  return {
    ...messageLogContext(message, resolution),
    runId: run.id,
  };
}

function messageLogContext(message: InboundMessage, resolution: ResolvedDispatch): GatewayLogContext {
  return {
    source: "channel",
    channel: message.channel,
    accountId: message.accountId,
    conversationKey: message.conversation.key,
    profileId: resolution.profile.id,
    targetId: resolution.target.id,
    sessionId: resolution.binding.opencodeSessionId,
  };
}

function mapAttachments(attachments: InboundAttachment[]): RuntimeAttachment[] | undefined {
  if (attachments.length === 0) return undefined;

  return attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    url: attachment.url,
  }));
}

function messageMetadata(message: InboundMessage): Record<string, unknown> {
  return {
    channel: message.channel,
    accountId: message.accountId,
    conversationKey: message.conversation.key,
    senderId: message.sender.id,
  };
}

function expiredPermissionMessage(permission: PendingPermissionRecord, reason: string): OutboundMessage {
  return {
    kind: "status",
    format: "markdown",
    text: `⌛ Permission request ${permission.id} expired because ${reason}.`,
  };
}

function expiredPermissionReceipt(permission: PendingPermissionRecord, message: InboundMessage): SendReceipt {
  return {
    channel: message.channel,
    accountId: message.accountId,
    conversationKey: message.conversation.key,
    platformMessageId: permission.actionMessageReceiptId ?? "",
    timestamp: message.timestamp,
    raw: { chatId: message.conversation.id },
  };
}

function createRuntimeTurnPlan(resolution: ResolvedDispatch, observePermissions: boolean): RuntimeTurnPlan {
  const observesProgress = resolution.binding.verbosity === "tools" || resolution.binding.verbosity === "verbose";

  return {
    // ADR 0001: verbosity changes side-channel progress rendering, not final-answer delivery.
    finalSource: "prompt",
    progressSource: observesProgress ? "events" : "none",
    permissionSource: observePermissions ? "events" : "none",
  };
}

function runtimeTurnMode(plan: RuntimeTurnPlan): "sync" | "async" {
  return plan.finalSource === "events" ? "async" : "sync";
}

function assertChannelTurnPlan(plan: RuntimeTurnPlan, mode: "sync" | "async"): void {
  if (plan.finalSource === "prompt" && mode === "sync") return;

  throw new Error(
    "Invalid channel turn plan: final answers must use the prompt path; event streams are progress/permission side channels only.",
  );
}

async function withStartTimeout<T>(task: Promise<T>, timeoutMs: number, onTimeout: () => void): Promise<T> {
  if (timeoutMs <= 0) return task;

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutTask = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      onTimeout();
      reject(new Error(`OpenCode did not accept the turn within ${timeoutMs}ms.`));
    }, timeoutMs);
  });

  task.catch(() => undefined);

  return Promise.race([task, timeoutTask]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
