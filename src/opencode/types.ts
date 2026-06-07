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

export interface AbortRuntimeTurnInput {
  target: RuntimeTarget;
  sessionId: RuntimeSessionId;
  turnId?: RuntimeTurnId;
  reason?: string;
}

export interface ListRuntimeSessionsInput {
  target: RuntimeTarget;
  limit?: number;
  cursor?: string;
}

export interface PermissionResponseInput {
  target: RuntimeTarget;
  sessionId: RuntimeSessionId;
  permissionId: RuntimePermissionId;
  decision: "approve" | "deny";
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
  abort(input: AbortRuntimeTurnInput): Promise<void>;
  listSessions(input: ListRuntimeSessionsInput): Promise<RuntimeSession[]>;
}
