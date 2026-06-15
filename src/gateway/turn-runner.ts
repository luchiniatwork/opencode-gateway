import type { InboundAttachment, InboundMessage, SendReceipt } from "../channels/types.ts";
import type { DeliveryReceiptRepository } from "../db/repositories/delivery-receipts.ts";
import type { PendingPermissionRepository } from "../db/repositories/pending-permissions.ts";
import type { RunRepository } from "../db/repositories/runs.ts";
import type { ConversationBindingRecord, RunRecord } from "../db/types.ts";
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
  permissionTtlMs?: number;
  now?: () => Date;
  log?: (level: GatewayLogLevel, message: string, context?: GatewayLogContext) => void;
}

export interface StartTurnInput {
  message: InboundMessage;
  resolution: ResolvedDispatch;
  delivery: ProgressDelivery;
  signal?: AbortSignal;
}

export type StartTurnResult =
  | { status: "started"; resolution: ResolvedDispatch; run: RunRecord; handle: RuntimeTurnHandle }
  | { status: "busy"; resolution: ResolvedDispatch; run: RunRecord }
  | { status: "error"; resolution: ResolvedDispatch; run: RunRecord; error: string };

export interface AbortActiveTurnInput {
  binding: ConversationBindingRecord;
  target: ResolvedDispatch["target"];
  reason?: string;
}

export type AbortActiveTurnResult =
  | { status: "aborted"; run: RunRecord }
  | { status: "no_active_run" }
  | { status: "error"; run: RunRecord; error: string };

export interface TurnRunner {
  start(input: StartTurnInput): Promise<StartTurnResult>;
  abortActive(input: AbortActiveTurnInput): Promise<AbortActiveTurnResult>;
  stop(): Promise<void>;
}

interface ActiveObserver {
  runId: string;
  bindingId: string;
  controller: AbortController;
  task: Promise<void>;
  cleanup(): void;
}

