import type { AccessRole, BusyMode, TargetMode, Verbosity } from "../config/schema.ts";

export interface TargetRecord {
  id: string;
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
  defaultTargetId: string;
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

export interface ConversationBindingRecord {
  id: string;
  conversationKey: string;
  channel: string;
  accountId: string;
  profileId: string;
  targetId: string;
  opencodeSessionId: string;
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
  channel: string;
  accountId: string;
  senderId: string;
  role: AccessRole;
  createdAt: string;
  updatedAt: string;
}

export interface RunRecord {
  id: string;
  bindingId: string;
  opencodeSessionId: string;
  opencodeMessageId?: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}
