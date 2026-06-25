import type { InboundMessage } from "../channels/types.ts";

export type DebounceFlushReason = "timer" | "manual" | "stop";

export interface DebounceInput<TContext> {
  message: InboundMessage;
  context: TContext;
}

export interface DebouncedMessage<TContext> {
  conversationKey: string;
  message: InboundMessage;
  context: TContext;
  messageCount: number;
  firstMessageId: string;
  lastMessageId: string;
  queuedAt: string;
  flushedAt: string;
  reason: DebounceFlushReason;
}

export interface DebounceEnqueueResult {
  conversationKey: string;
  messageCount: number;
  firstMessageId: string;
  lastMessageId: string;
  queuedAt: string;
  flushAfterMs: number;
}

export interface InboundMessageDebouncer<TContext> {
  enqueue(input: DebounceInput<TContext>): DebounceEnqueueResult;
  flush(conversationKey: string, reason?: DebounceFlushReason): Promise<DebouncedMessage<TContext> | undefined>;
  flushAll(reason?: DebounceFlushReason): Promise<Array<DebouncedMessage<TContext>>>;
  stop(): Promise<Array<DebouncedMessage<TContext>>>;
  pendingCount(): number;
}

export interface InboundMessageDebouncerOptions<TContext> {
  delayMs: number;
  now?: () => Date;
  onFlush(input: DebouncedMessage<TContext>): Promise<void> | void;
  onError?(error: unknown, input: DebouncedMessage<TContext>): Promise<void> | void;
}

interface PendingDebounce<TContext> {
  messages: InboundMessage[];
  context: TContext;
  queuedAt: string;
  timer?: ReturnType<typeof setTimeout>;
}

export function createInboundMessageDebouncer<TContext>(
  options: InboundMessageDebouncerOptions<TContext>,
): InboundMessageDebouncer<TContext> {
  const now = options.now ?? (() => new Date());
  const delayMs = Math.max(options.delayMs, 0);
  const pendingByConversation = new Map<string, PendingDebounce<TContext>>();

  return {
    enqueue(input): DebounceEnqueueResult {
      const conversationKey = input.message.conversation.key;
      const pending = pendingByConversation.get(conversationKey) ?? {
        messages: [],
        context: input.context,
        queuedAt: now().toISOString(),
      };

      clearPendingTimer(pending);
      pending.messages.push(input.message);
      pending.context = input.context;
      pending.timer = setTimeout(() => {
        void flushConversation(conversationKey, "timer").catch(() => undefined);
      }, delayMs);
      pendingByConversation.set(conversationKey, pending);

      const firstMessage = pending.messages[0] ?? input.message;

      return {
        conversationKey,
        messageCount: pending.messages.length,
        firstMessageId: firstMessage.id,
        lastMessageId: input.message.id,
        queuedAt: pending.queuedAt,
        flushAfterMs: delayMs,
      };
    },

    flush(conversationKey, reason = "manual") {
      return flushConversation(conversationKey, reason);
    },

    async flushAll(reason = "manual"): Promise<Array<DebouncedMessage<TContext>>> {
      const flushed: Array<DebouncedMessage<TContext>> = [];

      for (const conversationKey of [...pendingByConversation.keys()]) {
        const batch = await flushConversation(conversationKey, reason);
        if (batch) flushed.push(batch);
      }

      return flushed;
    },

    stop(): Promise<Array<DebouncedMessage<TContext>>> {
      return this.flushAll("stop");
    },

    pendingCount(): number {
      return pendingByConversation.size;
    },
  };

  async function flushConversation(
    conversationKey: string,
    reason: DebounceFlushReason,
  ): Promise<DebouncedMessage<TContext> | undefined> {
    const pending = pendingByConversation.get(conversationKey);
    if (!pending) return undefined;

    pendingByConversation.delete(conversationKey);
    clearPendingTimer(pending);

    const batch = createDebouncedMessage(conversationKey, pending, reason, now().toISOString());

    try {
      await options.onFlush(batch);
    } catch (error) {
      await options.onError?.(error, batch);
    }

    return batch;
  }
}

function clearPendingTimer<TContext>(pending: PendingDebounce<TContext>): void {
  if (!pending.timer) return;

  clearTimeout(pending.timer);
  pending.timer = undefined;
}

function createDebouncedMessage<TContext>(
  conversationKey: string,
  pending: PendingDebounce<TContext>,
  reason: DebounceFlushReason,
  flushedAt: string,
): DebouncedMessage<TContext> {
  const first = pending.messages[0];
  const latest = pending.messages[pending.messages.length - 1];

  if (!first || !latest) {
    throw new Error(`Cannot flush empty debounce batch for ${conversationKey}`);
  }

  return {
    conversationKey,
    message: {
      ...latest,
      text: pending.messages.map((message) => message.text).filter((text) => text.length > 0).join("\n\n"),
      commandText: undefined,
      attachments: pending.messages.flatMap((message) => message.attachments),
    },
    context: pending.context,
    messageCount: pending.messages.length,
    firstMessageId: first.id,
    lastMessageId: latest.id,
    queuedAt: pending.queuedAt,
    flushedAt,
    reason,
  };
}
