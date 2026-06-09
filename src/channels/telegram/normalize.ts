import type { InboundMessage, MessageRef, SenderRef } from "../types.ts";
import type { TelegramChannelConfig } from "../../config/schema.ts";
import { telegramConversationRef, type TelegramChatRef } from "./conversation.ts";

export interface TelegramUserRef {
  id: number | string;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramReplyMessageRef {
  message_id: number;
  date?: number;
  from?: TelegramUserRef;
}

export interface TelegramTextMessageRef {
  message_id: number;
  date: number;
  chat: TelegramChatRef;
  from?: TelegramUserRef;
  text?: string;
  message_thread_id?: number;
  reply_to_message?: TelegramReplyMessageRef;
}

export interface NormalizeTelegramMessageOptions {
  accountId: string;
}

export function normalizeTelegramTextMessage(
  message: TelegramTextMessageRef,
  options: NormalizeTelegramMessageOptions,
): InboundMessage | undefined {
  if (!message.text || !message.from) return undefined;

  return {
    id: String(message.message_id),
    channel: "telegram",
    accountId: options.accountId,
    conversation: telegramConversationRef({
      accountId: options.accountId,
      chat: message.chat,
      messageThreadId: message.message_thread_id,
    }),
    sender: telegramSenderRef(message.from),
    timestamp: telegramDateToIso(message.date),
    text: message.text,
    commandText: slashCommandText(message.text),
    attachments: [],
    replyTo: telegramReplyRef(message.reply_to_message),
    raw: message,
  };
}

export function shouldAcceptTelegramTextMessage(
  message: TelegramTextMessageRef,
  config: TelegramChannelConfig,
  botUsername: string | undefined,
): boolean {
  if (!message.text) return false;
  if (message.chat.type === "private") return true;
  if (message.chat.type !== "group" && message.chat.type !== "supergroup") return false;

  const group = config.groups[String(message.chat.id)];

  if (!group) return false;
  if (!group.requireMention) return true;
  if (!botUsername) return false;

  return textMentionsBot(message.text, botUsername);
}

export function textMentionsBot(text: string, botUsername: string): boolean {
  const username = botUsername.startsWith("@") ? botUsername.slice(1) : botUsername;
  const escaped = escapeRegExp(username);

  return new RegExp(`@${escaped}([^A-Za-z0-9_]|$)`, "i").test(text);
}

function telegramSenderRef(user: TelegramUserRef): SenderRef {
  return {
    id: String(user.id),
    username: user.username,
    displayName: telegramDisplayName(user),
    isBot: user.is_bot,
  };
}

function telegramDisplayName(user: TelegramUserRef): string | undefined {
  const name = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return name || user.username;
}

function telegramReplyRef(reply: TelegramReplyMessageRef | undefined): MessageRef | undefined {
  if (!reply) return undefined;

  return {
    id: String(reply.message_id),
    senderId: reply.from ? String(reply.from.id) : undefined,
    timestamp: reply.date === undefined ? undefined : telegramDateToIso(reply.date),
  };
}

function slashCommandText(text: string): string | undefined {
  const trimmed = text.trim();
  return trimmed.startsWith("/") ? trimmed : undefined;
}

function telegramDateToIso(date: number): string {
  return new Date(date * 1_000).toISOString();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
