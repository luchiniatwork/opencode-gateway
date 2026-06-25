import type { TargetMode } from "../config/schema.ts";

export type RuntimeTargetId = string;

export type RuntimeSessionId = string;

export type RuntimeTurnId = string;

export type RuntimePermissionId = string;

export interface RuntimeTarget {
  id: RuntimeTargetId;
  name: string;
  mode: TargetMode;
  serverUrl?: string;
  workdir?: string;
  configDir?: string;
  defaultAgent?: string;
  defaultModel?: string;
}

export interface RuntimeSession {
  id: RuntimeSessionId;
  targetId: RuntimeTargetId;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  raw?: unknown;
}

export interface RuntimeAgent {
  id: string;
  name?: string;
  description?: string;
  mode?: string;
  raw?: unknown;
}

export interface RuntimeModel {
  id: string;
  providerId: string;
  modelId: string;
  name?: string;
  raw?: unknown;
}

export type RuntimeTurnStatus = "queued" | "running" | "completed" | "aborted" | "error";

export interface RuntimeAttachment {
  filename?: string;
  contentType?: string;
  bytes?: Uint8Array;
  url?: string;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  total?: number;
}

export interface RuntimeTurn {
  id?: RuntimeTurnId;
  sessionId: RuntimeSessionId;
  status: RuntimeTurnStatus;
  text?: string;
  costUsd?: number;
  tokens?: TokenUsage;
  raw?: unknown;
}

export interface RuntimeTurnHandle {
  id: RuntimeTurnId;
  sessionId: RuntimeSessionId;
  targetId: RuntimeTargetId;
  status: Extract<RuntimeTurnStatus, "queued" | "running">;
  raw?: unknown;
}

export interface RuntimeStartedTurn {
  handle: RuntimeTurnHandle;
  events: AsyncIterable<RuntimeEvent>;
}

export interface EnsureSessionInput {
  target: RuntimeTarget;
  sessionId?: RuntimeSessionId;
  title?: string;
  profileId?: string;
  agent?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface SendRuntimeMessageInput {
  target: RuntimeTarget;
  sessionId: RuntimeSessionId;
  text: string;
  attachments?: RuntimeAttachment[];
  agent?: string;
  model?: string;
  metadata?: Record<string, unknown>;
}

export interface StartRuntimeTurnInput extends SendRuntimeMessageInput {
  signal?: AbortSignal;
  mode?: "sync" | "async";
  observePermissions?: boolean;
  observeProgress?: boolean;
}

export interface AbortRuntimeTurnInput {
  target: RuntimeTarget;
  sessionId: RuntimeSessionId;
  turnId?: RuntimeTurnId;
  reason?: string;
}

export interface ObserveRuntimeTurnInput {
  target: RuntimeTarget;
  sessionId: RuntimeSessionId;
  turnId?: RuntimeTurnId;
  signal?: AbortSignal;
}

export interface ListRuntimeSessionsInput {
  target: RuntimeTarget;
  limit?: number;
  cursor?: string;
}

export interface ListRuntimeAgentsInput {
  target: RuntimeTarget;
}

export interface ListRuntimeModelsInput {
  target: RuntimeTarget;
}

export interface PermissionResponseInput {
  target: RuntimeTarget;
  sessionId: RuntimeSessionId;
  permissionId: RuntimePermissionId;
  decision: "approve" | "always" | "deny";
  message?: string;
}

export type RuntimeEvent =
  | { type: "status"; status: "queued" | "running" | "idle" | "aborted" | "error" }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; summary?: string }
  | { type: "tool_update"; id: string; name: string; summary?: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary?: string }
  | { type: "permission_request"; id: RuntimePermissionId; summary: string; details?: unknown }
  | { type: "question_request"; id: string; prompt: string; choices?: string[] }
  | { type: "final"; text: string; costUsd?: number; tokens?: TokenUsage }
  | { type: "error"; message: string; retryable?: boolean };

export interface AgentRuntime {
  ensureSession(input: EnsureSessionInput): Promise<RuntimeSession>;
  send(input: SendRuntimeMessageInput): Promise<RuntimeTurn>;
  startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn>;
  sendAsync(input: SendRuntimeMessageInput): Promise<RuntimeTurnHandle>;
  observe(input: ObserveRuntimeTurnInput): AsyncIterable<RuntimeEvent>;
  abort(input: AbortRuntimeTurnInput): Promise<void>;
  respondToPermission(input: PermissionResponseInput): Promise<void>;
  listSessions(input: ListRuntimeSessionsInput): Promise<RuntimeSession[]>;
  listAgents(input: ListRuntimeAgentsInput): Promise<RuntimeAgent[]>;
  listModels(input: ListRuntimeModelsInput): Promise<RuntimeModel[]>;
}
