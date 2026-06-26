import { expect, test } from "bun:test";

import type { TelegramChannelConfig } from "../../config/schema.ts";
import type { ChannelEvent, ChannelLogger, ChannelStartContext, OutboundTarget } from "../types.ts";
import {
  createTelegramAdapter,
  editTelegramMessage,
  sendTelegramMessage,
  sendTelegramTyping,
  type TelegramChatAction,
  type TelegramBotLike,
  type TelegramContextLike,
  type TelegramEditMessageTextOptions,
  type TelegramSendMessageOptions,
} from "./adapter.ts";
import { TELEGRAM_MAX_TEXT_LENGTH } from "./format.ts";
import { telegramActionCallbackData, type TelegramCallbackQueryRef, type TelegramTextMessageRef } from "./normalize.ts";

test("starts and stops a Telegram bot", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = createTelegramAdapter({ botFactory: () => fakeBot });

  await adapter.start(startContext());

  expect(fakeBot.started).toBe(true);

  await adapter.stop();

  expect(fakeBot.stopped).toBe(true);
});

test("fails startup when Telegram authentication fails", async () => {
  const fakeBot = new FakeTelegramBot();
  fakeBot.getMeError = new Error("Call to 'getMe' failed! (404: Not Found)");
  const adapter = createTelegramAdapter({ botFactory: () => fakeBot });

  await expect(adapter.start(startContext())).rejects.toThrow("Telegram bot authentication failed");
  expect(fakeBot.started).toBe(false);
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

test("send renders markdown messages with Telegram HTML parse mode", async () => {
  const fakeBot = new FakeTelegramBot();
  const receipt = await sendTelegramMessage(
    fakeBot,
    outboundTarget(),
    { kind: "final", format: "markdown", text: "**done** and `safe`" },
    () => new Date("2026-01-01T00:00:00.000Z"),
  );

  expect(fakeBot.sentMessages).toEqual([
    {
      chatId: "123",
      text: "<b>done</b> and <code>safe</code>",
      options: {
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      },
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

test("send keeps plain messages unformatted", async () => {
  const fakeBot = new FakeTelegramBot();

  await sendTelegramMessage(fakeBot, outboundTarget(), { kind: "status", format: "plain", text: "**not bold**" });

  expect(fakeBot.sentMessages).toEqual([
    {
      chatId: "123",
      text: "**not bold**",
      options: undefined,
    },
  ]);
});

test("send preserves markdown code fences as Telegram code blocks", async () => {
  const fakeBot = new FakeTelegramBot();

  await sendTelegramMessage(fakeBot, outboundTarget(), {
    kind: "final",
    format: "markdown",
    text: "Run this:\n```sh\nbun test\n```",
  });

  expect(fakeBot.sentMessages[0]?.text).toBe('Run this:\n<pre><code class="language-sh">bun test</code></pre>');
  expect(fakeBot.sentMessages[0]?.options?.parse_mode).toBe("HTML");
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

test("send renders actions as Telegram inline keyboard buttons", async () => {
  const fakeBot = new FakeTelegramBot();

  await sendTelegramMessage(fakeBot, outboundTarget(), {
    kind: "status",
    text: "Permission required",
    actions: [
      { id: "permission.approve", label: "Approve", style: "primary", value: "permission-1" },
      { id: "permission.deny", label: "Deny", style: "danger", value: "permission-1" },
    ],
  });

  expect(fakeBot.sentMessages[0]?.options).toEqual({
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: "Approve",
            callback_data: telegramActionCallbackData({ actionId: "permission.approve", value: "permission-1" }),
          },
          {
            text: "Deny",
            callback_data: telegramActionCallbackData({ actionId: "permission.deny", value: "permission-1" }),
          },
        ],
      ],
    },
  });
});

test("send attaches actions only to the first split Telegram message", async () => {
  const fakeBot = new FakeTelegramBot();
  const text = "a".repeat(TELEGRAM_MAX_TEXT_LENGTH + 10);

  await sendTelegramMessage(fakeBot, outboundTarget(), {
    kind: "status",
    text,
    actions: [{ id: "approve", label: "Approve" }],
  });

  expect(fakeBot.sentMessages).toHaveLength(2);
  expect(fakeBot.sentMessages[0]?.options?.reply_markup).toBeDefined();
  expect(fakeBot.sentMessages[1]?.options).toBeUndefined();
});

test("send rejects actions with oversized Telegram callback data", async () => {
  const fakeBot = new FakeTelegramBot();

  await expect(
    sendTelegramMessage(fakeBot, outboundTarget(), {
      kind: "status",
      text: "Permission required",
      actions: [{ id: "a".repeat(80), label: "Approve" }],
    }),
  ).rejects.toThrow("Telegram action callback data exceeds 64 bytes");
});

test("edit updates a Telegram message and inline keyboard", async () => {
  const fakeBot = new FakeTelegramBot();
  const receipt = await sendTelegramMessage(fakeBot, outboundTarget(), { kind: "progress", text: "Working" });

  const editedReceipt = await editTelegramMessage(
    fakeBot,
    receipt,
    {
      kind: "progress",
      text: "Still working",
      actions: [{ id: "permission.approve", label: "Approve", value: "permission-1" }],
    },
    () => new Date("2026-01-01T00:00:00.000Z"),
  );

  expect(fakeBot.editedMessages).toEqual([
    {
      chatId: "123",
      messageId: 1,
      text: "Still working",
      options: {
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "Approve",
                callback_data: telegramActionCallbackData({ actionId: "permission.approve", value: "permission-1" }),
              },
            ],
          ],
        },
      },
    },
  ]);
  expect(editedReceipt).toMatchObject({ platformMessageId: "1", timestamp: "2026-01-01T00:00:00.000Z" });
});

test("edit renders markdown with Telegram HTML parse mode", async () => {
  const fakeBot = new FakeTelegramBot();
  const receipt = await sendTelegramMessage(fakeBot, outboundTarget(), { kind: "progress", text: "Working" });

  await editTelegramMessage(fakeBot, receipt, { kind: "progress", format: "markdown", text: "**Done**" });

  expect(fakeBot.editedMessages[0]).toEqual({
    chatId: "123",
    messageId: 1,
    text: "<b>Done</b>",
    options: {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [] },
    },
  });
});

