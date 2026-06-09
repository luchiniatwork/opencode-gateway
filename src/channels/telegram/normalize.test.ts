import { expect, test } from "bun:test";

import type { TelegramChannelConfig } from "../../config/schema.ts";
import {
  normalizeTelegramTextMessage,
  shouldAcceptTelegramTextMessage,
  textMentionsBot,
  type TelegramTextMessageRef,
} from "./normalize.ts";

test("normalizes Telegram text messages", () => {
  expect(
    normalizeTelegramTextMessage(textMessage({ text: "hello" }), {
      accountId: "default",
    }),
  ).toMatchObject({
    id: "10",
    channel: "telegram",
    accountId: "default",
    conversation: {
      key: "telegram:default:dm:123",
      type: "dm",
      id: "123",
    },
    sender: {
      id: "123",
      username: "tiago",
      displayName: "Tiago Silva",
      isBot: false,
    },
    timestamp: "2026-01-01T00:00:00.000Z",
    text: "hello",
    attachments: [],
  });
});

test("sets commandText for explicit slash commands", () => {
  expect(
    normalizeTelegramTextMessage(textMessage({ text: "  /status@GatewayBot  " }), {
      accountId: "default",
    })?.commandText,
  ).toBe("/status@GatewayBot");
});

test("returns undefined for non-text messages", () => {
  expect(
    normalizeTelegramTextMessage(textMessage({ text: undefined }), {
      accountId: "default",
    }),
  ).toBeUndefined();
});

test("returns undefined when Telegram sender is missing", () => {
  const message = textMessage({ text: "hello" });
  delete message.from;

  expect(normalizeTelegramTextMessage(message, { accountId: "default" })).toBeUndefined();
});

test("accepts private chat text messages", () => {
  expect(shouldAcceptTelegramTextMessage(textMessage(), telegramConfig(), "GatewayBot")).toBe(true);
});

test("ignores unconfigured groups", () => {
  expect(
    shouldAcceptTelegramTextMessage(
      textMessage({ chat: { id: -100123, type: "supergroup", title: "Builds" } }),
      telegramConfig(),
      "GatewayBot",
    ),
  ).toBe(false);
});

test("requires bot mention in configured groups by default", () => {
  const config = telegramConfig({ groups: { "-100123": { requireMention: true } } });

  expect(
    shouldAcceptTelegramTextMessage(
      textMessage({ chat: { id: -100123, type: "supergroup", title: "Builds" }, text: "status?" }),
      config,
      "GatewayBot",
    ),
  ).toBe(false);
  expect(
    shouldAcceptTelegramTextMessage(
      textMessage({ chat: { id: -100123, type: "supergroup", title: "Builds" }, text: "status @GatewayBot" }),
      config,
      "GatewayBot",
    ),
  ).toBe(true);
});

test("accepts configured groups without mention when configured", () => {
  expect(
    shouldAcceptTelegramTextMessage(
      textMessage({ chat: { id: -100123, type: "group", title: "Builds" }, text: "status?" }),
      telegramConfig({ groups: { "-100123": { requireMention: false } } }),
      "GatewayBot",
    ),
  ).toBe(true);
});

test("detects command mentions with bot username", () => {
  expect(textMentionsBot("/status@GatewayBot", "GatewayBot")).toBe(true);
  expect(textMentionsBot("/status@gatewaybot", "GatewayBot")).toBe(true);
  expect(textMentionsBot("/status@OtherBot", "GatewayBot")).toBe(false);
});

function telegramConfig(overrides: Partial<TelegramChannelConfig> = {}): TelegramChannelConfig {
  return {
    enabled: true,
    token: "token",
    allowFrom: [],
    groups: {},
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
      last_name: "Silva",
    },
    text: "hello",
    ...options,
  };
}
