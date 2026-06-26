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
      if (finalized) return;
      clearProgressTimer();

      if (options.verbosity === "tools" || options.verbosity === "verbose") {
        await enqueueFlush();
      }

      finalized = true;
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
  switch (verbosity) {
    case "off":
    case "compact":
      return undefined;
    case "tools":
      return toolProgressLine(event);
    case "verbose":
      return verboseProgressLine(event);
  }
}

function toolProgressLine(event: RuntimeEvent): string | undefined {
  switch (event.type) {
    case "tool_start":
      return toolLifecycleLine(event, "started", { includeId: false });
    case "tool_update":
      return event.category === "subagent" ? toolLifecycleLine(event, "updated", { includeId: false }) : undefined;
    case "tool_end":
      return toolLifecycleLine(event, toolEndAction(event), { includeId: false });
    case "todo_update":
      return todoProgressLine(event, false);
    case "status":
    case "diagnostic":
    case "permission_request":
    case "question_request":
    case "text_delta":
    case "final":
    case "error":
      return undefined;
  }
}

function verboseProgressLine(event: RuntimeEvent): string | undefined {
  switch (event.type) {
    case "status":
      return `Status: ${event.status}`;
    case "tool_start":
      return toolLifecycleLine(event, "started", { includeId: true });
    case "tool_update":
      return toolLifecycleLine(event, "updated", { includeId: true });
    case "tool_end":
      return toolLifecycleLine(event, toolEndAction(event), { includeId: true });
    case "todo_update":
      return todoProgressLine(event, true);
    case "diagnostic":
      return `${event.label}${summarySuffix(event.summary)}`;
    case "permission_request":
      return `Permission requested (${event.id}): ${event.summary}`;
    case "question_request":
      return `Question requested (${event.id}): ${event.prompt}`;
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

function toolLabel(event: { id: string; name: string }): string {
  return `${event.name} (${event.id})`;
}

function toolLifecycleLine(
  event: Extract<RuntimeEvent, { type: "tool_start" | "tool_update" | "tool_end" }>,
  action: string,
  options: { includeId: boolean },
): string {
  return `${toolEventLabel(event, options)} ${action}${summarySuffix(event.summary)}`;
}

function toolEventLabel(event: { id: string; name: string; category?: "tool" | "skill" | "subagent" }, options: { includeId: boolean }): string {
  const name = options.includeId ? toolLabel(event) : event.name;

  if (event.category === "skill") return `Skill ${name}`;
  if (event.category === "subagent") return `Subagent ${name}`;
  return `Tool ${name}`;
}

function toolEndAction(event: Extract<RuntimeEvent, { type: "tool_end" }>): string {
  if (!event.ok) return "failed";
  if (event.category === "skill") return "loaded";
  return "completed";
}

function todoProgressLine(event: Extract<RuntimeEvent, { type: "todo_update" }>, verbose: boolean): string {
  const title = event.source === "subagent" ? "Subagent todos" : "Todos";
  if (event.todos.length === 0) return `${title}: none`;

  const limit = verbose ? event.todos.length : 5;
  const visible = event.todos.slice(0, limit).map((todo) => todoLine(todo));
  const hidden = event.todos.length - visible.length;

  return [
    `${title}:`,
    ...visible,
    hidden > 0 ? `... ${hidden} more` : undefined,
  ].filter((line): line is string => Boolean(line)).join("\n");
}

function todoLine(todo: { content: string; status: string; priority?: string }): string {
  const priority = todo.priority ? ` (${todo.priority})` : "";
  return `${todoStatusMarker(todo.status)} ${todo.content}${priority}`;
}

function todoStatusMarker(status: string): string {
  switch (status) {
    case "completed":
      return "[x]";
    case "in_progress":
      return "[~]";
    case "cancelled":
      return "[-]";
    case "pending":
      return "[ ]";
    default:
      return "[?]";
  }
}
