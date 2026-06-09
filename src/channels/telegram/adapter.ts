import { Bot } from "grammy";

import type { TelegramChannelConfig } from "../../config/schema.ts";
import type { OutboundAction, OutboundMessage } from "../../messages/types.ts";
import type {
  ChannelAdapter,
  ChannelLogger,
  ChannelStartContext,
  OutboundTarget,
  SendReceipt,
  TypingState,
} from "../types.ts";
import { splitTelegramText, telegramOutboundText } from "./format.ts";
import {
  normalizeTelegramCallbackQuery,
  normalizeTelegramTextMessage,
  shouldAcceptTelegramTextMessage,
  telegramActionCallbackData,
  type TelegramCallbackQueryRef,
  type TelegramTextMessageRef,
} from "./normalize.ts";

export interface TelegramBotUserRef {
  username?: string;
}

export interface TelegramSentMessageRef {
  message_id: number;
  date?: number;
  chat?: { id: number | string };
}

export interface TelegramInlineKeyboardButtonRef {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboardMarkupRef {
  inline_keyboard: TelegramInlineKeyboardButtonRef[][];
}

export interface TelegramSendMessageOptions {
  message_thread_id?: number;
  reply_markup?: TelegramInlineKeyboardMarkupRef;
}

export interface TelegramEditMessageTextOptions {
  reply_markup?: TelegramInlineKeyboardMarkupRef;
}

export interface TelegramAnswerCallbackQueryOptions {
  text?: string;
  show_alert?: boolean;
}

export interface TelegramBotApiLike {
  getMe(): Promise<TelegramBotUserRef>;
  sendMessage(
    chatId: number | string,
    text: string,
    options?: TelegramSendMessageOptions,
  ): Promise<TelegramSentMessageRef>;
  sendChatAction(
    chatId: number | string,
    action: TelegramChatAction,
    options?: TelegramSendMessageOptions,
  ): Promise<unknown>;
  editMessageText(
    chatId: number | string,
    messageId: number,
    text: string,
    options?: TelegramEditMessageTextOptions,
  ): Promise<TelegramSentMessageRef | true>;
  answerCallbackQuery(callbackQueryId: string, options?: TelegramAnswerCallbackQueryOptions): Promise<unknown>;
}

export type TelegramChatAction = "typing" | "upload_document";

export interface TelegramContextLike {
  message?: TelegramTextMessageRef;
  callbackQuery?: TelegramCallbackQueryRef;
}

export interface TelegramBotLike {
  api: TelegramBotApiLike;
  on(filter: "message:text" | "callback_query:data", handler: (ctx: TelegramContextLike) => unknown | Promise<unknown>): void;
  catch?(handler: (error: unknown) => unknown): void;
  start(options?: unknown): Promise<void>;
  stop(): void | Promise<void>;
}

export interface TelegramAdapterOptions {
  botFactory?: (token: string) => TelegramBotLike;
  now?: () => Date;
}

export function createTelegramAdapter(options: TelegramAdapterOptions = {}): ChannelAdapter<TelegramChannelConfig> {
  const botFactory = options.botFactory ?? ((token) => new Bot(token) as unknown as TelegramBotLike);
  const now = options.now ?? (() => new Date());
  let bot: TelegramBotLike | undefined;
  let pollingPromise: Promise<void> | undefined;
  let abortSignal: AbortSignal | undefined;
  let abortHandler: (() => void) | undefined;
  let stopRequested = false;
  let started = false;

  return {
    id: "telegram",

    async start(ctx): Promise<void> {
      if (started) return;

      if (!ctx.config.enabled) {
        ctx.logger.info("telegram channel disabled", { channel: "telegram", accountId: ctx.accountId });
        return;
      }

      if (!ctx.config.token) {
        throw new Error("Telegram token is required when Telegram channel is enabled");
      }

      stopRequested = false;
      const activeBot = botFactory(ctx.config.token);
      const botUsername = await loadBotUsername(activeBot, ctx.logger);

      bot = activeBot;
      started = true;

      activeBot.catch?.((error) => {
        ctx.logger.error("telegram bot error", { error: formatError(error) });
      });

      activeBot.on("message:text", async (telegramCtx) => {
        const message = telegramCtx.message;

        if (!message) return;
        if (!shouldAcceptTelegramTextMessage(message, ctx.config, botUsername)) return;

        const inbound = normalizeTelegramTextMessage(message, { accountId: ctx.accountId });

        if (!inbound) return;

        try {
          await ctx.emit({ type: "message", message: inbound });
        } catch (error) {
          ctx.logger.error("telegram emit failed", {
            channel: "telegram",
            accountId: ctx.accountId,
            conversationKey: inbound.conversation.key,
            error: formatError(error),
          });
        }
      });

      activeBot.on("callback_query:data", async (telegramCtx) => {
        const query = telegramCtx.callbackQuery;

        if (!query) return;

        const action = normalizeTelegramCallbackQuery(query, { accountId: ctx.accountId, now });

        if (!action) {
          await answerCallbackQuerySafely(activeBot, query.id, ctx.logger, { text: "Unsupported action" });
          return;
        }

        try {
          await ctx.emit({ type: "action", action });
          await answerCallbackQuerySafely(activeBot, query.id, ctx.logger);
        } catch (error) {
          ctx.logger.error("telegram action emit failed", {
            channel: "telegram",
            accountId: ctx.accountId,
            conversationKey: action.conversation.key,
            actionId: action.actionId,
            error: formatError(error),
          });
          await answerCallbackQuerySafely(activeBot, query.id, ctx.logger, { text: "Action failed" });
        }
      });

      abortSignal = ctx.signal;
      abortHandler = () => {
        void this.stop();
      };
      abortSignal.addEventListener("abort", abortHandler, { once: true });

      pollingPromise = Promise.resolve(activeBot.start()).catch((error) => {
        if (stopRequested) return;

        ctx.logger.error("telegram polling failed", {
          channel: "telegram",
          accountId: ctx.accountId,
          error: formatError(error),
        });
      });

      if (ctx.signal.aborted) {
        await this.stop();
      }
    },

    async stop(): Promise<void> {
      if (!started) return;

      started = false;
      stopRequested = true;

      if (abortSignal && abortHandler) {
        abortSignal.removeEventListener("abort", abortHandler);
      }

      abortSignal = undefined;
      abortHandler = undefined;

      const activeBot = bot;
      bot = undefined;

      if (activeBot) {
        await Promise.resolve(activeBot.stop());
      }

      await pollingPromise;
      pollingPromise = undefined;
    },

    async send(target, message): Promise<SendReceipt> {
      if (!bot) throw new Error("Telegram adapter is not started");

      return sendTelegramMessage(bot, target, message, now);
    },

    async edit(receipt, message): Promise<SendReceipt> {
      if (!bot) throw new Error("Telegram adapter is not started");

      return editTelegramMessage(bot, receipt, message, now);
    },

    async sendTyping(target, state): Promise<void> {
      if (!bot) throw new Error("Telegram adapter is not started");

      await sendTelegramTyping(bot, target, state);
    },
  };
}

export async function sendTelegramMessage(
  bot: TelegramBotLike,
  target: OutboundTarget,
  message: OutboundMessage,
  now: () => Date = () => new Date(),
): Promise<SendReceipt> {
  const text = telegramOutboundText(message);
  const options = telegramSendOptions(target, message.actions);
  const sentMessages: TelegramSentMessageRef[] = [];
  let index = 0;

  for (const chunk of splitTelegramText(text)) {
    sentMessages.push(await bot.api.sendMessage(target.conversationId, chunk, index === 0 ? options : telegramSendOptions(target)));
    index += 1;
  }

  const first = sentMessages[0];

  if (!first) {
    throw new Error("Telegram send produced no message receipt");
  }

  return {
    channel: "telegram",
    accountId: target.accountId,
    conversationKey: target.conversationKey,
    platformMessageId: String(first.message_id),
    timestamp: first.date === undefined ? now().toISOString() : new Date(first.date * 1_000).toISOString(),
    raw: { messages: sentMessages },
  };
}

export async function editTelegramMessage(
  bot: TelegramBotLike,
  receipt: SendReceipt,
  message: OutboundMessage,
  now: () => Date = () => new Date(),
): Promise<SendReceipt> {
  const text = telegramOutboundText(message);

  if (splitTelegramText(text).length > 1) {
    throw new Error("Telegram edit text exceeds maximum message length");
  }

  const chatId = telegramReceiptChatId(receipt);
  const messageId = Number(receipt.platformMessageId);

  if (!Number.isInteger(messageId)) {
    throw new Error("Telegram edit receipt has an invalid message id");
  }

  const edited = await bot.api.editMessageText(chatId, messageId, text, telegramEditOptions(message.actions));
  const sentMessage = edited === true ? undefined : edited;

  return {
    channel: "telegram",
    accountId: receipt.accountId,
    conversationKey: receipt.conversationKey,
    platformMessageId: String(sentMessage?.message_id ?? messageId),
    timestamp: sentMessage?.date === undefined ? now().toISOString() : new Date(sentMessage.date * 1_000).toISOString(),
    raw: { message: sentMessage ?? true, chatId },
  };
}

export async function sendTelegramTyping(
  bot: TelegramBotLike,
  target: OutboundTarget,
  state: TypingState,
): Promise<void> {
  const action = telegramChatAction(state);

  if (!action) return;

  await bot.api.sendChatAction(target.conversationId, action, telegramSendOptions(target));
}

function telegramChatAction(state: TypingState): TelegramChatAction | undefined {
  if (state === "typing") return "typing";
  if (state === "uploading") return "upload_document";
  return undefined;
}

function telegramSendOptions(target: OutboundTarget, actions?: OutboundAction[]): TelegramSendMessageOptions | undefined {
  const topicId = target.topicId ?? target.threadId;
  const messageThreadId = topicId === undefined ? undefined : Number(topicId);
  const replyMarkup = telegramReplyMarkup(actions);
  const options: TelegramSendMessageOptions = {};

  if (messageThreadId !== undefined && Number.isInteger(messageThreadId)) {
    options.message_thread_id = messageThreadId;
  }

  if (replyMarkup) {
    options.reply_markup = replyMarkup;
  }

  return Object.keys(options).length === 0 ? undefined : options;
}

function telegramEditOptions(actions?: OutboundAction[]): TelegramEditMessageTextOptions {
  return { reply_markup: telegramReplyMarkup(actions) ?? { inline_keyboard: [] } };
}

function telegramReplyMarkup(actions: OutboundAction[] | undefined): TelegramInlineKeyboardMarkupRef | undefined {
  if (!actions || actions.length === 0) return undefined;

  return {
    inline_keyboard: [
      actions.map((action) => ({
        text: action.label,
        callback_data: telegramActionCallbackData({ actionId: action.id, value: action.value }),
      })),
    ],
  };
}

function telegramReceiptChatId(receipt: SendReceipt): number | string {
  const raw = receipt.raw;

  if (isObject(raw)) {
    const chatId = telegramRawChatId(raw);

    if (chatId !== undefined) return chatId;
  }

  throw new Error("Telegram edit receipt is missing chat id");
}

function telegramRawChatId(raw: Record<string, unknown>): number | string | undefined {
  const chatId = raw.chatId;

  if (typeof chatId === "string" || typeof chatId === "number") return chatId;

  const messages = raw.messages;

  if (Array.isArray(messages)) {
    const first = messages[0];

    if (isObject(first) && isObject(first.chat)) {
      const messageChatId = first.chat.id;

      if (typeof messageChatId === "string" || typeof messageChatId === "number") return messageChatId;
    }
  }

  const message = raw.message;

  if (isObject(message) && isObject(message.chat)) {
    const messageChatId = message.chat.id;

    if (typeof messageChatId === "string" || typeof messageChatId === "number") return messageChatId;
  }

  return undefined;
}

async function answerCallbackQuerySafely(
  bot: TelegramBotLike,
  id: string,
  logger: ChannelLogger,
  options?: TelegramAnswerCallbackQueryOptions,
): Promise<void> {
  try {
    await bot.api.answerCallbackQuery(id, options);
  } catch (error) {
    logger.warn("telegram callback answer failed", { channel: "telegram", error: formatError(error) });
  }
}

async function loadBotUsername(bot: TelegramBotLike, logger: ChannelLogger): Promise<string | undefined> {
  try {
    return (await bot.api.getMe()).username;
  } catch (error) {
    logger.error("telegram bot authentication failed", { error: formatError(error) });
    throw new Error(`Telegram bot authentication failed: ${formatError(error)}`);
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
