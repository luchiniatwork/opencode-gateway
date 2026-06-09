import { Bot } from "grammy";

import type { TelegramChannelConfig } from "../../config/schema.ts";
import type { OutboundMessage } from "../../messages/types.ts";
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
  normalizeTelegramTextMessage,
  shouldAcceptTelegramTextMessage,
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

export interface TelegramSendMessageOptions {
  message_thread_id?: number;
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
}

export type TelegramChatAction = "typing" | "upload_document";

export interface TelegramContextLike {
  message?: TelegramTextMessageRef;
}

export interface TelegramBotLike {
  api: TelegramBotApiLike;
  on(filter: "message:text", handler: (ctx: TelegramContextLike) => unknown | Promise<unknown>): void;
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
  const options = telegramSendOptions(target);
  const sentMessages: TelegramSentMessageRef[] = [];

  for (const chunk of splitTelegramText(text)) {
    sentMessages.push(await bot.api.sendMessage(target.conversationId, chunk, options));
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

function telegramSendOptions(target: OutboundTarget): TelegramSendMessageOptions | undefined {
  const topicId = target.topicId ?? target.threadId;
  const messageThreadId = topicId === undefined ? undefined : Number(topicId);

  if (messageThreadId === undefined || !Number.isInteger(messageThreadId)) return undefined;

  return { message_thread_id: messageThreadId };
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
