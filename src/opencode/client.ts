import { createOpencodeClient } from "@opencode-ai/sdk";

import type {
  AbortRuntimeTurnInput,
  AgentRuntime,
  EnsureSessionInput,
  ListRuntimeAgentsInput,
  ListRuntimeModelsInput,
  ListRuntimeSessionsInput,
  ObserveRuntimeTurnInput,
  PermissionResponseInput,
  RuntimeAgent,
  RuntimeEvent,
  RuntimeModel,
  RuntimeSession,
  RuntimeStartedTurn,
  RuntimeTarget,
  RuntimeTodo,
  RuntimeToolCategory,
  RuntimeTurn,
  RuntimeTurnHandle,
  SendRuntimeMessageInput,
  StartRuntimeTurnInput,
  TokenUsage,
} from "./types.ts";

type SdkFieldsResult<T> = { data: T; error?: undefined } | { data?: undefined; error: unknown };

type SdkResult<T> = SdkFieldsResult<T> | T | undefined;

type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

interface SdkSession {
  id: string;
  title?: string;
  time?: {
    created?: number;
    updated?: number;
  };
}

interface SdkAgent {
  id?: string;
  name?: string;
  description?: string;
  mode?: string;
  hidden?: boolean;
  disabled?: boolean;
  disable?: boolean;
}

interface SdkConfigProvidersResponse {
  providers?: unknown;
  default?: Record<string, string>;
}

interface SdkAssistantMessage {
  id?: string;
  sessionID?: string;
  role?: string;
  parentID?: string;
  error?: unknown;
  cost?: number;
  finish?: string;
  time?: {
    completed?: number;
  };
  agent?: string;
  model?: {
    providerID?: string;
    modelID?: string;
  };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
  };
}

interface SdkPart {
  type: string;
  id?: string;
  sessionID?: string;
  messageID?: string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: unknown;
}

interface SdkPromptResponse {
  info?: SdkAssistantMessage;
  parts?: SdkPart[];
}

interface SdkMessageEntry {
  info?: SdkAssistantMessage;
  parts?: SdkPart[];
}

interface SdkSessionOptions {
  path?: { id: string; permissionID?: string };
  query?: { directory?: string };
  body?: unknown;
}

interface SdkAppOptions {
  query?: { directory?: string };
}

interface SdkConfigOptions {
  query?: { directory?: string };
}

interface SdkEventSubscribeOptions {
  query?: { directory?: string };
  signal?: AbortSignal;
}

interface SdkEventSubscription {
  stream: AsyncIterable<unknown>;
}

interface OpenCodeSdkClient {
  app: {
    agents(options?: SdkAppOptions): Promise<SdkResult<SdkAgent[]>>;
  };
  config: {
    providers(options?: SdkConfigOptions): Promise<SdkResult<SdkConfigProvidersResponse>>;
  };
  postSessionIdPermissionsPermissionId?(options: SdkSessionOptions): Promise<SdkResult<boolean>>;
  session: {
    create(options?: SdkSessionOptions): Promise<SdkResult<SdkSession>>;
    get(options: SdkSessionOptions): Promise<SdkResult<SdkSession>>;
    list(options?: SdkSessionOptions): Promise<SdkResult<SdkSession[]>>;
    messages?(options: SdkSessionOptions): Promise<SdkResult<SdkMessageEntry[]>>;
    prompt(options: SdkSessionOptions): Promise<SdkResult<SdkPromptResponse>>;
    promptAsync(options: SdkSessionOptions): Promise<SdkResult<void>>;
    abort(options: SdkSessionOptions): Promise<SdkResult<boolean>>;
  };
  event: {
    subscribe(options?: SdkEventSubscribeOptions): Promise<SdkEventSubscription>;
  };
}

interface ObserveState {
  sessionId: string;
  turnId?: string;
  beforeMessageIds: Set<string>;
  hasBeforeMessageSnapshot: boolean;
  childSessionIds: Set<string>;
  childSessionAgentsById: Map<string, string>;
  assistantMessageIds: Set<string>;
  finalizedMessageIds: Set<string>;
  pendingPermissionIds: Set<string>;
  textPartsByMessageId: Map<string, Map<string, string>>;
  toolStatusesByCallId: Map<string, string>;
  toolInfoByCallId: Map<string, ObservedToolInfo>;
  lastTodoFingerprintBySessionId: Map<string, string>;
  idleNoAssistantSinceMs?: number;
  pendingFinal?: Extract<RuntimeEvent, { type: "final" }>;
  pendingFinalMessageId?: string;
}

interface ObservedToolInfo {
  name: string;
  category?: RuntimeToolCategory;
  summary?: string;
  sessionId: string;
}

interface OpenCodeRuntimeOptions {
  createClient?: (target: RuntimeTarget) => OpenCodeSdkClient;
  fetch?: FetchLike;
  finalResponseTimeoutMs?: number;
  finalResponsePollIntervalMs?: number;
  observeReconcileIntervalMs?: number;
  observeReconcileTimeoutMs?: number;
  permissionPollIntervalMs?: number;
  idleNoAssistantGraceMs?: number;
}

const DEFAULT_OBSERVE_RECONCILE_INTERVAL_MS = 1_000;
const DEFAULT_OBSERVE_RECONCILE_TIMEOUT_MS = 750;
const DEFAULT_PERMISSION_POLL_INTERVAL_MS = 1_000;
const DEFAULT_IDLE_NO_ASSISTANT_GRACE_MS = 5_000;

export class OpenCodeRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpenCodeRuntimeError";
  }
}

class RuntimeEventQueue implements AsyncIterable<RuntimeEvent> {
  private readonly values: RuntimeEvent[] = [];
  private readonly waiters: Array<{
    resolve: (result: IteratorResult<RuntimeEvent>) => void;
    reject: (error: unknown) => void;
  }> = [];
  private done = false;
  private failed: unknown;
  private cancelTask: Promise<void> | undefined;

  constructor(private readonly onCancel?: () => Promise<void> | void) {}

  push(event: RuntimeEvent): void {
    if (this.done) return;

    const waiter = this.waiters.shift();

    if (waiter) {
      waiter.resolve({ done: false, value: event });
      return;
    }

    this.values.push(event);
  }

  end(): void {
    if (this.done) return;

    this.done = true;
    this.resolveWaiters();
  }

  fail(error: unknown): void {
    if (this.done) return;

    this.done = true;
    this.failed = error;
    this.resolveWaiters();
  }

  async cancel(): Promise<void> {
    if (!this.cancelTask) {
      this.done = true;
      this.resolveWaiters();
      this.cancelTask = Promise.resolve(this.onCancel?.()).then(() => undefined);
    }

    await this.cancelTask;
  }

  [Symbol.asyncIterator](): AsyncIterator<RuntimeEvent> {
    return {
      next: () => this.next(),
      return: async () => {
        await this.cancel();
        return { done: true, value: undefined };
      },
    };
  }

