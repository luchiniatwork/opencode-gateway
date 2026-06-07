import type { OutboundMessage } from "../messages/types.ts";

export type ChannelId = "telegram" | "slack" | "discord" | (string & {});

export type ConversationKey = string;

export type ConversationType = "dm" | "group" | "channel" | "thread" | "topic";

export interface ConversationRef {
  key: ConversationKey;
  type: ConversationType;
  id: string;
  threadId?: string;
  topicId?: string;
  title?: string;
}

export interface SenderRef {
  id: string;
  username?: string;
  displayName?: string;
  isBot?: boolean;
}

export interface MessageRef {
  id: string;
  senderId?: string;
  timestamp?: string;
}

export type InboundAttachmentKind = "image" | "video" | "audio" | "document" | "file" | "unknown";

export interface InboundAttachment {
  id: string;
  kind: InboundAttachmentKind;
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  caption?: string;
  url?: string;
  raw?: unknown;
}

export interface InboundMessage {
  id: string;
  channel: ChannelId;
  accountId: string;
  conversation: ConversationRef;
  sender: SenderRef;
  timestamp: string;
  text: string;
  commandText?: string;
  attachments: InboundAttachment[];
  replyTo?: MessageRef;
  raw?: unknown;
}

export interface ChannelAction {
  id: string;
  channel: ChannelId;
  accountId: string;
  conversation: ConversationRef;
  sender: SenderRef;
  message?: MessageRef;
  actionId: string;
  value?: string;
  timestamp: string;
  raw?: unknown;
}

export type ChannelEvent =
  | { type: "message"; message: InboundMessage }
  | { type: "action"; action: ChannelAction };

export interface OutboundTarget {
  channel: ChannelId;
  accountId: string;
  conversationKey: ConversationKey;
  conversationId: string;
  threadId?: string;
  topicId?: string;
  raw?: unknown;
}

export interface SendReceipt {
  channel: ChannelId;
  accountId: string;
  conversationKey: ConversationKey;
  platformMessageId: string;
  timestamp: string;
  raw?: unknown;
}

export type TypingState = "typing" | "uploading" | "idle";

export interface ChannelLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface ChannelStartContext<TConfig = unknown> {
  accountId: string;
  config: TConfig;
  signal: AbortSignal;
  emit(event: ChannelEvent): Promise<void>;
  logger: ChannelLogger;
}

export interface ChannelAdapter<TConfig = unknown> {
  id: ChannelId;
  start(ctx: ChannelStartContext<TConfig>): Promise<void>;
  stop(): Promise<void>;
  send(target: OutboundTarget, message: OutboundMessage): Promise<SendReceipt>;
  sendTyping?(target: OutboundTarget, state: TypingState): Promise<void>;
  edit?(receipt: SendReceipt, message: OutboundMessage): Promise<SendReceipt>;
  delete?(receipt: SendReceipt): Promise<void>;
}
