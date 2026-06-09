import type { ConversationRef, ConversationType } from "../types.ts";

export type TelegramChatType = "private" | "group" | "supergroup" | "channel" | (string & {});

export interface TelegramChatRef {
  id: number | string;
  type: TelegramChatType;
  title?: string;
  username?: string;
}

export function telegramConversationKey(input: {
  accountId: string;
  chatId: number | string;
  chatType: TelegramChatType;
  messageThreadId?: number | string;
}): string {
  const chatId = String(input.chatId);

  if (input.chatType === "private") return `telegram:${input.accountId}:dm:${chatId}`;
  if (input.chatType === "channel") return `telegram:${input.accountId}:channel:${chatId}`;

  if (input.messageThreadId !== undefined) {
    return `telegram:${input.accountId}:group:${chatId}:topic:${input.messageThreadId}`;
  }

  return `telegram:${input.accountId}:group:${chatId}`;
}

export function telegramConversationRef(input: {
  accountId: string;
  chat: TelegramChatRef;
  messageThreadId?: number | string;
}): ConversationRef {
  const key = telegramConversationKey({
    accountId: input.accountId,
    chatId: input.chat.id,
    chatType: input.chat.type,
    messageThreadId: input.messageThreadId,
  });
  const type = telegramConversationType(input.chat.type, input.messageThreadId);

  return {
    key,
    type,
    id: String(input.chat.id),
    topicId: input.messageThreadId === undefined ? undefined : String(input.messageThreadId),
    title: input.chat.title ?? input.chat.username,
  };
}

function telegramConversationType(
  chatType: TelegramChatType,
  messageThreadId: number | string | undefined,
): ConversationType {
  if (chatType === "private") return "dm";
  if (chatType === "channel") return "channel";
  if (messageThreadId !== undefined) return "topic";
  return "group";
}