  private next(): Promise<IteratorResult<RuntimeEvent>> {
    const value = this.values.shift();

    if (value) return Promise.resolve({ done: false, value });
    if (this.failed) return Promise.reject(this.failed);
    if (this.done) return Promise.resolve({ done: true, value: undefined });

    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private resolveWaiters(): void {
    const waiters = this.waiters.splice(0, this.waiters.length);

    for (const waiter of waiters) {
      if (this.failed) {
        waiter.reject(this.failed);
      } else {
        waiter.resolve({ done: true, value: undefined });
      }
    }
  }
}

function normalizeSdkEvent(
  sdkEvent: unknown,
  state: ObserveState,
): { events: RuntimeEvent[]; terminal: boolean } {
  const event = unwrapSdkEvent(sdkEvent);
  if (!event) return { events: [], terminal: false };

  const type = getObjectString(event, "type");
  const properties = eventProperties(event);

  switch (type) {
    case "session.created":
    case "session.updated":
      return normalizeSessionUpdated(properties, state);
    case "session.status":
      return normalizeSessionStatus(properties, state);
    case "session.idle":
      return normalizeSessionIdle(properties, state);
    case "message.updated":
      return normalizeMessageUpdated(properties, state);
    case "message.part.updated":
      return normalizeMessagePartUpdated(properties, state);
    case "message.part.delta":
      return normalizeMessagePartDelta(properties, state);
    case "permission.updated":
    case "permission.asked":
    case "permission.v2.asked":
      return normalizePermissionRequest(type, properties, state);
    case "permission.replied":
    case "permission.v2.replied":
      return normalizePermissionReplied(properties, state);
    case "question.asked":
    case "question.v2.asked":
      return normalizeQuestionRequest(properties, state);
    case "todo.updated":
      return normalizeTodoUpdated(properties, state);
    case "session.error":
      return normalizeSessionError(properties, state);
    default:
      if (type?.startsWith("session.next.")) return normalizeSessionNextEvent(type, properties, state);
      return noEvents();
  }
}

function normalizeSessionUpdated(
  properties: Record<string, unknown>,
  state: ObserveState,
): { events: RuntimeEvent[]; terminal: boolean } {
  const info = getObject(properties, "info") ?? properties;
  const sessionId = getObjectString(info, "id") ?? getObjectString(properties, "sessionID");
  const parentId = getObjectString(info, "parentID") ?? getObjectString(info, "parentId");

  if (sessionId && parentId === state.sessionId) {
    state.childSessionIds.add(sessionId);

    const agent = getObjectString(info, "agent");
    if (agent) state.childSessionAgentsById.set(sessionId, agent);
  }

  return noEvents();
}

function normalizeSessionStatus(
  properties: Record<string, unknown>,
  state: ObserveState,
): { events: RuntimeEvent[]; terminal: boolean } {
  if (!matchesSession(properties, state)) return noEvents();

  const status = properties.status;
  const sdkStatus = asObject(status) ? getObjectString(asObject(status)!, "type") : typeof status === "string" ? status : undefined;

  if (sdkStatus === "idle") return normalizeSessionIdle(properties, state);
  if (sdkStatus === "busy" || sdkStatus === "retry") {
    return { events: [{ type: "status", status: "running" }], terminal: false };
  }

  return noEvents();
}

function normalizeSessionIdle(
  properties: Record<string, unknown>,
  state: ObserveState,
): { events: RuntimeEvent[]; terminal: boolean } {
  if (!matchesSession(properties, state)) return noEvents();

  return { events: [{ type: "status", status: "idle" }], terminal: false };
}

function normalizeMessageUpdated(
  properties: Record<string, unknown>,
  state: ObserveState,
): { events: RuntimeEvent[]; terminal: boolean } {
  const info = getObject(properties, "info");
  const sessionId = getObjectString(info, "sessionID") ?? getObjectString(properties, "sessionID");
  if (!info || sessionId !== state.sessionId) return noEvents();
  if (getObjectString(info, "role") !== "assistant") return noEvents();

  const messageId = getObjectString(info, "id");
  if (!messageBelongsToObservedTurn(messageId, getObjectString(info, "parentID"), state)) return noEvents();
  if (messageId) state.assistantMessageIds.add(messageId);

  const error = info.error;
  if (error !== undefined) {
    return {
      events: [{ type: "error", message: formatRuntimeError(error), retryable: isRetryableRuntimeError(error) }],
      terminal: true,
    };
  }

  const time = getObject(info, "time");
  const finish = getObjectString(info, "finish");
  const completed = (getObjectNumber(time, "completed") !== undefined || finish !== undefined) && finish !== "tool-calls";
  if (!completed || !messageId || state.finalizedMessageIds.has(messageId)) return noEvents();

  state.pendingFinal = {
    type: "final",
    text: collectMessageText(messageId, state),
    costUsd: getObjectNumber(info, "cost"),
    tokens: mapTokenUsage(getObject(info, "tokens")),
  };
  state.pendingFinalMessageId = messageId;

  return noEvents();
}

function normalizeMessagePartUpdated(
  properties: Record<string, unknown>,
  state: ObserveState,
): { events: RuntimeEvent[]; terminal: boolean } {
  const part = getObject(properties, "part");
  const sessionId = getObjectString(part, "sessionID") ?? getObjectString(properties, "sessionID");
  const sessionKind = sessionId ? relatedSessionKind(sessionId, state) : undefined;
  if (!part || !sessionId || !sessionKind) return noEvents();

  if (sessionKind === "primary" && !partBelongsToObservedTurn(part, state)) return noEvents();

  const partType = getObjectString(part, "type");

  if (sessionKind === "subagent") {
    if (partType === "tool") return { events: normalizeToolPart(part, state, { source: "subagent" }), terminal: false };
    return noEvents();
  }

  if (partType === "text") {
    const text = updateTextPartAndGetDelta(part, getObjectString(properties, "delta"), state);
    return text ? { events: [{ type: "text_delta", text }], terminal: false } : noEvents();
  }

  if (partType === "tool") {
    return { events: normalizeToolPart(part, state), terminal: false };
  }

  if (partType === "subtask") {
    return { events: normalizeSubtaskPart(part, state), terminal: false };
  }

  if (partType === "agent") {
    const name = getObjectString(part, "name");
    return name ? { events: [{ type: "diagnostic", label: "Agent", summary: name }], terminal: false } : noEvents();
  }

  return noEvents();
}

function normalizeMessagePartDelta(
  properties: Record<string, unknown>,
  state: ObserveState,
): { events: RuntimeEvent[]; terminal: boolean } {
  if (getObjectString(properties, "sessionID") !== state.sessionId) return noEvents();
  if (getObjectString(properties, "field") !== "text") return noEvents();

  const messageId = getObjectString(properties, "messageID");
  const partId = getObjectString(properties, "partID") ?? getObjectString(properties, "id");
  const delta = getObjectString(properties, "delta");
  if (!messageId || delta === undefined) return noEvents();

  const part = {
    id: partId ?? `${messageId}:text`,
    sessionID: state.sessionId,
    messageID: messageId,
    type: "text",
  };

  if (!partBelongsToObservedTurn(part, state)) return noEvents();

  const text = updateTextPartAndGetDelta(part, delta, state);
  return text ? { events: [{ type: "text_delta", text }], terminal: false } : noEvents();
}

function normalizePermissionRequest(
  eventType: string,
  properties: Record<string, unknown>,
  state: ObserveState,
): { events: RuntimeEvent[]; terminal: boolean } {
  if (!matchesSession(properties, state)) return noEvents();

  const id = getObjectString(properties, "id") ?? getObjectString(properties, "requestID");
  if (!id) return noEvents();

  state.pendingPermissionIds.add(id);
  const source = getObject(properties, "source") ?? getObject(properties, "tool");

  return {
    events: [
      {
        type: "permission_request",
        id,
        summary: permissionSummary(properties),
        details: compactObject({
          eventType,
          type: getObjectString(properties, "type") ?? getObjectString(source, "type"),
          permission: getObjectString(properties, "permission"),
          resource: properties.resource,
          pattern: properties.pattern,
          patterns: properties.patterns,
          action: getObjectString(properties, "action"),
          resources: properties.resources,
          messageID: getObjectString(properties, "messageID") ?? getObjectString(source, "messageID"),
          callID: getObjectString(properties, "callID") ?? getObjectString(source, "callID"),
          metadata: properties.metadata,
        }),
      },
    ],
    terminal: false,
  };
}

function normalizePermissionReplied(
  properties: Record<string, unknown>,
  state: ObserveState,
): { events: RuntimeEvent[]; terminal: boolean } {
  if (!matchesSession(properties, state)) return noEvents();

  const id = getObjectString(properties, "id") ?? getObjectString(properties, "requestID") ?? getObjectString(properties, "permissionID");
  if (id) state.pendingPermissionIds.delete(id);

  return noEvents();
}

function normalizeQuestionRequest(
  properties: Record<string, unknown>,
  state: ObserveState,
): { events: RuntimeEvent[]; terminal: boolean } {
  const sessionId = getObjectString(properties, "sessionID");
  if (!sessionId || !relatedSessionKind(sessionId, state)) return noEvents();

  const id = getObjectString(properties, "id") ?? getObjectString(properties, "requestID");
  const rawQuestions = properties.questions;
  const questions = Array.isArray(rawQuestions) ? rawQuestions : [properties];
  const events: RuntimeEvent[] = [];

  for (const [index, value] of questions.entries()) {
    const question = asObject(value);
    const prompt = getObjectString(question, "question") ?? getObjectString(question, "prompt");
    if (!prompt) continue;

    const choices = questionChoices(question);
    events.push({
      type: "question_request",
      id: questions.length > 1 ? `${id ?? "question"}:${index + 1}` : id ?? `question-${index + 1}`,
      prompt,
      choices,
    });
  }

  return { events, terminal: false };
}

function normalizeTodoUpdated(
  properties: Record<string, unknown>,
  state: ObserveState,
): { events: RuntimeEvent[]; terminal: boolean } {
  const sessionId = getObjectString(properties, "sessionID");
  const sessionKind = sessionId ? relatedSessionKind(sessionId, state) : undefined;
  if (!sessionId || !sessionKind) return noEvents();

  const todos = parseTodos(properties.todos);
  if (!todos) return noEvents();

  const fingerprint = JSON.stringify(todos);
  if (state.lastTodoFingerprintBySessionId.get(sessionId) === fingerprint) return noEvents();
  state.lastTodoFingerprintBySessionId.set(sessionId, fingerprint);

  return {
    events: [{ type: "todo_update", todos, source: sessionKind === "subagent" ? "subagent" : "session" }],
    terminal: false,
  };
}

function normalizeSessionError(
  properties: Record<string, unknown>,
  state: ObserveState,
): { events: RuntimeEvent[]; terminal: boolean } {
  const sessionId = getObjectString(properties, "sessionID");
  if (sessionId && sessionId !== state.sessionId) return noEvents();

  const error = properties.error;
  return {
    events: [{ type: "error", message: formatRuntimeError(error), retryable: isRetryableRuntimeError(error) }],
    terminal: true,
  };
}

function normalizeToolPart(
  part: Record<string, unknown>,
  state: ObserveState,
  options: { source?: "subagent" } = {},
): RuntimeEvent[] {
  const callId = getObjectString(part, "callID") ?? getObjectString(part, "id");
  const sessionId = getObjectString(part, "sessionID") ?? state.sessionId;
  const rawName = getObjectString(part, "tool") ?? "tool";
  const toolState = asObject(part.state);
  const status = toolState ? getObjectString(toolState, "status") : undefined;

  if (!callId || !status) return [];

  const input = getObject(toolState, "input");
  const metadata = getObject(toolState, "metadata");
  rememberSubagentSession(rawName, metadata, state);

  return normalizeToolLifecycle({
    state,
    sessionId,
    callId,
    status,
    rawName,
    input,
    metadata,
    title: getObjectString(toolState, "title"),
    error: getObjectString(toolState, "error"),
    source: options.source,
  });
}

function normalizeSubtaskPart(part: Record<string, unknown>, state: ObserveState): RuntimeEvent[] {
  const id = getObjectString(part, "id");
  const description = getObjectString(part, "description");
  const agent = getObjectString(part, "agent") ?? "subagent";
  if (!id) return [];

  return normalizeToolLifecycle({
    state,
    sessionId: getObjectString(part, "sessionID") ?? state.sessionId,
    callId: id,
    status: "running",
    rawName: "task",
    input: compactObject({ description, subagent_type: agent }),
    metadata: undefined,
    title: description,
    source: "subagent",
  });
}

function normalizeSessionNextEvent(
  eventType: string,
  properties: Record<string, unknown>,
  state: ObserveState,
): { events: RuntimeEvent[]; terminal: boolean } {
  const sessionId = getObjectString(properties, "sessionID");
  const sessionKind = sessionId ? relatedSessionKind(sessionId, state) : undefined;
  if (!sessionId || !sessionKind) return noEvents();

  const source = sessionKind === "subagent" ? "subagent" : undefined;
  const assistantMessageId = getObjectString(properties, "assistantMessageID");
  if (sessionKind === "primary" && assistantMessageId) state.assistantMessageIds.add(assistantMessageId);

  switch (eventType) {
    case "session.next.tool.input.started": {
      const callId = getObjectString(properties, "callID");
      const rawName = getObjectString(properties, "name") ?? "tool";
      if (callId) rememberToolInfo(state, sessionId, callId, rawName, undefined, undefined, source);
      return noEvents();
    }
    case "session.next.tool.called": {
      const callId = getObjectString(properties, "callID");
      const rawName = getObjectString(properties, "tool") ?? "tool";
      if (!callId) return noEvents();

      const input = getObject(properties, "input") ?? {};
      return {
        events: normalizeToolLifecycle({
          state,
          sessionId,
          callId,
          status: "running",
          rawName,
          input,
          metadata: undefined,
          title: undefined,
          source,
        }),
        terminal: false,
      };
    }
    case "session.next.tool.progress": {
      const callId = getObjectString(properties, "callID");
      if (!callId) return noEvents();

      const info = state.toolInfoByCallId.get(toolStateKey(sessionId, callId));
      return {
        events: normalizeToolLifecycle({
          state,
          sessionId,
          callId,
          status: "running",
          rawName: info?.name ?? "tool",
          input: undefined,
          metadata: undefined,
          title: sessionNextToolSummary(properties),
          source: source ?? (info?.category === "subagent" ? "subagent" : undefined),
        }),
        terminal: false,
      };
    }
    case "session.next.tool.success": {
      const callId = getObjectString(properties, "callID");
      if (!callId) return noEvents();

      const info = state.toolInfoByCallId.get(toolStateKey(sessionId, callId));
      return {
        events: normalizeToolLifecycle({
          state,
          sessionId,
          callId,
          status: "completed",
          rawName: info?.name ?? "tool",
          input: undefined,
          metadata: undefined,
          title: sessionNextToolSummary(properties) ?? info?.summary,
          source: source ?? (info?.category === "subagent" ? "subagent" : undefined),
        }),
        terminal: false,
      };
    }
    case "session.next.tool.failed": {
      const callId = getObjectString(properties, "callID");
      if (!callId) return noEvents();

      const info = state.toolInfoByCallId.get(toolStateKey(sessionId, callId));
      return {
        events: normalizeToolLifecycle({
          state,
          sessionId,
          callId,
          status: "error",
          rawName: info?.name ?? "tool",
          input: undefined,
          metadata: undefined,
          error: formatRuntimeError(properties.error),
          source: source ?? (info?.category === "subagent" ? "subagent" : undefined),
        }),
        terminal: false,
      };
    }
    case "session.next.retried":
      return diagnosticEvent("Retry", `attempt ${getObjectNumber(properties, "attempt") ?? "unknown"}: ${formatRuntimeError(properties.error)}`);
    case "session.next.compaction.started":
      return diagnosticEvent("Compaction", `${getObjectString(properties, "reason") ?? "manual"} compaction started`);
    case "session.next.compaction.ended":
      return diagnosticEvent("Compaction", `${getObjectString(properties, "reason") ?? "manual"} compaction completed`);
    case "session.next.step.started":
      return diagnosticEvent("Step", `agent ${getObjectString(properties, "agent") ?? "unknown"} started`);
    case "session.next.step.ended":
      return diagnosticEvent("Step", `${getObjectString(properties, "finish") ?? "completed"}${costSuffix(getObjectNumber(properties, "cost"))}`);
    case "session.next.step.failed":
      return diagnosticEvent("Step", `failed: ${formatRuntimeError(properties.error)}`);
    case "session.next.agent.switched":
      return diagnosticEvent("Agent", getObjectString(properties, "agent") ?? "switched");
    case "session.next.model.switched":
      return diagnosticEvent("Model", formatModelRef(getObject(properties, "model")) ?? "switched");
    default:
      return noEvents();
  }
}

function normalizeToolLifecycle(input: {
  state: ObserveState;
  sessionId: string;
  callId: string;
  status: string;
  rawName: string;
  input?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  title?: string;
  error?: string;
  source?: "subagent";
}): RuntimeEvent[] {
  const key = toolStateKey(input.sessionId, input.callId);
  const previousStatus = input.state.toolStatusesByCallId.get(key);
  if (previousStatus === input.status && (input.status === "completed" || input.status === "error")) return [];

  input.state.toolStatusesByCallId.set(key, input.status);

  const info = rememberToolInfo(
    input.state,
    input.sessionId,
    input.callId,
    input.rawName,
    input.input,
    input.metadata,
    input.source,
    input.title,
    input.error,
  );
  const eventBase = { id: input.callId, name: info.name, summary: info.summary, category: info.category };

  if (!previousStatus && (input.status === "pending" || input.status === "running")) {
    return [{ type: "tool_start", ...eventBase }];
  }

  if (input.status === "pending" || input.status === "running") {
    return [{ type: "tool_update", ...eventBase }];
  }

  if (input.status === "completed") return [{ type: "tool_end", ...eventBase, ok: true }];
  if (input.status === "error") return [{ type: "tool_end", ...eventBase, ok: false }];

  return [];
}

function rememberToolInfo(
  state: ObserveState,
  sessionId: string,
  callId: string,
  rawName: string,
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  source: "subagent" | undefined,
  title?: string,
  error?: string,
): ObservedToolInfo {
  const key = toolStateKey(sessionId, callId);
  const existing = state.toolInfoByCallId.get(key);
  const category = source === "subagent" ? "subagent" : existing?.category ?? toolCategory(rawName);
  const name = toolDisplayName(rawName, input, metadata, existing?.name, category);
  const summary = toolSummary(rawName, input, title, error, existing?.summary);
  const info = { name, category, summary, sessionId } satisfies ObservedToolInfo;

  state.toolInfoByCallId.set(key, info);
  rememberSubagentSession(rawName, metadata, state);

  return info;
}

function toolStateKey(sessionId: string, callId: string): string {
  return `${sessionId}:${callId}`;
}

function toolCategory(rawName: string): RuntimeToolCategory | undefined {
  if (rawName === "skill") return "skill";
  if (rawName === "task") return "subagent";
  return undefined;
}

function toolDisplayName(
  rawName: string,
  input: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
  existing: string | undefined,
  category: RuntimeToolCategory | undefined,
): string {
  if (category === "skill") return getObjectString(input, "name") ?? getObjectString(metadata, "name") ?? existing ?? rawName;
  if (rawName === "task") return getObjectString(input, "subagent_type") ?? existing ?? "subagent";
  return rawName || existing || "tool";
}

function updateTextPartAndGetDelta(
  part: Record<string, unknown>,
  explicitDelta: string | undefined,
  state: ObserveState,
): string | undefined {
  const messageId = getObjectString(part, "messageID");
  if (!messageId) return explicitDelta;

  const partId = getObjectString(part, "id") ?? `${messageId}:text`;
  const parts = getMessageTextParts(messageId, state);
  const previous = parts.get(partId) ?? "";
  const fullText = getObjectString(part, "text");

  if (explicitDelta !== undefined) {
    parts.set(partId, fullText ?? `${previous}${explicitDelta}`);
    return explicitDelta.length > 0 ? explicitDelta : undefined;
  }

  if (fullText === undefined || fullText === previous) return undefined;

  parts.set(partId, fullText);
  return fullText.startsWith(previous) ? fullText.slice(previous.length) : fullText;
}

function getMessageTextParts(messageId: string, state: ObserveState): Map<string, string> {
  const existing = state.textPartsByMessageId.get(messageId);
  if (existing) return existing;

  const parts = new Map<string, string>();
  state.textPartsByMessageId.set(messageId, parts);
  return parts;
}

function collectMessageText(messageId: string, state: ObserveState): string {
  return [...(state.textPartsByMessageId.get(messageId)?.values() ?? [])]
    .filter((text) => text.length > 0)
    .join("\n\n");
}

function permissionSummary(properties: Record<string, unknown>): string {
  return (
    getObjectString(properties, "title") ??
    getObjectString(properties, "permission") ??
    getObjectString(properties, "action") ??
    getObjectString(properties, "type") ??
    "OpenCode permission request"
  );
}

function toolSummary(
  rawName: string,
  input: Record<string, unknown> | undefined,
  title: string | undefined,
  error: string | undefined,
  existing: string | undefined,
): string | undefined {
  if (error) return error;
  if (rawName === "task") return getObjectString(input, "description") ?? title ?? existing;
  if (rawName === "skill") return title ?? existing;
  if (rawName === "todowrite") return todoInputSummary(input) ?? title ?? existing;
  return title ?? existing;
}

function rememberSubagentSession(rawName: string, metadata: Record<string, unknown> | undefined, state: ObserveState): void {
  if (rawName !== "task") return;

  const sessionId = getObjectString(metadata, "sessionId") ?? getObjectString(metadata, "sessionID");
  if (!sessionId) return;

  state.childSessionIds.add(sessionId);
}

function sessionNextToolSummary(properties: Record<string, unknown>): string | undefined {
  return (
    getObjectString(properties, "title") ??
    contentSummary(properties.content) ??
    structuredSummary(getObject(properties, "structured")) ??
    resultSummary(properties.result)
  );
}

function contentSummary(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;

  for (const item of content) {
    const text = getObjectString(item, "text") ?? getObjectString(item, "value");
    if (text) return singleLine(text, 160);
  }

  return undefined;
}

function structuredSummary(value: Record<string, unknown> | undefined): string | undefined {
  if (!value) return undefined;

  return (
    getObjectString(value, "title") ??
    getObjectString(value, "summary") ??
    getObjectString(value, "message") ??
    getObjectString(value, "status")
  );
}

function resultSummary(value: unknown): string | undefined {
  if (typeof value === "string") return singleLine(value, 160);
  const object = asObject(value);
  if (!object) return undefined;

  return structuredSummary(object);
}

function todoInputSummary(input: Record<string, unknown> | undefined): string | undefined {
  const todos = input?.todos;
  if (!Array.isArray(todos)) return undefined;

  return `${todos.length} todo${todos.length === 1 ? "" : "s"}`;
}

function singleLine(value: string, maxLength: number): string {
  const text = value.replaceAll(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(maxLength - 1, 0)).trimEnd()}...`;
}

function diagnosticEvent(label: string, summary: string | undefined): { events: RuntimeEvent[]; terminal: boolean } {
  return { events: [{ type: "diagnostic", label, summary }], terminal: false };
}

function costSuffix(cost: number | undefined): string {
  return cost === undefined ? "" : `, $${cost.toFixed(4)}`;
}

function formatModelRef(model: Record<string, unknown> | undefined): string | undefined {
  if (!model) return undefined;

  const providerId = getObjectString(model, "providerID") ?? getObjectString(model, "providerId");
  const modelId = getObjectString(model, "modelID") ?? getObjectString(model, "modelId") ?? getObjectString(model, "id");
  if (!providerId && !modelId) return undefined;

  return providerId && modelId ? `${providerId}/${modelId}` : providerId ?? modelId;
}

function partBelongsToObservedTurn(part: Record<string, unknown>, state: ObserveState): boolean {
  const messageId = getObjectString(part, "messageID");
  if (!state.turnId || !messageId) return true;
  if (messageId === state.turnId) return false;
  // startTurn snapshots the session before prompting. Event streams may replay
  // old assistant parts; never let those become candidates for the new turn.
  if (state.hasBeforeMessageSnapshot && state.beforeMessageIds.has(messageId)) return false;
  if (state.assistantMessageIds.size === 0) return true;
  return state.assistantMessageIds.has(messageId);
}

function messageBelongsToObservedTurn(
  messageId: string | undefined,
  parentId: string | undefined,
  state: ObserveState,
): boolean {
  if (!state.turnId) return true;
  if (parentId === state.turnId) return true;
  if (messageId && state.assistantMessageIds.has(messageId)) return true;
  // Real OpenCode follow-ups may report the assistant's parent as OpenCode's
  // own user message id instead of the gateway-supplied messageID. In that
  // case, a post-snapshot assistant message in the observed session is the turn.
  return Boolean(messageId && state.hasBeforeMessageSnapshot && !state.beforeMessageIds.has(messageId));
}

function matchesSession(properties: Record<string, unknown>, state: ObserveState): boolean {
  return getObjectString(properties, "sessionID") === state.sessionId;
}

function relatedSessionKind(sessionId: string, state: ObserveState): "primary" | "subagent" | undefined {
  if (sessionId === state.sessionId) return "primary";
  if (state.childSessionIds.has(sessionId)) return "subagent";
  return undefined;
}

function questionChoices(question: Record<string, unknown> | undefined): string[] | undefined {
  if (!question || !Array.isArray(question.options)) return undefined;

  const labels = question.options
    .map((option) => getObjectString(option, "label"))
    .filter(isNonEmptyString);

  return labels.length > 0 ? labels : undefined;
}

function parseTodos(value: unknown): RuntimeTodo[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const todos: RuntimeTodo[] = [];
  for (const item of value) {
    const todo = asObject(item);
    const content = getObjectString(todo, "content");
    const status = getObjectString(todo, "status");
    if (!content || !status) continue;

    todos.push({
      content,
      status,
      priority: getObjectString(todo, "priority"),
    });
  }

  return todos;
}

function eventProperties(event: Record<string, unknown>): Record<string, unknown> {
  return getObject(event, "properties") ?? getObject(event, "payload") ?? {};
}

function unwrapSdkEvent(value: unknown): Record<string, unknown> | undefined {
  const event = asObject(value);
  if (!event) return undefined;
  if (getObjectString(event, "type")) return event;

  const data = getObject(event, "data");
  return data && getObjectString(data, "type") ? data : undefined;
}

async function closeEventStream(stream: AsyncIterable<unknown>): Promise<void> {
  const maybeReturn = (stream as unknown as AsyncIterator<unknown>).return;
  if (typeof maybeReturn === "function") await maybeReturn.call(stream);
}

interface ObservedEventPumpInput {
  subscription: SdkEventSubscription;
  client: OpenCodeSdkClient;
  target: RuntimeTarget;
  state: ObserveState;
  fetch: FetchLike;
  signal?: AbortSignal;
  initialBackfill?: boolean;
  reconcileIntervalMs: number;
  reconcileTimeoutMs: number;
  permissionPollIntervalMs: number;
  idleNoAssistantGraceMs: number;
}

interface ObservedEventPump {
  events: AsyncIterable<RuntimeEvent>;
  ready: Promise<void>;
  push(event: RuntimeEvent): void;
  cancel(): Promise<void>;
}

function startObservedEventPump(input: ObservedEventPumpInput): ObservedEventPump {
  let closed = false;
  let readyResolved = false;
  let resolveReady: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const queue = new RuntimeEventQueue(closeOnce);

  void pump();
  void pollPermissions();

  return {
    events: queue,
    ready,
    push: (event) => queue.push(event),
    cancel: () => queue.cancel(),
  };

  function markReady(): void {
    if (readyResolved) return;

    readyResolved = true;
    resolveReady();
  }

  async function closeOnce(): Promise<void> {
    if (closed) return;

    closed = true;
    await closeEventStream(input.subscription.stream);
  }

  async function pump(): Promise<void> {
    try {
      const iterator = input.subscription.stream[Symbol.asyncIterator]();
      let nextPromise = iterator.next();

      markReady();

      if (input.initialBackfill && input.state.turnId) {
        const terminal = await reconcileWithTimeout();

        if (terminal) {
          queue.push(terminal);
          queue.end();
          return;
        }
      }

      while (!input.signal?.aborted) {
        const outcome = input.state.turnId
          ? await Promise.race([
              nextPromise.then((result) => ({ type: "event" as const, result })),
              sleep(Math.max(input.reconcileIntervalMs, 1)).then(() => ({ type: "reconcile" as const })),
            ])
          : { type: "event" as const, result: await nextPromise };

        if (outcome.type === "reconcile") {
          const terminal = await reconcileTerminalFromMessages();

          if (terminal) {
            queue.push(terminal);
            queue.end();
            return;
          }

          const idleError = await idleNoAssistantError();

          if (idleError) {
            queue.push(idleError);
            queue.end();
            return;
          }

          continue;
        }

        const result = outcome.result;

        if (result.done) {
          const terminal = await reconcileTerminalFromMessages();

          if (terminal) {
            queue.push(terminal);
            queue.end();
            return;
          }

          break;
        }

        nextPromise = iterator.next();
        const terminal = await pushNormalizedEvent(result.value);
        if (terminal) break;
      }

      queue.end();
    } catch (error) {
      if (!input.signal?.aborted) {
        queue.push({ type: "error", message: `OpenCode event stream failed: ${formatRuntimeError(error)}`, retryable: true });
      }

      queue.end();
    } finally {
      markReady();
      await closeOnce();
    }
  }

  async function pollPermissions(): Promise<void> {
    if (input.permissionPollIntervalMs <= 0) return;

    while (!closed && !input.signal?.aborted) {
      await sleep(input.permissionPollIntervalMs);
      if (closed || input.signal?.aborted) return;

      const events = await pollPendingPermissionEvents(input.fetch, input.target, input.state).catch(() => []);
      for (const event of events) {
        queue.push(event);
      }
    }
  }

  async function pushNormalizedEvent(sdkEvent: unknown): Promise<boolean> {
    const normalized = normalizeSdkEvent(sdkEvent, input.state);

    for (const event of normalized.events) {
      if (event.type === "status" && event.status === "idle" && input.state.turnId) {
        const terminal = await reconcileTerminalFromMessages();

        if (terminal) {
          queue.push(terminal);
          queue.end();
          return true;
        }
      }

      queue.push(event);
    }

    if (normalized.terminal) {
      queue.end();
      return true;
    }

    return false;
  }

  async function reconcileTerminalFromMessages(): Promise<Extract<RuntimeEvent, { type: "final" | "error" }> | undefined> {
    if (!input.state.turnId) return resolvePendingFinal(input.state);

    const terminal = await reconcileWithTimeout();

    if (terminal) {
      clearPendingFinal(input.state);
      return terminal;
    }

    return resolvePendingFinal(input.state);
  }

  async function reconcileWithTimeout(): Promise<Extract<RuntimeEvent, { type: "final" | "error" }> | undefined> {
    if (!input.state.turnId) return undefined;

    return promiseWithTimeout(findTerminalEventFromMessages(
      input.client,
      input.target,
      input.state.sessionId,
      input.state.turnId,
      input.state,
    ), input.reconcileTimeoutMs);
  }

  async function idleNoAssistantError(): Promise<Extract<RuntimeEvent, { type: "error" }> | undefined> {
    if (!input.state.turnId || input.state.pendingPermissionIds.size > 0) return undefined;

    const detected = await promiseWithTimeout(detectIdleWithoutAssistant(
      input.fetch,
      input.client,
      input.target,
      input.state.sessionId,
      input.state.turnId,
      input.state,
      input.idleNoAssistantGraceMs,
    ), input.reconcileTimeoutMs);

    return detected;
  }
}

function noEvents(): { events: RuntimeEvent[]; terminal: boolean } {
  return { events: [], terminal: false };
}

async function pollPendingPermissionEvents(
  fetchImpl: FetchLike,
  target: RuntimeTarget,
  state: ObserveState,
): Promise<Array<Extract<RuntimeEvent, { type: "permission_request" }>>> {
  const requests = [
    ...(await fetchPermissionList(fetchImpl, target, `/api/session/${encodeURIComponent(state.sessionId)}/permission/request`, false)),
    ...(await fetchPermissionList(fetchImpl, target, "/permission", true)),
  ];
  const events: Array<Extract<RuntimeEvent, { type: "permission_request" }>> = [];

  for (const request of requests) {
    const event = normalizePolledPermissionRequest(request, state);
    if (event) events.push(event);
  }

  return events;
}

async function detectIdleWithoutAssistant(
  fetchImpl: FetchLike,
  client: OpenCodeSdkClient,
  target: RuntimeTarget,
  sessionId: string,
  turnId: string,
  state: ObserveState,
  graceMs: number,
): Promise<Extract<RuntimeEvent, { type: "error" }> | undefined> {
  const messages = await listMessages(client, target, sessionId).catch(() => []);
  if (!messages.some((message) => message.info?.role === "user" && message.info.id === turnId)) {
    state.idleNoAssistantSinceMs = undefined;
    return undefined;
  }

  if (messages.some((message) => message.info?.role === "assistant" && messageBelongsToObservedTurn(message.info.id, message.info.parentID, state))) {
    state.idleNoAssistantSinceMs = undefined;
    return undefined;
  }

  const idle = await isSessionIdle(fetchImpl, target, sessionId);
  if (!idle) {
    state.idleNoAssistantSinceMs = undefined;
    return undefined;
  }

  const nowMs = Date.now();
  state.idleNoAssistantSinceMs ??= nowMs;
  if (nowMs - state.idleNoAssistantSinceMs < graceMs) return undefined;

  return {
    type: "error",
    message: `OpenCode accepted prompt ${turnId} but is idle without an assistant response.`,
    retryable: true,
  };
}

async function isSessionIdle(fetchImpl: FetchLike, target: RuntimeTarget, sessionId: string): Promise<boolean | undefined> {
  const url = targetApiUrl(target, "/session/status");
  if (!url) return undefined;

  if (target.workdir) url.searchParams.set("directory", target.workdir);

  const response = await fetchImpl(url);
  if (!response.ok) return undefined;

  const body = asObject(await response.json().catch(() => undefined));
  const status = asObject(body?.[sessionId]);
  const type = status ? getObjectString(status, "type") : undefined;

  return type === undefined || type === "idle";
}

async function fetchPermissionList(
  fetchImpl: FetchLike,
  target: RuntimeTarget,
  path: string,
  includeDirectory: boolean,
): Promise<unknown[]> {
  const url = targetApiUrl(target, path);
  if (!url) return [];

  if (includeDirectory && target.workdir) {
    url.searchParams.set("directory", target.workdir);
  }

  const response = await fetchImpl(url);
  if (!response.ok) return [];

  const body = await response.json().catch(() => undefined);
  if (Array.isArray(body)) return body;

  const record = asObject(body);
  const data = record?.data;
  return Array.isArray(data) ? data : [];
}

function normalizePolledPermissionRequest(
  value: unknown,
  state: ObserveState,
): Extract<RuntimeEvent, { type: "permission_request" }> | undefined {
  const request = asObject(value);
  if (!request) return undefined;

  const sessionId = getObjectString(request, "sessionID");
  if (sessionId !== state.sessionId) return undefined;

  const id = getObjectString(request, "id") ?? getObjectString(request, "requestID");
  if (!id || state.pendingPermissionIds.has(id)) return undefined;

  const source = getObject(request, "source") ?? getObject(request, "tool");
  const action = getObjectString(request, "action");
  const permission = getObjectString(request, "permission");
  state.pendingPermissionIds.add(id);

  return {
    type: "permission_request",
    id,
    summary: getObjectString(request, "title") ?? permission ?? action ?? "OpenCode permission request",
    details: compactObject({
      eventType: "permission.poll",
      type: getObjectString(source, "type"),
      permission,
      action,
      resources: request.resources,
      resource: request.resource,
      patterns: request.patterns,
      pattern: request.pattern,
      save: request.save,
      always: request.always,
      messageID: getObjectString(source, "messageID"),
      callID: getObjectString(source, "callID"),
      metadata: request.metadata,
    }),
  };
}

async function forwardSideChannelEvents(
  events: AsyncIterable<RuntimeEvent>,
  queue: RuntimeEventQueue,
  options: { progress: boolean; permissions: boolean },
  signal?: AbortSignal,
): Promise<void> {
  for await (const event of events) {
    if (signal?.aborted) return;
    if (options.permissions && event.type === "permission_request") queue.push(event);
    if (options.progress && isProgressEvent(event)) queue.push(event);
  }
}

function isProgressEvent(event: RuntimeEvent): boolean {
  return event.type === "tool_start" ||
    event.type === "tool_update" ||
    event.type === "tool_end" ||
    event.type === "todo_update" ||
    event.type === "diagnostic" ||
    event.type === "question_request" ||
    event.type === "status";
}

export class OpenCodeRuntime implements AgentRuntime {
  private readonly createClient: (target: RuntimeTarget) => OpenCodeSdkClient;
  private readonly fetch: FetchLike;
  private readonly finalResponseTimeoutMs: number;
  private readonly finalResponsePollIntervalMs: number;
  private readonly observeReconcileIntervalMs: number;
  private readonly observeReconcileTimeoutMs: number;
  private readonly permissionPollIntervalMs: number;
  private readonly idleNoAssistantGraceMs: number;
  private readonly clients = new Map<string, OpenCodeSdkClient>();

  constructor(options: OpenCodeRuntimeOptions = {}) {
    this.createClient =
      options.createClient ??
      ((target) => createOpencodeClient({ baseUrl: target.serverUrl }) as OpenCodeSdkClient);
    this.fetch = options.fetch ?? fetch;
    this.finalResponseTimeoutMs = options.finalResponseTimeoutMs ?? 60_000;
    this.finalResponsePollIntervalMs = options.finalResponsePollIntervalMs ?? 1_000;
    this.observeReconcileIntervalMs = options.observeReconcileIntervalMs ?? DEFAULT_OBSERVE_RECONCILE_INTERVAL_MS;
    this.observeReconcileTimeoutMs = options.observeReconcileTimeoutMs ?? DEFAULT_OBSERVE_RECONCILE_TIMEOUT_MS;
    this.permissionPollIntervalMs = options.permissionPollIntervalMs ?? DEFAULT_PERMISSION_POLL_INTERVAL_MS;
    this.idleNoAssistantGraceMs = options.idleNoAssistantGraceMs ?? DEFAULT_IDLE_NO_ASSISTANT_GRACE_MS;
  }

  async ensureSession(input: EnsureSessionInput): Promise<RuntimeSession> {
    const client = this.getClient(input.target);

    if (input.sessionId) {
      const session = await unwrapSdkResult(
        client.session.get({
          path: { id: input.sessionId },
          query: directoryQuery(input.target),
        }),
        `Unable to load OpenCode session ${input.sessionId}`,
      );

      return mapSession(input.target, session);
    }

    const session = await unwrapSdkResult(
      client.session.create({
        body: input.title ? { title: input.title } : {},
        query: directoryQuery(input.target),
      }),
      "Unable to create OpenCode session",
    );

    return mapSession(input.target, session);
  }

  async send(input: SendRuntimeMessageInput): Promise<RuntimeTurn> {
    if (input.attachments && input.attachments.length > 0) {
      throw new OpenCodeRuntimeError("OpenCodeRuntime does not support attachments in Phase 1");
    }

    const client = this.getClient(input.target);
    const model = parseModelRef(input.model);
    const beforeMessages = await listMessages(client, input.target, input.sessionId).catch(() => []);
    const beforeMessageIds = new Set(beforeMessages.map((message) => message.info?.id).filter(isNonEmptyString));
    const response = await unwrapSdkResult(
      client.session.prompt({
        path: { id: input.sessionId },
        query: directoryQuery(input.target),
        body: {
          agent: input.agent,
          model,
          parts: [{ type: "text", text: input.text }],
        },
      }),
      `Unable to send prompt to OpenCode session ${input.sessionId}`,
    );

    if (isPromptResponse(response)) {
      return mapTurn(input.sessionId, response);
    }

    return waitForAssistantTurn({
      client,
      target: input.target,
      sessionId: input.sessionId,
      beforeMessageIds,
      timeoutMs: this.finalResponseTimeoutMs,
      pollIntervalMs: this.finalResponsePollIntervalMs,
    });
  }

  async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    if (input.mode === "sync") return this.startSyncTurn(input);

    if (input.attachments && input.attachments.length > 0) {
      throw new OpenCodeRuntimeError("OpenCodeRuntime does not support attachments in Phase 2");
    }

    const client = this.getClient(input.target);
    const model = parseModelRef(input.model);
    const messageId = createGatewayMessageId();
    const beforeMessages = await listMessages(client, input.target, input.sessionId).catch(() => []);
    const beforeMessageIds = new Set(beforeMessages.map((message) => message.info?.id).filter(isNonEmptyString));
    let subscription: SdkEventSubscription;

    try {
      subscription = await this.subscribeToEvents(client, input.target, input.signal);
    } catch (error) {
      throw new OpenCodeRuntimeError(
        `Unable to observe OpenCode events before async prompt to OpenCode session ${input.sessionId}: ${formatRuntimeError(error)}`,
        { cause: error },
      );
    }

    const observed = startObservedEventPump({
      subscription,
      client,
      target: input.target,
      state: createObserveState(input.sessionId, messageId, beforeMessageIds),
      fetch: this.fetch,
      signal: input.signal,
      reconcileIntervalMs: this.observeReconcileIntervalMs,
      reconcileTimeoutMs: this.observeReconcileTimeoutMs,
      permissionPollIntervalMs: this.permissionPollIntervalMs,
      idleNoAssistantGraceMs: this.idleNoAssistantGraceMs,
    });

    await observed.ready;

    try {
      const promptTask = unwrapSdkVoidResult(
        client.session.promptAsync({
          path: { id: input.sessionId },
          query: directoryQuery(input.target),
          body: {
            messageID: messageId,
            agent: input.agent,
            model,
            parts: [{ type: "text", text: input.text }],
          },
        }),
        `Unable to send async prompt to OpenCode session ${input.sessionId}`,
      );

      promptTask.catch((error) => {
        if (!input.signal?.aborted) {
          observed.push({ type: "error", message: formatRuntimeError(error), retryable: true });
        }
      });

      return {
        handle: createRuntimeTurnHandle(input, messageId, { mode: "async" }),
        events: observed.events,
      };
    } catch (error) {
      await observed.cancel();
      throw error;
    }
  }

  async sendAsync(input: SendRuntimeMessageInput): Promise<RuntimeTurnHandle> {
    if (input.attachments && input.attachments.length > 0) {
      throw new OpenCodeRuntimeError("OpenCodeRuntime does not support attachments in Phase 2");
    }

    const client = this.getClient(input.target);
    const model = parseModelRef(input.model);
    const messageId = createGatewayMessageId();
    const response = await unwrapSdkVoidResult(
      client.session.promptAsync({
        path: { id: input.sessionId },
        query: directoryQuery(input.target),
        body: {
          messageID: messageId,
          agent: input.agent,
          model,
          parts: [{ type: "text", text: input.text }],
        },
      }),
      `Unable to send async prompt to OpenCode session ${input.sessionId}`,
    );

    return createRuntimeTurnHandle(input, messageId, response);
  }

  private startSyncTurn(input: StartRuntimeTurnInput): RuntimeStartedTurn {
    const messageId = createGatewayMessageId();
    const queue = new RuntimeEventQueue();

    void (async () => {
      let permissionObserver: ObservedEventPump | undefined;
      let permissionForwarder: Promise<void> | undefined;

      try {
        if (input.observePermissions || input.observeProgress) {
          const sideChannel = await this.startSyncSideChannelObserver(input, queue).catch((error) => {
            if (!input.signal?.aborted) {
              queue.push({
                type: "diagnostic",
                label: "Observer",
                summary: `OpenCode progress observation unavailable: ${formatRuntimeError(error)}`,
              });
            }

            return undefined;
          });

          permissionObserver = sideChannel?.observer;
          permissionForwarder = sideChannel?.forwarder;
        }

        const turn = await this.send(input);

        if (input.signal?.aborted) return;

        if (turn.status === "error") {
          queue.push({ type: "error", message: turn.text ?? "OpenCode returned an error response", retryable: undefined });
          return;
        }

        queue.push({
          type: "final",
          text: turn.text ?? "",
          costUsd: turn.costUsd,
          tokens: turn.tokens,
        });
      } catch (error) {
        if (!input.signal?.aborted) {
          queue.push({ type: "error", message: formatRuntimeError(error), retryable: undefined });
        }
      } finally {
        await permissionObserver?.cancel();
        await permissionForwarder?.catch(() => undefined);
        queue.end();
      }
    })();

    return {
      handle: createRuntimeTurnHandle(input, messageId, { mode: "sync" }),
      events: queue,
    };
  }

  private async startSyncSideChannelObserver(
    input: StartRuntimeTurnInput,
    queue: RuntimeEventQueue,
  ): Promise<{ observer: ObservedEventPump; forwarder: Promise<void> }> {
    const client = this.getClient(input.target);
    const subscription = await this.subscribeToEvents(client, input.target, input.signal);
    const observer = startObservedEventPump({
      subscription,
      client,
      target: input.target,
      state: createObserveState(input.sessionId, undefined),
      fetch: this.fetch,
      signal: input.signal,
      reconcileIntervalMs: this.observeReconcileIntervalMs,
      reconcileTimeoutMs: this.observeReconcileTimeoutMs,
      permissionPollIntervalMs: this.permissionPollIntervalMs,
      idleNoAssistantGraceMs: this.idleNoAssistantGraceMs,
    });
    const forwarder = forwardSideChannelEvents(
      observer.events,
      queue,
      { progress: Boolean(input.observeProgress), permissions: Boolean(input.observePermissions) },
      input.signal,
    );

    await observer.ready;

    return { observer, forwarder };
  }

  async *observe(input: ObserveRuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    const client = this.getClient(input.target);

    if (input.signal?.aborted) return;

    let subscription: SdkEventSubscription;

    try {
      subscription = await this.subscribeToEvents(client, input.target, input.signal);
    } catch (error) {
      if (!input.signal?.aborted) {
        yield { type: "error", message: `Unable to observe OpenCode events: ${formatRuntimeError(error)}`, retryable: true };
      }
      return;
    }

    const observed = startObservedEventPump({
      subscription,
      client,
      target: input.target,
      state: createObserveState(input.sessionId, input.turnId),
      fetch: this.fetch,
      signal: input.signal,
      initialBackfill: true,
      reconcileIntervalMs: this.observeReconcileIntervalMs,
      reconcileTimeoutMs: this.observeReconcileTimeoutMs,
      permissionPollIntervalMs: this.permissionPollIntervalMs,
      idleNoAssistantGraceMs: this.idleNoAssistantGraceMs,
    });

    try {
      await observed.ready;

      for await (const event of observed.events) {
        yield event;
      }
    } finally {
      await observed.cancel();
    }
  }

  private async subscribeToEvents(
    client: OpenCodeSdkClient,
    target: RuntimeTarget,
    signal: AbortSignal | undefined,
  ): Promise<SdkEventSubscription> {
    return client.event.subscribe({
      query: directoryQuery(target),
      signal,
    });
  }

  async abort(input: AbortRuntimeTurnInput): Promise<void> {
    const client = this.getClient(input.target);

    await unwrapSdkResult(
      client.session.abort({
        path: { id: input.sessionId },
        query: directoryQuery(input.target),
      }),
      `Unable to abort OpenCode session ${input.sessionId}`,
    );
  }

  async respondToPermission(input: PermissionResponseInput): Promise<void> {
    const client = this.getClient(input.target);
    const respond = client.postSessionIdPermissionsPermissionId;
    const response = permissionSdkResponse(input.decision);
    const errors: string[] = [];

    const modernEndpoints = [
      permissionReplyEndpoint(input.target, `/api/session/${encodeURIComponent(input.sessionId)}/permission/request/${encodeURIComponent(input.permissionId)}/reply`, false),
      permissionReplyEndpoint(input.target, `/permission/${encodeURIComponent(input.permissionId)}/reply`, true),
    ].filter(isNonEmptyString);

    for (const endpoint of modernEndpoints) {
      const result = await postPermissionReply(this.fetch, endpoint, response, input.message);
      if (result.ok) return;
      errors.push(result.error);
    }

    if (respond) {
      try {
        await unwrapSdkResult(
          respond.call(client, {
            path: { id: input.sessionId, permissionID: input.permissionId },
            query: directoryQuery(input.target),
            body: { response },
          }),
          `Unable to respond to OpenCode permission ${input.permissionId}`,
        );
        return;
      } catch (error) {
        errors.push(formatRuntimeError(error));
      }
    } else {
      errors.push("OpenCode SDK client does not expose a permission response endpoint");
    }

    throw new OpenCodeRuntimeError(
      `Unable to respond to OpenCode permission ${input.permissionId}: ${errors.filter(Boolean).join("; ")}`,
    );
  }

  async listSessions(input: ListRuntimeSessionsInput): Promise<RuntimeSession[]> {
    const client = this.getClient(input.target);
    const sessions = await unwrapSdkResult(
      client.session.list({ query: directoryQuery(input.target) }),
      "Unable to list OpenCode sessions",
    );

    const mapped = sessions
      .map((session) => mapSession(input.target, session))
      .sort((left, right) => compareOptionalIsoDesc(left.updatedAt, right.updatedAt));

    return input.limit === undefined ? mapped : mapped.slice(0, input.limit);
  }

  async listAgents(input: ListRuntimeAgentsInput): Promise<RuntimeAgent[]> {
    const client = this.getClient(input.target);
    const agents = await unwrapSdkResult(
      client.app.agents({ query: directoryQuery(input.target) }),
      "Unable to list OpenCode agents",
    );

    return agents
      .filter(isPrimarySelectableAgent)
      .map(mapAgent)
      .filter((agent): agent is RuntimeAgent => agent !== undefined)
      .sort((left, right) => left.id.localeCompare(right.id));
  }

  async listModels(input: ListRuntimeModelsInput): Promise<RuntimeModel[]> {
    const client = this.getClient(input.target);
    const response = await unwrapSdkResult(
      client.config.providers({ query: directoryQuery(input.target) }),
      "Unable to list OpenCode models",
    );

    return mapModels(response).sort((left, right) => left.id.localeCompare(right.id));
  }

  private getClient(target: RuntimeTarget): OpenCodeSdkClient {
    validateAttachTarget(target);

    const key = `${target.id}:${target.serverUrl ?? ""}`;
    const cached = this.clients.get(key);

    if (cached) return cached;

    const client = this.createClient(target);
    this.clients.set(key, client);
    return client;
  }
}

async function findTerminalEventFromMessages(
  client: OpenCodeSdkClient,
  target: RuntimeTarget,
  sessionId: string,
  turnId: string,
  state: ObserveState,
): Promise<Extract<RuntimeEvent, { type: "final" | "error" }> | undefined> {
  const messages = await listMessages(client, target, sessionId).catch(() => []);
  let matchingTerminal = messages.filter(
    (message) => message.info?.role === "assistant" && message.info.parentID === turnId && isTerminalAssistantMessage(message.info),
  );

  if (matchingTerminal.length === 0) {
    const turnIndex = messages.findIndex((message) => message.info?.role === "user" && message.info.id === turnId);

    if (turnIndex >= 0) {
      matchingTerminal = messages
        .slice(turnIndex + 1)
        .filter((message) => message.info?.role === "assistant" && isTerminalAssistantMessage(message.info));
    }
  }

  if (matchingTerminal.length === 0 && state.hasBeforeMessageSnapshot) {
    matchingTerminal = messages.filter(
      (message) =>
        message.info?.role === "assistant" &&
        isTerminalAssistantMessage(message.info) &&
        Boolean(message.info.id && !state.beforeMessageIds.has(message.info.id)),
    );
  }

  const assistant = [...matchingTerminal].reverse().find((message) => finalAssistantText(message).trim().length > 0 || message.info?.error !== undefined) ?? matchingTerminal.at(-1);

  if (!assistant?.info?.id || state.finalizedMessageIds.has(assistant.info.id)) return undefined;

  state.finalizedMessageIds.add(assistant.info.id);

  if (assistant.info.error !== undefined) {
    return {
      type: "error",
      message: formatRuntimeError(assistant.info.error),
      retryable: isRetryableRuntimeError(assistant.info.error),
    };
  }

  return {
    type: "final",
    text: finalAssistantText(assistant),
    costUsd: assistant.info.cost,
    tokens: mapTokenUsage(assistant.info.tokens),
  };
}

function resolvePendingFinal(state: ObserveState): Extract<RuntimeEvent, { type: "final" }> | undefined {
  const pending = state.pendingFinal;
  const messageId = state.pendingFinalMessageId;

  if (!pending || !messageId || state.finalizedMessageIds.has(messageId)) return undefined;
  const collectedText = collectMessageText(messageId, state);
  const text = collectedText.trim() ? collectedText : pending.text;
  if (!text.trim()) return undefined;

  state.finalizedMessageIds.add(messageId);
  clearPendingFinal(state);

  return { ...pending, text };
}

function clearPendingFinal(state: ObserveState): void {
  state.pendingFinal = undefined;
  state.pendingFinalMessageId = undefined;
}

function isCompletedAssistantMessage(info: SdkAssistantMessage | undefined): boolean {
  if (!info) return false;
  if (info.finish === "tool-calls") return false;

  return info.time?.completed !== undefined || info.finish !== undefined;
}

function isTerminalAssistantMessage(info: SdkAssistantMessage | undefined): boolean {
  return Boolean(info?.error !== undefined || isCompletedAssistantMessage(info));
}

function finalAssistantText(message: SdkMessageEntry): string {
  return extractAssistantText(message.parts ?? []);
}

function validateAttachTarget(target: RuntimeTarget): void {
  if (target.mode !== "attach") {
    throw new OpenCodeRuntimeError(
      `OpenCode target ${target.id} uses mode ${target.mode}; Phase 1 only supports attach mode`,
    );
  }

  if (!target.serverUrl) {
    throw new OpenCodeRuntimeError(`OpenCode target ${target.id} is missing serverUrl`);
  }
}

function targetApiUrl(target: RuntimeTarget, path: string): URL | undefined {
  if (!target.serverUrl) return undefined;

  return new URL(path, target.serverUrl.endsWith("/") ? target.serverUrl : `${target.serverUrl}/`);
}

function permissionReplyEndpoint(target: RuntimeTarget, path: string, includeDirectory: boolean): string | undefined {
  const url = targetApiUrl(target, path);
  if (!url) return undefined;

  if (includeDirectory && target.workdir) {
    url.searchParams.set("directory", target.workdir);
  }

  return url.toString();
}

async function postPermissionReply(
  fetchImpl: FetchLike,
  endpoint: string,
  reply: "once" | "always" | "reject",
  message: string | undefined,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(compactObject({ reply, message })),
    });

    if (response.ok) return { ok: true };

    return { ok: false, error: `${endpoint} returned ${response.status}: ${await responseText(response)}` };
  } catch (error) {
    return { ok: false, error: `${endpoint} failed: ${formatRuntimeError(error)}` };
  }
}

async function responseText(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");

  return text.trim() || response.statusText || "unknown error";
}

function directoryQuery(target: RuntimeTarget): { directory?: string } | undefined {
  return target.workdir ? { directory: target.workdir } : undefined;
}

async function unwrapSdkResult<T>(resultPromise: Promise<SdkResult<T>>, message: string): Promise<T> {
  try {
    const result = await resultPromise;

    if (isSdkFieldsResult<T>(result)) {
      if (result.error !== undefined) {
        throw new OpenCodeRuntimeError(`${message}: ${formatRuntimeError(result.error)}`, {
          cause: result.error,
        });
      }

      if (result.data === undefined) {
        throw new OpenCodeRuntimeError(`${message}: empty response`);
      }

      return result.data;
    }

    if (result === undefined) {
      throw new OpenCodeRuntimeError(`${message}: empty response`);
    }

    return result;
  } catch (error) {
    if (error instanceof OpenCodeRuntimeError) throw error;

    throw new OpenCodeRuntimeError(`${message}: ${formatRuntimeError(error)}`, { cause: error });
  }
}

async function unwrapSdkVoidResult(resultPromise: Promise<SdkResult<void>>, message: string): Promise<unknown> {
  try {
    const result = await resultPromise;

    if (isSdkFieldsResult<void>(result)) {
      if (result.error !== undefined) {
        throw new OpenCodeRuntimeError(`${message}: ${formatRuntimeError(result.error)}`, {
          cause: result.error,
        });
      }

      return result.data;
    }

    return result;
  } catch (error) {
    if (error instanceof OpenCodeRuntimeError) throw error;

    throw new OpenCodeRuntimeError(`${message}: ${formatRuntimeError(error)}`, { cause: error });
  }
}

async function waitForAssistantTurn(input: {
  client: OpenCodeSdkClient;
  target: RuntimeTarget;
  sessionId: string;
  beforeMessageIds: Set<string>;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<RuntimeTurn> {
  const deadline = Date.now() + input.timeoutMs;
  let latestMessages: SdkMessageEntry[] = [];

  do {
    latestMessages = await listMessages(input.client, input.target, input.sessionId);

    const assistant = latestMessages.find(
      (message) => message.info?.role === "assistant" && !messageIdWasSeen(message, input.beforeMessageIds),
    );

    if (assistant) {
      return mapTurn(input.sessionId, {
        info: assistant.info,
        parts: assistant.parts ?? [],
      });
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;

    await sleep(Math.min(input.pollIntervalMs, remainingMs));
  } while (true);

  return {
    sessionId: input.sessionId,
    status: "error",
    text: noAssistantResponseText(input.timeoutMs, latestMessages),
    raw: { messages: latestMessages },
  };
}

async function listMessages(
  client: OpenCodeSdkClient,
  target: RuntimeTarget,
  sessionId: string,
): Promise<SdkMessageEntry[]> {
  if (!client.session.messages) return [];

  return unwrapSdkResult(
    client.session.messages({
      path: { id: sessionId },
      query: directoryQuery(target),
    }),
    `Unable to list OpenCode messages for session ${sessionId}`,
  );
}

function isPromptResponse(value: SdkPromptResponse): boolean {
  return Boolean(value.info || (Array.isArray(value.parts) && value.parts.length > 0));
}

function messageIdWasSeen(message: SdkMessageEntry, seen: Set<string>): boolean {
  const id = message.info?.id;

  return typeof id === "string" && seen.has(id);
}

function noAssistantResponseText(timeoutMs: number, messages: SdkMessageEntry[]): string {
  const latestUser = [...messages].reverse().find((message) => message.info?.role === "user");
  const model = latestUser?.info?.model;
  const modelRef = model?.providerID && model.modelID ? `${model.providerID}/${model.modelID}` : undefined;
  const details = [latestUser?.info?.agent ? `agent ${latestUser.info.agent}` : undefined, modelRef ? `model ${modelRef}` : undefined]
    .filter(Boolean)
    .join(", ");

  return [
    `OpenCode accepted the prompt but did not produce an assistant response within ${timeoutMs}ms.`,
    details ? `Selected ${details}.` : undefined,
    "Check the target model/agent configuration and OpenCode server logs.",
  ]
    .filter(Boolean)
    .join(" ");
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function promiseWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  if (timeoutMs <= 0) return promise.catch(() => undefined);

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<undefined>((resolve) => {
    timeout = setTimeout(() => resolve(undefined), timeoutMs);
  });

  return Promise.race([promise.catch(() => undefined), timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function createGatewayMessageId(): string {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`;
}

