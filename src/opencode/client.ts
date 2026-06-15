import { createOpencodeClient } from "@opencode-ai/sdk";

import type {
  AbortRuntimeTurnInput,
  AgentRuntime,
  EnsureSessionInput,
  ListRuntimeSessionsInput,
  ObserveRuntimeTurnInput,
  PermissionResponseInput,
  RuntimeEvent,
  RuntimeSession,
  RuntimeStartedTurn,
  RuntimeTarget,
  RuntimeTurn,
  RuntimeTurnHandle,
  SendRuntimeMessageInput,
  StartRuntimeTurnInput,
  TokenUsage,
} from "./types.ts";

type SdkFieldsResult<T> = { data: T; error?: undefined } | { data?: undefined; error: unknown };

type SdkResult<T> = SdkFieldsResult<T> | T | undefined;

interface SdkSession {
  id: string;
  title?: string;
  time?: {
    created?: number;
    updated?: number;
  };
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

interface SdkEventSubscribeOptions {
  query?: { directory?: string };
  signal?: AbortSignal;
}

interface SdkEventSubscription {
  stream: AsyncIterable<unknown>;
}

interface OpenCodeSdkClient {
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
  assistantMessageIds: Set<string>;
  finalizedMessageIds: Set<string>;
  pendingPermissionIds: Set<string>;
  textPartsByMessageId: Map<string, Map<string, string>>;
  toolStatusesByCallId: Map<string, string>;
  pendingFinal?: Extract<RuntimeEvent, { type: "final" }>;
  pendingFinalMessageId?: string;
}

interface OpenCodeRuntimeOptions {
  createClient?: (target: RuntimeTarget) => OpenCodeSdkClient;
  finalResponseTimeoutMs?: number;
  finalResponsePollIntervalMs?: number;
  observeReconcileIntervalMs?: number;
}

const DEFAULT_OBSERVE_RECONCILE_INTERVAL_MS = 1_000;

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
  const properties = getObject(event, "properties") ?? {};

  switch (type) {
    case "session.status":
      return normalizeSessionStatus(properties, state);
    case "session.idle":
      return normalizeSessionIdle(properties, state);
    case "message.updated":
      return normalizeMessageUpdated(properties, state);
    case "message.part.updated":
      return normalizeMessagePartUpdated(properties, state);
    case "permission.updated":
    case "permission.asked":
    case "permission.v2.asked":
      return normalizePermissionRequest(type, properties, state);
    case "permission.replied":
    case "permission.v2.replied":
      return normalizePermissionReplied(properties, state);
    case "session.error":
      return normalizeSessionError(properties, state);
    default:
      return noEvents();
  }
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
  if (!info || getObjectString(info, "sessionID") !== state.sessionId) return noEvents();
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
  if (!part || getObjectString(part, "sessionID") !== state.sessionId) return noEvents();
  if (!partBelongsToObservedTurn(part, state)) return noEvents();

  const partType = getObjectString(part, "type");

  if (partType === "text") {
    const text = updateTextPartAndGetDelta(part, getObjectString(properties, "delta"), state);
    return text ? { events: [{ type: "text_delta", text }], terminal: false } : noEvents();
  }

  if (partType === "tool") {
    return { events: normalizeToolPart(part, state), terminal: false };
  }

  return noEvents();
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

