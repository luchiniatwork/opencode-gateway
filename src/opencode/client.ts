import { createOpencodeClient } from "@opencode-ai/sdk";

import type {
  AbortRuntimeTurnInput,
  AgentRuntime,
  EnsureSessionInput,
  ListRuntimeSessionsInput,
  RuntimeSession,
  RuntimeTarget,
  RuntimeTurn,
  SendRuntimeMessageInput,
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
  error?: unknown;
  cost?: number;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
  };
}

interface SdkPart {
  type: string;
  text?: string;
}

interface SdkPromptResponse {
  info?: SdkAssistantMessage;
  parts?: SdkPart[];
}

interface SdkSessionOptions {
  path?: { id: string };
  query?: { directory?: string };
  body?: unknown;
}

interface OpenCodeSdkClient {
  session: {
    create(options?: SdkSessionOptions): Promise<SdkResult<SdkSession>>;
    get(options: SdkSessionOptions): Promise<SdkResult<SdkSession>>;
    list(options?: SdkSessionOptions): Promise<SdkResult<SdkSession[]>>;
    prompt(options: SdkSessionOptions): Promise<SdkResult<SdkPromptResponse>>;
    abort(options: SdkSessionOptions): Promise<SdkResult<boolean>>;
  };
}

interface OpenCodeRuntimeOptions {
  createClient?: (target: RuntimeTarget) => OpenCodeSdkClient;
}

export class OpenCodeRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OpenCodeRuntimeError";
  }
}

export class OpenCodeRuntime implements AgentRuntime {
  private readonly createClient: (target: RuntimeTarget) => OpenCodeSdkClient;
  private readonly clients = new Map<string, OpenCodeSdkClient>();

  constructor(options: OpenCodeRuntimeOptions = {}) {
    this.createClient =
      options.createClient ??
      ((target) => createOpencodeClient({ baseUrl: target.serverUrl }) as OpenCodeSdkClient);
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

    return mapTurn(input.sessionId, response);
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

function isSdkFieldsResult<T>(value: SdkResult<T>): value is SdkFieldsResult<T> {
  return Boolean(value && typeof value === "object" && ("data" in value || "error" in value));
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

function mapTokenUsage(tokens: SdkAssistantMessage["tokens"]): TokenUsage | undefined {
  if (!tokens) return undefined;

  const input = tokens.input;
  const output = tokens.output;
  const reasoning = tokens.reasoning ?? 0;
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

function getObject(value: object, key: string): Record<string, unknown> | undefined {
  const entry = (value as Record<string, unknown>)[key];
  return entry && typeof entry === "object" ? (entry as Record<string, unknown>) : undefined;
}

function getObjectString(value: object, key: string): string | undefined {
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === "string" && entry.length > 0 ? entry : undefined;
}