test("edit clears Telegram inline keyboard when no actions are present", async () => {
  const fakeBot = new FakeTelegramBot();
  const receipt = await sendTelegramMessage(fakeBot, outboundTarget(), {
    kind: "progress",
    text: "Working",
    actions: [{ id: "approve", label: "Approve" }],
  });

  await editTelegramMessage(fakeBot, receipt, { kind: "progress", text: "Done" });

  expect(fakeBot.editedMessages[0]?.options).toEqual({ reply_markup: { inline_keyboard: [] } });
});

test("sendTyping sends Telegram typing chat action", async () => {
  const fakeBot = new FakeTelegramBot();

  await sendTelegramTyping(fakeBot, outboundTarget(), "typing");

  expect(fakeBot.chatActions).toEqual([
    {
      chatId: "123",
      action: "typing",
      options: undefined,
    },
  ]);
});

test("sendTyping passes Telegram topic message thread id", async () => {
  const fakeBot = new FakeTelegramBot();

  await sendTelegramTyping(
    fakeBot,
    outboundTarget({
      conversationKey: "telegram:default:group:-100123:topic:42",
      conversationId: "-100123",
      topicId: "42",
    }),
    "typing",
  );

  expect(fakeBot.chatActions[0]?.options).toEqual({ message_thread_id: 42 });
});

test("sendTyping ignores idle state", async () => {
  const fakeBot = new FakeTelegramBot();

  await sendTelegramTyping(fakeBot, outboundTarget(), "idle");

  expect(fakeBot.chatActions).toEqual([]);
});

test("emits normalized Telegram callback actions and answers callback query", async () => {
  const fakeBot = new FakeTelegramBot();
  const events: ChannelEvent[] = [];
  const adapter = createTelegramAdapter({
    botFactory: () => fakeBot,
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  await adapter.start(startContext({ emit: (event) => void events.push(event) }));
  await fakeBot.emitCallbackQuery(callbackQuery());

  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    type: "action",
    action: {
      id: "callback-1",
      channel: "telegram",
      accountId: "default",
      conversation: { key: "telegram:default:dm:123" },
      sender: { id: "123", username: "tiago" },
      message: { id: "20" },
      actionId: "permission.approve",
      value: "permission-1",
      timestamp: "2026-01-01T00:00:00.000Z",
    },
  });
  expect(fakeBot.answeredCallbackQueries).toEqual([{ id: "callback-1", options: undefined }]);
});