export function createTurnRunner(options: TurnRunnerOptions): TurnRunner {
  const { runtime, runs, pendingPermissions, deliveryReceipts } = options;
  const runTimeoutMs = options.runTimeoutMs ?? 5 * 60_000;
  const permissionTtlMs = options.permissionTtlMs ?? 15 * 60_000;
  const now = options.now ?? (() => new Date());
  const activeByRunId = new Map<string, ActiveObserver>();
  const activeRunIdByBindingId = new Map<string, string>();

  function log(level: GatewayLogLevel, message: string, context: GatewayLogContext = {}): void {
    options.log?.(level, message, context);
  }

  return {
    async start(input): Promise<StartTurnResult> {
      const { message, resolution } = input;
      const activeRun = runs.getActiveByBindingId(resolution.binding.id);

      if (activeRun) return { status: "busy", resolution, run: activeRun };

      const run = runs.create({
        bindingId: resolution.binding.id,
        opencodeSessionId: resolution.binding.opencodeSessionId,
      });
      const baseContext = runLogContext(message, resolution, run);

      log("info", "async run created", baseContext);

      const controller = new AbortController();
      const abortFromParent = () => controller.abort();

      input.signal?.addEventListener("abort", abortFromParent, { once: true });

      try {
        const started = await runtime.startTurn({
          target: resolution.target,
          sessionId: resolution.binding.opencodeSessionId,
          text: message.text,
          attachments: mapAttachments(message.attachments),
          agent: resolution.agent,
          model: resolution.model,
          metadata: messageMetadata(message),
          signal: controller.signal,
        });
        const { handle } = started;
        const runWithMessage = runs.setOpenCodeMessageId(run.id, handle.id) ?? { ...run, opencodeMessageId: handle.id };

        log("info", "async run accepted", { ...baseContext, opencodeMessageId: handle.id });
        observeRun({
          ...input,
          run: runWithMessage,
          handle,
          events: started.events,
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

        log("error", "async run start failed", { ...baseContext, error: messageText });

        return { status: "error", resolution, run: finishedRun, error: messageText };
      }
    },

    async abortActive(input): Promise<AbortActiveTurnResult> {
      const run = runs.getActiveByBindingId(input.binding.id);

      if (!run) return { status: "no_active_run" };

      try {
        await runtime.abort({
          target: input.target,
          sessionId: run.opencodeSessionId,
          turnId: run.opencodeMessageId,
          reason: input.reason,
        });
        abortObserver(run.id);
        const aborted = runs.finishIfActive({ id: run.id, status: "aborted" }) ?? runs.getById(run.id) ?? run;

        log("info", "async run aborted", {
          source: "channel",
          targetId: input.target.id,
          sessionId: run.opencodeSessionId,
          runId: run.id,
          opencodeMessageId: run.opencodeMessageId,
        });

        return { status: "aborted", run: aborted };
      } catch (error) {
        const messageText = formatError(error);

        log("error", "async run abort failed", {
          source: "channel",
          targetId: input.target.id,
          sessionId: run.opencodeSessionId,
          runId: run.id,
          opencodeMessageId: run.opencodeMessageId,
          error: messageText,
        });

        return { status: "error", run, error: messageText };
      }
    },

    async stop(): Promise<void> {
      const observers = [...activeByRunId.values()];

      for (const observer of observers) {
        observer.controller.abort();
      }

      await Promise.allSettled(observers.map((observer) => observer.task));
    },
  };

  function observeRun(
    input: StartTurnInput & {
      run: RunRecord;
      handle: RuntimeTurnHandle;
      events: AsyncIterable<RuntimeEvent>;
      controller: AbortController;
      cleanupParentSignal: () => void;
    },
  ): void {
    const observer: ActiveObserver = {
      runId: input.run.id,
      bindingId: input.resolution.binding.id,
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

    const task = runObserver(input, input.controller.signal).finally(() => observer.cleanup());
    observer.task = task;
    activeByRunId.set(input.run.id, observer);
    activeRunIdByBindingId.set(input.resolution.binding.id, input.run.id);

    log("info", "async run observer started", {
      ...runLogContext(input.message, input.resolution, input.run),
      opencodeMessageId: input.handle.id,
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
      onProgress: (message) => {
        log("info", "async run progress sent", { ...context, messageKind: message.kind });
      },
      onReceipt: (message, receipt) => {
        recordDeliveryReceipt(input.run.id, message, receipt, context);
      },
      onError: (error) => {
        log("error", "async run progress failed", { ...context, error: formatError(error) });
      },
    });
    let timedOut = false;
    let timeoutTask = Promise.resolve();
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutTask = finishTimedOutRun(input, context, progress);
      activeByRunId.get(input.run.id)?.controller.abort();
      activeByRunId.delete(input.run.id);
      if (activeRunIdByBindingId.get(input.resolution.binding.id) === input.run.id) {
        activeRunIdByBindingId.delete(input.resolution.binding.id);
      }
    }, runTimeoutMs);

    try {
      for await (const event of input.events) {
        if (timedOut) return;
        if (signal.aborted) return;

        const terminal = await handleRuntimeEvent(event, input, context, progress);
        if (terminal) return;
      }

      if (timedOut) {
        await timeoutTask;
      } else if (!signal.aborted) {
        await progress.finalize();
        const messageText = "OpenCode event stream ended before a final response.";
        runs.finishIfActive({ id: input.run.id, status: "error", error: messageText, opencodeMessageId: input.handle.id });
        await deliverSafely(input, { kind: "error", format: "plain", text: `OpenCode error: ${messageText}` }, context);
        log("error", "async run observer ended without final", { ...context, error: messageText });
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
      await deliverSafely(input, { kind: "error", format: "plain", text: `OpenCode error: ${messageText}` }, context);
      log("error", "async run observer failed", { ...context, error: messageText });
    } finally {
      clearTimeout(timeout);
      await timeoutTask.catch((error) => log("error", "async run timeout handling failed", { ...context, error: formatError(error) }));
      progress.cancel();
      log("info", "async run observer stopped", context);
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

    await deliverSafely(input, { kind: "error", format: "plain", text: `OpenCode error: ${messageText}` }, context);
    log("error", "async run timed out", { ...context, error: messageText });
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
        log("info", "async run final sent", context);
        return true;
      }
      case "error": {
        await progress.finalize();
        runs.finishIfActive({ id: input.run.id, status: "error", error: event.message, opencodeMessageId: input.handle.id });
        await deliverSafely(input, { kind: "error", format: "plain", text: `OpenCode error: ${event.message}` }, context);
        log("error", "async run failed", { ...context, error: event.message, retryable: event.retryable });
        return true;
      }
      case "permission_request": {
        recordPendingPermission(input.run.id, event, context);
        await progress.handle(event);
        return false;
      }
      case "status":
        if (event.status === "aborted") {
          progress.cancel();
          runs.finishIfActive({ id: input.run.id, status: "aborted", opencodeMessageId: input.handle.id });
          log("info", "async run observed abort", context);
          return true;
        }

        if (event.status === "error") {
          await progress.finalize();
          const message = "OpenCode session reported an error.";
          runs.finishIfActive({ id: input.run.id, status: "error", error: message, opencodeMessageId: input.handle.id });
          await deliverSafely(input, { kind: "error", format: "plain", text: `OpenCode error: ${message}` }, context);
          log("error", "async run observed error status", context);
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
      log("error", "async run delivery failed", { ...context, error: formatError(error), messageKind: message.kind });
      return undefined;
    }
  }

  function recordPendingPermission(
    runId: string,
    event: Extract<RuntimeEvent, { type: "permission_request" }>,
    context: GatewayLogContext,
  ): void {
    if (!pendingPermissions) return;
    if (pendingPermissions.getByOpenCodePermissionId(event.id)) return;

    const expiresAt = new Date(now().getTime() + permissionTtlMs).toISOString();

    try {
      const permission = pendingPermissions.create({
        runId,
        opencodePermissionId: event.id,
        summary: event.summary,
        details: event.details,
        expiresAt,
      });

      log("info", "async run permission requested", {
        ...context,
        permissionId: permission.id,
        opencodePermissionId: event.id,
      });
    } catch (error) {
      log("error", "async run permission persistence failed", {
        ...context,
        opencodePermissionId: event.id,
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
      log("error", "async run delivery receipt persistence failed", {
        ...context,
        messageKind: message.kind,
        platformMessageId: receipt.platformMessageId,
        error: formatError(error),
      });
    }
  }

  function abortObserver(runId: string): void {
    activeByRunId.get(runId)?.controller.abort();
  }
}

function runLogContext(message: InboundMessage, resolution: ResolvedDispatch, run: RunRecord): GatewayLogContext {
  return {
    source: "channel",
    channel: message.channel,
    accountId: message.accountId,
    conversationKey: message.conversation.key,
    profileId: resolution.profile.id,
    targetId: resolution.target.id,
    sessionId: resolution.binding.opencodeSessionId,
    runId: run.id,
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

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
