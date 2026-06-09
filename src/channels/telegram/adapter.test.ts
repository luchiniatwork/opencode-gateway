import { expect, test } from "bun:test";

import type { TelegramChannelConfig } from "../../config/schema.ts";
import type { ChannelEvent, ChannelLogger, ChannelStartContext, OutboundTarget } from "../types.ts";
import {
  createTelegramAdapter,
  sendTelegramMessage,
  type TelegramBotLike,
  type TelegramContextLike,
  type TelegramSendMessageOptions,
} from "./adapter.ts";
import { TELEGRAM_MAX_TEXT_LENGTH } from "./format.ts";
import type { TelegramTextMessageRef } from "./normalize.ts";

test("starts and stops a Telegram bot", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = createTelegramAdapter({ botFactory: () => fakeBot });

  await adapter.start(startContext());

  expect(fakeBot.started).toBe(true);

  await adapter.stop();

  expect(fakeBot.stopped).toBe(true);
});

test("emits normalized DM messages", async () => {
  const fakeBot = new FakeTelegramBot();
  const events: ChannelEvent[] = [];
  const adapter = createTelegramAdapter({ botFactory: () => fakeBot });

  await adapter.start(startContext({ emit: (event) => void events.push(event) }));
  await fakeBot.emitMessage(textMessage({ text: "hello" }));

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "message",
    message: {
      channel: "telegram",
      accountId: "default",
      conversation: { key: "telegram:default:dm:123" },
      text: "hello",
    },
  });
});

test("does not emit unconfigured group messages", async () => {
  const fakeBot = new FakeTelegramBot();
  const events: ChannelEvent[] = [];
  const adapter = createTelegramAdapter({ botFactory: () => fakeBot });

  await adapter.start(startContext({ emit: (event) => void events.push(event) }));
  await fakeBot.emitMessage(textMessage({ chat: { id: -100123, type: "supergroup", title: "Builds" } }));

  expect(events).toEqual([]);
});

test("emits configured group messages when bot is mentioned", async () => {
  const fakeBot = new FakeTelegramBot();
  const events: ChannelEvent[] = [];
  const adapter = createTelegramAdapter({ botFactory: () => fakeBot });

  await adapter.start(
    startContext({
      config: telegramConfig({ groups: { "-100123": { requireMention: true } } }),
      emit: (event) => void events.push(event),
    }),
  );
  await fakeBot.emitMessage(
    textMessage({
      chat: { id: -100123, type: "supergroup", title: "Builds" },
      text: "/status@GatewayBot",
    }),
  );

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "message",
    message: {
      commandText: "/status@GatewayBot",
      conversation: { key: "telegram:default:group:-100123" },
    },
  });
});

test("send uses plain Telegram text without parse mode", async () => {
  const fakeBot = new FakeTelegramBot();
  const receipt = await sendTelegramMessage(
    fakeBot,
    outboundTarget(),
    { kind: "final", format: "markdown", text: "**done**" },
    () => new Date("2026-01-01T00:00:00.000Z"),
  );

  expect(fakeBot.sentMessages).toEqual([
    {
      chatId: "123",
      text: "**done**",
      options: undefined,
    },
  ]);
  expect(receipt).toMatchObject({
    channel: "telegram",
    accountId: "default",
    conversationKey: "telegram:default:dm:123",
    platformMessageId: "1",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
});

test("send splits long Telegram messages", async () => {
  const fakeBot = new FakeTelegramBot();
  const text = "a".repeat(TELEGRAM_MAX_TEXT_LENGTH + 10);

  await sendTelegramMessage(fakeBot, outboundTarget(), { kind: "final", text });

  expect(fakeBot.sentMessages).toHaveLength(2);
  expect(fakeBot.sentMessages[0]?.text).toHaveLength(TELEGRAM_MAX_TEXT_LENGTH);
  expect(fakeBot.sentMessages[1]?.text).toHaveLength(10);
});

test("send passes Telegram topic message thread id", async () => {
  const fakeBot = new FakeTelegramBot();

  await sendTelegramMessage(
    fakeBot,
    outboundTarget({
      conversationKey: "telegram:default:group:-100123:topic:42",
      conversationId: "-100123",
      topicId: "42",
    }),
    { kind: "status", text: "working" },
  );

  expect(fakeBot.sentMessages[0]?.options).toEqual({ message_thread_id: 42 });
});

function startContext(
  overrides: Omit<Partial<ChannelStartContext<TelegramChannelConfig>>, "emit"> & {
    emit?: (event: ChannelEvent) => void;
  } = {},
): ChannelStartContext<TelegramChannelConfig> {
  const controller = new AbortController();
  const emit = overrides.emit;

  return {
    accountId: "default",
    config: telegramConfig(),
    signal: controller.signal,
    logger: testLogger(),
    ...overrides,
    emit: async (event) => {
      emit?.(event);
    },
  };
}

function telegramConfig(overrides: Partial<TelegramChannelConfig> = {}): TelegramChannelConfig {
  return {
    enabled: true,
    token: "token",
    allowFrom: [],
    groups: {},
    ...overrides,
  };
}

function outboundTarget(overrides: Partial<OutboundTarget> = {}): OutboundTarget {
  return {
    channel: "telegram",
    accountId: "default",
    conversationKey: "telegram:default:dm:123",
    conversationId: "123",
    ...overrides,
  };
}

function textMessage(options: Partial<TelegramTextMessageRef> = {}): TelegramTextMessageRef {
  return {
    message_id: 10,
    date: 1_767_225_600,
    chat: { id: 123, type: "private" },
    from: {
      id: 123,
      is_bot: false,
      username: "tiago",
      first_name: "Tiago",
    },
    text: "hello",
    ...options,
  };
}

function testLogger(): ChannelLogger {
  return {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

class FakeTelegramBot implements TelegramBotLike {
  readonly handlers: Array<(ctx: TelegramContextLike) => unknown | Promise<unknown>> = [];
  readonly sentMessages: Array<{
    chatId: number | string;
    text: string;
    options?: TelegramSendMessageOptions;
  }> = [];
  started = false;
  stopped = false;
  nextMessageId = 1;

  readonly api = {
    getMe: async () => ({ username: "GatewayBot" }),
    sendMessage: async (chatId: number | string, text: string, options?: TelegramSendMessageOptions) => {
      this.sentMessages.push({ chatId, text, options });

      return {
        message_id: this.nextMessageId++,
        date: 1_767_225_600,
        chat: { id: chatId },
      };
    },
  };

  on(_filter: "message:text", handler: (ctx: TelegramContextLike) => unknown | Promise<unknown>): void {
    this.handlers.push(handler);
  }

  catch(): void {
    return undefined;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async emitMessage(message: TelegramTextMessageRef): Promise<void> {
    for (const handler of this.handlers) {
      await handler({ message });
    }
  }
}