  return {
    events: [
      {
        type: "permission_request",
        id,
        summary: permissionSummary(properties),
        details: compactObject({
          eventType,
          type: getObjectString(properties, "type"),
          permission: getObjectString(properties, "permission"),
          pattern: properties.pattern,
          patterns: properties.patterns,
          action: getObjectString(properties, "action"),
          resources: properties.resources,
          messageID: getObjectString(properties, "messageID"),
          callID: getObjectString(properties, "callID"),
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

  const id = getObjectString(properties, "id") ?? getObjectString(properties, "requestID");
  if (id) state.pendingPermissionIds.delete(id);

  return noEvents();
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

function normalizeToolPart(part: Record<string, unknown>, state: ObserveState): RuntimeEvent[] {
  const callId = getObjectString(part, "callID") ?? getObjectString(part, "id");
  const name = getObjectString(part, "tool") ?? "tool";
  const toolState = asObject(part.state);
  const status = toolState ? getObjectString(toolState, "status") : undefined;

  if (!callId || !status) return [];

  const previousStatus = state.toolStatusesByCallId.get(callId);
  if (previousStatus === status && (status === "completed" || status === "error")) return [];

  state.toolStatusesByCallId.set(callId, status);
  const summary = toolState ? toolSummary(toolState) : undefined;

  if (!previousStatus && (status === "pending" || status === "running")) {
    return [{ type: "tool_start", id: callId, name, summary }];
  }

  if (status === "pending" || status === "running") {
    return [{ type: "tool_update", id: callId, name, summary }];
  }

  if (status === "completed") return [{ type: "tool_end", id: callId, name, ok: true, summary }];
  if (status === "error") return [{ type: "tool_end", id: callId, name, ok: false, summary }];

  return [];
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

function toolSummary(state: Record<string, unknown>): string | undefined {
  return getObjectString(state, "title") ?? getObjectString(state, "error") ?? getObjectString(state, "status");
}

function partBelongsToObservedTurn(part: Record<string, unknown>, state: ObserveState): boolean {
  const messageId = getObjectString(part, "messageID");
  if (!state.turnId || !messageId) return true;
  if (messageId === state.turnId) return false;
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
  return Boolean(messageId && state.assistantMessageIds.has(messageId));
}

function matchesSession(properties: Record<string, unknown>, state: ObserveState): boolean {
  return getObjectString(properties, "sessionID") === state.sessionId;
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
  signal?: AbortSignal;
  initialBackfill?: boolean;
  reconcileIntervalMs: number;
}

interface ObservedEventPump {
  events: AsyncIterable<RuntimeEvent>;
  ready: Promise<void>;
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

  return {
    events: queue,
    ready,
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
        const terminal = await findTerminalEventFromMessages(
          input.client,
          input.target,
          input.state.sessionId,
          input.state.turnId,
          input.state,
        );

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

    const terminal = await findTerminalEventFromMessages(
      input.client,
      input.target,
      input.state.sessionId,
      input.state.turnId,
      input.state,
    );

    if (terminal) {
      clearPendingFinal(input.state);
      return terminal;
    }

    return resolvePendingFinal(input.state);
  }
}

function noEvents(): { events: RuntimeEvent[]; terminal: boolean } {
  return { events: [], terminal: false };
}

export class OpenCodeRuntime implements AgentRuntime {
  private readonly createClient: (target: RuntimeTarget) => OpenCodeSdkClient;
  private readonly finalResponseTimeoutMs: number;
  private readonly finalResponsePollIntervalMs: number;
  private readonly observeReconcileIntervalMs: number;
  private readonly clients = new Map<string, OpenCodeSdkClient>();

  constructor(options: OpenCodeRuntimeOptions = {}) {
    this.createClient =
      options.createClient ??
      ((target) => createOpencodeClient({ baseUrl: target.serverUrl }) as OpenCodeSdkClient);
    this.finalResponseTimeoutMs = options.finalResponseTimeoutMs ?? 60_000;
    this.finalResponsePollIntervalMs = options.finalResponsePollIntervalMs ?? 1_000;
    this.observeReconcileIntervalMs = options.observeReconcileIntervalMs ?? DEFAULT_OBSERVE_RECONCILE_INTERVAL_MS;
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
      signal: input.signal,
      reconcileIntervalMs: this.observeReconcileIntervalMs,
    });

    await observed.ready;

    try {
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

      return {
        handle: createRuntimeTurnHandle(input, messageId, response),
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
      signal: input.signal,
      initialBackfill: true,
      reconcileIntervalMs: this.observeReconcileIntervalMs,
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

    if (!respond) {
      throw new OpenCodeRuntimeError("OpenCode SDK client does not expose a permission response endpoint");
    }

    await unwrapSdkResult(
      respond.call(client, {
        path: { id: input.sessionId, permissionID: input.permissionId },
        query: directoryQuery(input.target),
        body: {
          response: permissionSdkResponse(input.decision),
        },
      }),
      `Unable to respond to OpenCode permission ${input.permissionId}`,
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
  if (!pending.text.trim()) return undefined;

  state.finalizedMessageIds.add(messageId);
  clearPendingFinal(state);

  return pending;
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

function createGatewayMessageId(): string {
  return `msg_${crypto.randomUUID().replaceAll("-", "")}`;
}

function createObserveState(sessionId: string, turnId: string | undefined, beforeMessageIds?: Set<string>): ObserveState {
  return {
    sessionId,
    turnId,
    beforeMessageIds: beforeMessageIds ?? new Set(),
    hasBeforeMessageSnapshot: beforeMessageIds !== undefined,
    assistantMessageIds: new Set(),
    finalizedMessageIds: new Set(),
    pendingPermissionIds: new Set(),
    textPartsByMessageId: new Map(),
    toolStatusesByCallId: new Map(),
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
