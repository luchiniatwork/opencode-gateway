import { expect, test } from "bun:test";

import type { InboundMessage } from "../channels/types.ts";
import { createInboundMessageDebouncer, type DebouncedMessage } from "./debounce.ts";

test("debouncer merges rapid messages in arrival order", async () => {
  const flushed: Array<DebouncedMessage<{ replyTarget: string }>> = [];
  const debouncer = createInboundMessageDebouncer<{ replyTarget: string }>({
    delayMs: 1_000,
    now: fixedNow,
    onFlush: (batch) => {
      flushed.push(batch);
    },
  });

  const first = debouncer.enqueue({
    message: inboundMessage({ id: "message-1", text: "first", attachmentIds: ["file-1"] }),
    context: { replyTarget: "first" },
  });
  const second = debouncer.enqueue({
    message: inboundMessage({ id: "message-2", text: "second", attachmentIds: ["file-2"] }),
    context: { replyTarget: "latest" },
  });

  expect(first.messageCount).toBe(1);
  expect(second).toEqual({
    conversationKey: "telegram:default:dm:123",
    messageCount: 2,
    firstMessageId: "message-1",
    lastMessageId: "message-2",
    queuedAt: "2026-01-01T00:00:00.000Z",
    flushAfterMs: 1000,
  });

  await debouncer.flush("telegram:default:dm:123");

  expect(flushed).toHaveLength(1);
  expect(flushed[0]?.message).toEqual(expect.objectContaining({
    id: "message-2",
    text: "first\n\nsecond",
    commandText: undefined,
    attachments: [
      expect.objectContaining({ id: "file-1" }),
      expect.objectContaining({ id: "file-2" }),
    ],
  }));
  expect(flushed[0]?.context).toEqual({ replyTarget: "latest" });
  expect(flushed[0]?.reason).toBe("manual");
});

test("debouncer isolates conversations", async () => {
  const flushed: Array<DebouncedMessage<undefined>> = [];
  const debouncer = createInboundMessageDebouncer<undefined>({
    delayMs: 1_000,
    now: fixedNow,
    onFlush: (batch) => {
      flushed.push(batch);
    },
  });

  debouncer.enqueue({ message: inboundMessage({ conversationKey: "conversation-a", text: "a1" }), context: undefined });
  debouncer.enqueue({ message: inboundMessage({ conversationKey: "conversation-b", text: "b1" }), context: undefined });
  debouncer.enqueue({ message: inboundMessage({ conversationKey: "conversation-a", id: "message-a2", text: "a2" }), context: undefined });

  expect(debouncer.pendingCount()).toBe(2);

  await debouncer.flush("conversation-a");

  expect(flushed.map((batch) => batch.message.text)).toEqual(["a1\n\na2"]);
  expect(debouncer.pendingCount()).toBe(1);

  await debouncer.flush("conversation-b");

  expect(flushed.map((batch) => batch.message.text)).toEqual(["a1\n\na2", "b1"]);
  expect(debouncer.pendingCount()).toBe(0);
});

test("debouncer timer flushes pending messages", async () => {
  const flushed: Array<DebouncedMessage<undefined>> = [];
  const debouncer = createInboundMessageDebouncer<undefined>({
    delayMs: 1,
    now: fixedNow,
    onFlush: (batch) => {
      flushed.push(batch);
    },
  });

  debouncer.enqueue({ message: inboundMessage({ text: "timer" }), context: undefined });

  await waitFor(() => flushed.length === 1);

  expect(flushed[0]?.message.text).toBe("timer");
  expect(flushed[0]?.reason).toBe("timer");
});

test("debouncer stop flushes all pending messages", async () => {
  const flushed: Array<DebouncedMessage<undefined>> = [];
  const debouncer = createInboundMessageDebouncer<undefined>({
    delayMs: 1_000,
    now: fixedNow,
    onFlush: (batch) => {
      flushed.push(batch);
    },
  });

  debouncer.enqueue({ message: inboundMessage({ conversationKey: "conversation-a", text: "a" }), context: undefined });
  debouncer.enqueue({ message: inboundMessage({ conversationKey: "conversation-b", text: "b" }), context: undefined });

  const stopped = await debouncer.stop();

  expect(stopped).toHaveLength(2);
  expect(flushed.map((batch) => batch.reason)).toEqual(["stop", "stop"]);
  expect(debouncer.pendingCount()).toBe(0);
});

function inboundMessage(
  options: { id?: string; conversationKey?: string; text?: string; attachmentIds?: string[] } = {},
): InboundMessage {
  return {
    id: options.id ?? "message-1",
    channel: "telegram",
    accountId: "default",
    conversation: {
      key: options.conversationKey ?? "telegram:default:dm:123",
      type: "dm",
      id: "123",
    },
    sender: {
      id: "123",
      username: "tiago",
      displayName: "Tiago",
    },
    timestamp: "2026-01-01T00:00:00.000Z",
    text: options.text ?? "hello",
    attachments: (options.attachmentIds ?? []).map((id) => ({ id, kind: "file" })),
  };
}

function fixedNow(): Date {
  return new Date("2026-01-01T00:00:00.000Z");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (!predicate() && Date.now() < deadline) {
    await Bun.sleep(1);
  }

  expect(predicate()).toBe(true);
}
