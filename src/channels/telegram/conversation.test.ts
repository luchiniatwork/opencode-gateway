import { expect, test } from "bun:test";

import { telegramConversationKey, telegramConversationRef } from "./conversation.ts";

test("builds Telegram DM conversation keys", () => {
  expect(
    telegramConversationKey({
      accountId: "default",
      chatId: 123,
      chatType: "private",
    }),
  ).toBe("telegram:default:dm:123");
});

test("builds Telegram group conversation keys", () => {
  expect(
    telegramConversationKey({
      accountId: "default",
      chatId: -100123,
      chatType: "supergroup",
    }),
  ).toBe("telegram:default:group:-100123");
});

test("builds Telegram topic conversation refs", () => {
  expect(
    telegramConversationRef({
      accountId: "default",
      chat: { id: -100123, type: "supergroup", title: "Builds" },
      messageThreadId: 42,
    }),
  ).toEqual({
    key: "telegram:default:group:-100123:topic:42",
    type: "topic",
    id: "-100123",
    topicId: "42",
    title: "Builds",
  });
});
