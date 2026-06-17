import type { SendReceipt } from "../channels/types.ts";
import type { Verbosity } from "../config/schema.ts";
import type { OutboundMessage } from "../messages/types.ts";
import type { RuntimeEvent } from "../opencode/types.ts";

export interface ProgressDelivery {
  send(message: OutboundMessage): Promise<SendReceipt | undefined>;
  edit?(receipt: SendReceipt, message: OutboundMessage): Promise<SendReceipt | undefined>;
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
const MAX_TOOL_LINES = 8;
const MAX_VERBOSE_LINES = 12;

export function createProgressRenderer(options: ProgressRendererOptions): ProgressRenderer {
  const delayMs = options.delayMs ?? DEFAULT_PROGRESS_DELAY_MS;
  const detailLines: string[] = [];
  let receipt: SendReceipt | undefined;
  let finalized = false;
  let sentLineCount = 0;
  let lastEditedText: string | undefined;
  let task = Promise.resolve();
  let timer: ReturnType<typeof setTimeout> | undefined;

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
      trimDetailLines(detailLines, options.verbosity);

      if (receipt || !timer) {
        await enqueueFlush();
      }
    },

    async finalize(): Promise<void> {
      finalized = true;
      clearProgressTimer();
      await task.catch((error) => options.onError?.(error));
    },

    cancel(): void {
      finalized = true;
      clearProgressTimer();
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

  async function flushProgress(): Promise<void> {
    if (finalized || options.verbosity === "off") return;

    const message = progressMessage();
    if (!message) return;

    if (receipt && options.edit) {
      if (message.text === lastEditedText) return;

      receipt = (await options.edit(receipt, message)) ?? receipt;
      lastEditedText = message.text;
      sentLineCount = detailLines.length;
      options.onReceipt?.(message, receipt);
      options.onProgress?.(message, receipt);
      return;
    }

    if (receipt) {
      const unsentLines = detailLines.slice(sentLineCount);
      if (unsentLines.length === 0) return;

      const update: OutboundMessage = {
        kind: "progress",
        format: "plain",
        text: unsentLines.join("\n"),
      };

      receipt = (await options.send(update)) ?? receipt;
      sentLineCount = detailLines.length;
      options.onReceipt?.(update, receipt);
      options.onProgress?.(update, receipt);
      return;
    }

    receipt = await options.send(message);
    lastEditedText = message.text;
    sentLineCount = detailLines.length;
    if (receipt) options.onReceipt?.(message, receipt);
    options.onProgress?.(message, receipt);
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
      return `Tool ${event.name} started${summarySuffix(event.summary)}`;
    case "tool_end":
      return `Tool ${event.name} ${event.ok ? "completed" : "failed"}${summarySuffix(event.summary)}`;
    case "tool_update":
      return verbosity === "verbose" ? `Tool ${event.name} updated${summarySuffix(event.summary)}` : undefined;
    case "status":
      return verbosity === "verbose" ? `Status: ${event.status}` : undefined;
    case "text_delta":
    case "permission_request":
    case "question_request":
    case "final":
    case "error":
      return undefined;
  }
}

function summarySuffix(summary: string | undefined): string {
  const trimmed = summary?.trim();

  return trimmed ? `: ${trimmed}` : "";
}

function trimDetailLines(lines: string[], verbosity: Verbosity): void {
  const max = verbosity === "verbose" ? MAX_VERBOSE_LINES : MAX_TOOL_LINES;

  if (lines.length <= max) return;

  lines.splice(0, lines.length - max);
}