function createObserveState(sessionId: string, turnId: string | undefined, beforeMessageIds?: Set<string>): ObserveState {
  return {
    sessionId,
    turnId,
    beforeMessageIds: beforeMessageIds ?? new Set(),
    hasBeforeMessageSnapshot: beforeMessageIds !== undefined,
    childSessionIds: new Set(),
    childSessionAgentsById: new Map(),
    assistantMessageIds: new Set(),
    finalizedMessageIds: new Set(),
    pendingPermissionIds: new Set(),
    textPartsByMessageId: new Map(),
    toolStatusesByCallId: new Map(),
    toolInfoByCallId: new Map(),
    lastTodoFingerprintBySessionId: new Map(),
  };
}

function createRuntimeTurnHandle(
  input: Pick<SendRuntimeMessageInput, "sessionId" | "target">,
  messageId: string,
  raw: unknown,
): RuntimeTurnHandle {
  return {
    id: messageId,
    sessionId: input.sessionId,
    targetId: input.target.id,
    status: "running",
    raw,
  };
}

function permissionSdkResponse(decision: PermissionResponseInput["decision"]): "once" | "always" | "reject" {
  if (decision === "approve") return "once";
  if (decision === "always") return "always";
  return "reject";
}

function isSdkFieldsResult<T>(value: SdkResult<T>): value is SdkFieldsResult<T> {
  return Boolean(value && typeof value === "object" && ("data" in value || "error" in value));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function mapSession(target: RuntimeTarget, session: SdkSession): RuntimeSession {
  return {
    id: session.id,
    targetId: target.id,
    title: session.title,
    createdAt: timestampToIso(session.time?.created),
    updatedAt: timestampToIso(session.time?.updated),
    raw: session,
  };
}

function mapAgent(agent: SdkAgent): RuntimeAgent | undefined {
  const id = agent.id ?? agent.name;
  if (!id) return undefined;

  return {
    id,
    name: agent.name && agent.name !== id ? agent.name : undefined,
    description: agent.description,
    mode: agent.mode,
    raw: agent,
  };
}

function isPrimarySelectableAgent(agent: SdkAgent): boolean {
  if (agent.hidden || agent.disabled || agent.disable) return false;
  if (!agent.mode) return true;

  return agent.mode === "primary" || agent.mode === "all";
}

function mapModels(response: SdkConfigProvidersResponse): RuntimeModel[] {
  const modelsById = new Map<string, RuntimeModel>();

  for (const provider of providerEntries(response.providers)) {
    if (provider.raw.enabled === false) continue;

    for (const model of modelEntries(provider.id, provider.raw.models)) {
      modelsById.set(model.id, model);
    }
  }

  return [...modelsById.values()];
}

function providerEntries(providers: unknown): Array<{ id: string; raw: Record<string, unknown> }> {
  if (Array.isArray(providers)) {
    return providers.flatMap((provider) => {
      const raw = asObject(provider);
      const id = getObjectString(raw, "id") ?? getObjectString(raw, "providerID") ?? getObjectString(raw, "providerId");

      return raw && id ? [{ id, raw }] : [];
    });
  }

  const providerRecord = asObject(providers);
  if (!providerRecord) return [];

  return Object.entries(providerRecord).flatMap(([key, value]) => {
    const raw = asObject(value);
    if (!raw) return [];

    const id = getObjectString(raw, "id") ?? getObjectString(raw, "providerID") ?? getObjectString(raw, "providerId") ?? key;

    return id ? [{ id, raw }] : [];
  });
}

function modelEntries(providerId: string, models: unknown): RuntimeModel[] {
  if (Array.isArray(models)) {
    return models.flatMap((model) => {
      const raw = asObject(model);
      const rawModelId = getObjectString(raw, "id") ?? getObjectString(raw, "modelID") ?? getObjectString(raw, "modelId");
      if (!raw || !rawModelId) return [];

      return [runtimeModel(providerId, rawModelId, raw)];
    });
  }

  const modelRecord = asObject(models);
  if (!modelRecord) return [];

  return Object.entries(modelRecord).flatMap(([key, value]) => {
    const raw = asObject(value) ?? {};

    return [runtimeModel(providerId, key, raw)];
  });
}

function runtimeModel(providerId: string, rawModelId: string, raw: Record<string, unknown>): RuntimeModel {
  const providerOverride = getObjectString(raw, "providerID") ?? getObjectString(raw, "providerId");
  const modelOverride = getObjectString(raw, "modelID") ?? getObjectString(raw, "modelId");
  const ref = splitModelRef(providerOverride ?? providerId, modelOverride ?? rawModelId);

  return {
    id: `${ref.providerId}/${ref.modelId}`,
    providerId: ref.providerId,
    modelId: ref.modelId,
    name: getObjectString(raw, "name"),
    raw,
  };
}

function splitModelRef(providerId: string, modelId: string): { providerId: string; modelId: string } {
  const separatorIndex = modelId.indexOf("/");
  if (separatorIndex <= 0 || separatorIndex === modelId.length - 1) return { providerId, modelId };

  return {
    providerId: modelId.slice(0, separatorIndex),
    modelId: modelId.slice(separatorIndex + 1),
  };
}

function mapTurn(sessionId: string, response: SdkPromptResponse): RuntimeTurn {
  const error = response.info?.error;

  return {
    id: response.info?.id,
    sessionId: response.info?.sessionID ?? sessionId,
    status: error ? "error" : "completed",
    text: error ? formatRuntimeError(error) : extractAssistantText(response.parts ?? []),
    costUsd: response.info?.cost,
    tokens: mapTokenUsage(response.info?.tokens),
    raw: response,
  };
}

function extractAssistantText(parts: SdkPart[]): string {
  return parts
    .filter((part) => part.type === "text" && typeof part.text === "string" && part.text.length > 0)
    .map((part) => part.text)
    .join("\n\n");
}

function mapTokenUsage(tokens: unknown): TokenUsage | undefined {
  const tokenRecord = asObject(tokens);
  if (!tokenRecord) return undefined;

  const input = getObjectNumber(tokenRecord, "input");
  const output = getObjectNumber(tokenRecord, "output");
  const reasoning = getObjectNumber(tokenRecord, "reasoning") ?? 0;
  const total = (input ?? 0) + (output ?? 0) + reasoning;

  return {
    input,
    output,
    total,
  };
}

function parseModelRef(model: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!model) return undefined;

  const separatorIndex = model.indexOf("/");

  if (separatorIndex <= 0 || separatorIndex === model.length - 1) {
    throw new OpenCodeRuntimeError(
      `OpenCode model must be formatted as <providerID>/<modelID>: ${model}`,
    );
  }

  return {
    providerID: model.slice(0, separatorIndex),
    modelID: model.slice(separatorIndex + 1),
  };
}

