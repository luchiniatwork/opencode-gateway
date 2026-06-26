import type { ChannelId, ConversationKey } from "../channels/types.ts";
import type { AccessRole, BusyMode, TargetMode, Verbosity } from "../config/schema.ts";
import type { RuntimePermissionId, RuntimeSessionId, RuntimeTargetId } from "../opencode/types.ts";

export interface TargetRecord {
  id: RuntimeTargetId;
  name: string;
  mode: TargetMode;
  serverUrl?: string;
  workdir?: string;
  configDir?: string;
  defaultAgent?: string;
  defaultModel?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProfileRecord {
  id: string;
  displayName: string;
  description?: string;
  avatar?: string;
  defaultTargetId: RuntimeTargetId;
  defaultAgent?: string;
  defaultModel?: string;
  defaultConfigDir?: string;
  accessPolicyId?: string;
  commandPolicyId?: string;
  defaultBusyMode?: BusyMode;
  defaultVerbosity?: Verbosity;
  createdAt: string;
  updatedAt: string;
}

export type TargetBindingSource = "profile_default" | "explicit_bind";

export interface ConversationBindingRecord {
  id: string;
  conversationKey: ConversationKey;
  channel: ChannelId;
  accountId: string;
  profileId: string;
  targetId: RuntimeTargetId;
  targetSource: TargetBindingSource;
  opencodeSessionId: RuntimeSessionId;
  sessionName?: string;
  agent?: string;
  model?: string;
  busyMode: BusyMode;
  verbosity: Verbosity;
  createdAt: string;
  updatedAt: string;
}

export interface AccessRuleRecord {
  id: string;
  channel: ChannelId;
  accountId: string;
  senderId: string;
  role: AccessRole;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  bindingId: string;
  targetId?: RuntimeTargetId;
  opencodeSessionId: RuntimeSessionId;
  opencodeMessageId?: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export type PendingPermissionStatus = "pending" | "approved" | "denied" | "expired";

export interface PendingPermissionRecord {
  id: string;
  runId: string;
  opencodePermissionId: RuntimePermissionId;
  summary: string;
  details?: unknown;
  actionMessageReceiptId?: string;
  status: PendingPermissionStatus;
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
}

export interface DeliveryReceiptRecord {
  id: string;
  runId?: string;
  channel: ChannelId;
  accountId: string;
  conversationKey: ConversationKey;
  platformMessageId: string;
  kind: "ack" | "progress" | "final" | "error" | "status";
  createdAt: string;
  updatedAt: string;
}