test("answers unsupported callback query data without emitting an action", async () => {
  const fakeBot = new FakeTelegramBot();
  const events: ChannelEvent[] = [];
  const adapter = createTelegramAdapter({ botFactory: () => fakeBot });

  await adapter.start(startContext({ emit: (event) => void events.push(event) }));
  await fakeBot.emitCallbackQuery(callbackQuery({ data: "unsupported" }));

  expect(events).toEqual([]);
  expect(fakeBot.answeredCallbackQueries).toEqual([{ id: "callback-1", options: { text: "Unsupported action" } }]);
});

test("answers callback query with failure when action emit fails", async () => {
  const fakeBot = new FakeTelegramBot();
  const adapter = createTelegramAdapter({ botFactory: () => fakeBot });

  await adapter.start(
    startContext({
      emit: () => {
        throw new Error("emit failed");
      },
    }),
  );
  await fakeBot.emitCallbackQuery(callbackQuery());

  expect(fakeBot.answeredCallbackQueries).toEqual([{ id: "callback-1", options: { text: "Action failed" } }]);
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

function callbackQuery(options: Partial<TelegramCallbackQueryRef> = {}): TelegramCallbackQueryRef {
  return {
    id: "callback-1",
    from: {
      id: 123,
      is_bot: false,
      username: "tiago",
      first_name: "Tiago",
    },
    data: telegramActionCallbackData({ actionId: "permission.approve", value: "permission-1" }),
    message: {
      message_id: 20,
      date: 1_767_225_600,
      chat: { id: 123, type: "private" },
    },
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
  readonly messageHandlers: Array<(ctx: TelegramContextLike) => unknown | Promise<unknown>> = [];
  readonly callbackHandlers: Array<(ctx: TelegramContextLike) => unknown | Promise<unknown>> = [];
  readonly sentMessages: Array<{
    chatId: number | string;
    text: string;
    options?: TelegramSendMessageOptions;
  }> = [];
  readonly editedMessages: Array<{
    chatId: number | string;
    messageId: number;
    text: string;
    options?: TelegramEditMessageTextOptions;
  }> = [];
  readonly chatActions: Array<{
    chatId: number | string;
    action: TelegramChatAction;
    options?: TelegramSendMessageOptions;
  }> = [];
  readonly answeredCallbackQueries: Array<{ id: string; options?: unknown }> = [];
  started = false;
  stopped = false;
  nextMessageId = 1;
  getMeError: Error | undefined;

  readonly api = {
    getMe: async () => {
      if (this.getMeError) throw this.getMeError;
      return { username: "GatewayBot" };
    },
    sendMessage: async (chatId: number | string, text: string, options?: TelegramSendMessageOptions) => {
      this.sentMessages.push({ chatId, text, options });

      return {
        message_id: this.nextMessageId++,
        date: 1_767_225_600,
        chat: { id: chatId },
      };
    },
    sendChatAction: async (chatId: number | string, action: TelegramChatAction, options?: TelegramSendMessageOptions) => {
      this.chatActions.push({ chatId, action, options });
    },
    editMessageText: async (
      chatId: number | string,
      messageId: number,
      text: string,
      options?: TelegramEditMessageTextOptions,
    ) => {
      this.editedMessages.push({ chatId, messageId, text, options });

      return {
        message_id: messageId,
        date: 1_767_225_600,
        chat: { id: chatId },
      };
    },
    answerCallbackQuery: async (id: string, options?: unknown) => {
      this.answeredCallbackQueries.push({ id, options });
    },
  };

  on(filter: "message:text" | "callback_query:data", handler: (ctx: TelegramContextLike) => unknown | Promise<unknown>): void {
    if (filter === "message:text") {
      this.messageHandlers.push(handler);
      return;
    }

    this.callbackHandlers.push(handler);
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
    for (const handler of this.messageHandlers) {
      await handler({ message });
    }
  }

  async emitCallbackQuery(callbackQuery: TelegramCallbackQueryRef): Promise<void> {
    for (const handler of this.callbackHandlers) {
      await handler({ callbackQuery });
    }
  }
}