function timestampToIso(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return new Date(value).toISOString();
}

function compareOptionalIsoDesc(left: string | undefined, right: string | undefined): number {
  if (!left && !right) return 0;
  if (!left) return 1;
  if (!right) return -1;
  return right.localeCompare(left);
}

function formatRuntimeError(error: unknown): string {
  if (error instanceof Error) return error.message;

  if (typeof error === "string") return error;

  if (error && typeof error === "object") {
    const maybeMessage = getObjectString(error, "message");
    if (maybeMessage) return maybeMessage;

    const maybeData = getObject(error, "data");
    const dataMessage = maybeData ? getObjectString(maybeData, "message") : undefined;
    if (dataMessage) return dataMessage;

    const maybeName = getObjectString(error, "name");
    if (maybeName) return maybeName;
  }

  return "unknown error";
}

function isRetryableRuntimeError(error: unknown): boolean | undefined {
  const errorRecord = asObject(error);
  const data = getObject(errorRecord, "data");
  const retryable = data?.isRetryable ?? errorRecord?.isRetryable;

  return typeof retryable === "boolean" ? retryable : undefined;
}

function compactObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function getObject(value: unknown, key: string): Record<string, unknown> | undefined {
  const object = asObject(value);
  if (!object) return undefined;

  const entry = object[key];
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
}

function getObjectString(value: unknown, key: string): string | undefined {
  const object = asObject(value);
  if (!object) return undefined;

  const entry = object[key];
  return typeof entry === "string" && entry.length > 0 ? entry : undefined;
}

function getObjectNumber(value: unknown, key: string): number | undefined {
  const object = asObject(value);
  if (!object) return undefined;

  const entry = object[key];
  return typeof entry === "number" && Number.isFinite(entry) ? entry : undefined;
}
