import type { SendReceipt, TypingState } from "../channels/types.ts";
import type { Verbosity } from "../config/schema.ts";
import type { OutboundMessage } from "../messages/types.ts";
import type { RuntimeEvent } from "../opencode/types.ts";

export interface ProgressDelivery {
  send(message: OutboundMessage): Promise<SendReceipt | undefined>;
  edit?(receipt: SendReceipt, message: OutboundMessage): Promise<SendReceipt | undefined>;
  setTyping?(state: TypingState): Promise<void>;
}

export interface ProgressRendererOptions extends ProgressDelivery {
  verbosity: Verbosity;
  delayMs?: number;
  onProgress?(message: OutboundMessage, receipt?: SendReceipt): void;
  onReceipt?(message: OutboundMessage, receipt: SendReceipt): void;
  onError?(error: unknown): void;
}

export interface ProgressRenderer {
  handle(event: RuntimeEvent): Promise<void>;
  finalize(): Promise<void>;
  cancel(): void;
}

const DEFAULT_PROGRESS_DELAY_MS = 2_000;
const TYPING_KEEPALIVE_MS = 4_000;

export function createProgressRenderer(options: ProgressRendererOptions): ProgressRenderer {
  const delayMs = options.delayMs ?? DEFAULT_PROGRESS_DELAY_MS;
  const detailLines: string[] = [];
  let receipt: SendReceipt | undefined;
  let finalized = false;
  let sentLineCount = 0;
  let lastEditedText: string | undefined;
  let editUnavailable = false;
  let task = Promise.resolve();
  let typingTask = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let typingTimer: ReturnType<typeof setInterval> | undefined;
  let typingStarted = false;
  let typingStopped = false;

  if (options.verbosity !== "off" && options.setTyping) {
    startTypingIndicator();
  }

  if (options.verbosity === "tools" || options.verbosity === "verbose") {
    timer = setTimeout(() => {
      timer = undefined;
      void enqueueFlush();
    }, delayMs);
  }

  return {
    async handle(event): Promise<void> {
      if (finalized || options.verbosity === "off" || options.verbosity === "compact") return;

      const line = progressLine(event, options.verbosity);
      if (!line) return;

      detailLines.push(line);

      if (receipt || !timer) {
        await enqueueFlush();
      }
    },

    async finalize(): Promise<void> {
      finalized = true;
      clearProgressTimer();
      await Promise.all([
        task.catch((error) => options.onError?.(error)),
        stopTypingIndicator(),
      ]);
    },

    cancel(): void {
      finalized = true;
      clearProgressTimer();
      void stopTypingIndicator();
    },
  };

  function clearProgressTimer(): void {
    if (!timer) return;

    clearTimeout(timer);
    timer = undefined;
  }

  function enqueueFlush(): Promise<void> {
    task = task.then(flushProgress, flushProgress).catch((error) => {
      options.onError?.(error);
    });

    return task;
  }

  function startTypingIndicator(): void {
    typingStarted = true;
    void enqueueTyping("typing");
    typingTimer = setInterval(() => {
      void enqueueTyping("typing");
    }, TYPING_KEEPALIVE_MS);
  }

  function stopTypingIndicator(): Promise<void> {
    if (!typingStarted) return typingTask;
    if (typingStopped) return typingTask;

    typingStopped = true;
    clearTypingTimer();
    return enqueueTyping("idle");
  }

  function clearTypingTimer(): void {
    if (!typingTimer) return;

    clearInterval(typingTimer);
    typingTimer = undefined;
  }

  function enqueueTyping(state: TypingState): Promise<void> {
    const setTyping = options.setTyping;
    if (!setTyping) return Promise.resolve();

    typingTask = typingTask.then(() => setTyping(state), () => setTyping(state)).catch((error) => {
      options.onError?.(error);
    });

    return typingTask;
  }

  async function flushProgress(): Promise<void> {
    if (finalized || options.verbosity === "off") return;

    const message = progressMessage();
    if (!message) return;

    if (receipt && options.edit && !editUnavailable) {
      if (message.text === lastEditedText) return;

      try {
        receipt = (await options.edit(receipt, message)) ?? receipt;
        lastEditedText = message.text;
        sentLineCount = detailLines.length;
        options.onReceipt?.(message, receipt);
        options.onProgress?.(message, receipt);
        return;
      } catch (error) {
        editUnavailable = true;
        options.onError?.(error);
        await sendSparseProgress();
        return;
      }
    }

    if (receipt) {
      await sendSparseProgress();
      return;
    }

    receipt = await options.send(message);
    lastEditedText = message.text;
    sentLineCount = detailLines.length;
    if (receipt) options.onReceipt?.(message, receipt);
    options.onProgress?.(message, receipt);
  }

  async function sendSparseProgress(): Promise<void> {
    const unsentLines = detailLines.slice(sentLineCount);
    if (unsentLines.length === 0) return;

    const update: OutboundMessage = {
      kind: "progress",
      format: "plain",
      text: unsentLines.join("\n"),
    };

    receipt = (await options.send(update)) ?? receipt;
    sentLineCount = detailLines.length;
    if (receipt) options.onReceipt?.(update, receipt);
    options.onProgress?.(update, receipt);
  }

  function progressMessage(): OutboundMessage | undefined {
    const lines = detailLines;
    const text = lines.join("\n").trim();

    if (!text) return undefined;

    return {
      kind: "progress",
      format: "plain",
      text,
    };
  }
}

function progressLine(event: RuntimeEvent, verbosity: Verbosity): string | undefined {
  if (verbosity === "off" || verbosity === "compact") return undefined;

  switch (event.type) {
    case "tool_start":
      return `Tool ${toolLabel(event, verbosity)} started${summarySuffix(event.summary)}`;
    case "tool_end":
      return `Tool ${toolLabel(event, verbosity)} ${event.ok ? "completed" : "failed"}${summarySuffix(event.summary)}`;
    case "tool_update":
      return verbosity === "verbose" ? `Tool ${toolLabel(event, verbosity)} updated${summarySuffix(event.summary)}` : undefined;
    case "status":
      return verbosity === "verbose" ? `Status: ${event.status}` : undefined;
    case "permission_request":
      return verbosity === "verbose" ? `Permission requested (${event.id}): ${event.summary}` : undefined;
    case "question_request":
      return verbosity === "verbose" ? `Question requested (${event.id}): ${event.prompt}` : undefined;
    case "text_delta":
    case "final":
    case "error":
      return undefined;
  }
}

function summarySuffix(summary: string | undefined): string {
  const trimmed = summary?.trim();

  return trimmed ? `: ${trimmed}` : "";
}

function toolLabel(event: { id: string; name: string }, verbosity: Verbosity): string {
  return verbosity === "verbose" ? `${event.name} (${event.id})` : event.name;
}
