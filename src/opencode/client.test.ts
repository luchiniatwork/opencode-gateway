import { expect, test } from "bun:test";

import { OpenCodeRuntime, OpenCodeRuntimeError } from "./client.ts";
import type { RuntimeEvent, RuntimeTarget } from "./types.ts";

test("creates a session when no session id is provided", async () => {
  const sdk = createFakeSdkClient({
    createSession: {
      id: "session-1",
      title: "New chat",
      time: { created: 1_700_000_000_000, updated: 1_700_000_000_500 },
    },
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const session = await runtime.ensureSession({ target: attachTarget, title: "New chat" });

  expect(session).toEqual({
    id: "session-1",
    targetId: "default",
    title: "New chat",
    createdAt: "2023-11-14T22:13:20.000Z",
    updatedAt: "2023-11-14T22:13:20.500Z",
    raw: sdk.responses.createSession,
  });
  expect(sdk.calls.create).toEqual([
    {
      body: { title: "New chat" },
      query: { directory: "/work/repo" },
    },
  ]);
});

test("loads an existing session when session id is provided", async () => {
  const sdk = createFakeSdkClient({
    getSession: {
      id: "session-existing",
      title: "Existing chat",
      time: { created: 1_700_000_000_000, updated: 1_700_000_001_000 },
    },
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const session = await runtime.ensureSession({ target: attachTarget, sessionId: "session-existing" });

  expect(session.id).toBe("session-existing");
  expect(session.title).toBe("Existing chat");
  expect(sdk.calls.get).toEqual([
    {
      path: { id: "session-existing" },
      query: { directory: "/work/repo" },
    },
  ]);
});

test("sends a final-response prompt and maps assistant text, cost, and tokens", async () => {
  const sdk = createFakeSdkClient({
    prompt: {
      info: {
        id: "message-1",
        sessionID: "session-1",
        cost: 0.12,
        tokens: { input: 10, output: 20, reasoning: 5 },
      },
      parts: [
        { type: "text", text: "First paragraph." },
        { type: "tool" },
        { type: "text", text: "Second paragraph." },
      ],
    },
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const turn = await runtime.send({
    target: attachTarget,
    sessionId: "session-1",
    text: "Inspect this repo",
    agent: "build",
    model: "openai/gpt-5.5",
  });

  expect(turn).toEqual({
    id: "message-1",
    sessionId: "session-1",
    status: "completed",
    text: "First paragraph.\n\nSecond paragraph.",
    costUsd: 0.12,
    tokens: { input: 10, output: 20, total: 35 },
    raw: sdk.responses.prompt,
  });
  expect(sdk.calls.prompt).toEqual([
    {
      path: { id: "session-1" },
      query: { directory: "/work/repo" },
      body: {
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5.5" },
        parts: [{ type: "text", text: "Inspect this repo" }],
      },
    },
  ]);
});

test("maps assistant errors to error turns", async () => {
  const sdk = createFakeSdkClient({
    prompt: {
      info: {
        id: "message-1",
        sessionID: "session-1",
        error: { name: "ProviderAuthError", data: { message: "Missing credentials" } },
      },
      parts: [],
    },
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const turn = await runtime.send({ target: attachTarget, sessionId: "session-1", text: "Hello" });

  expect(turn.status).toBe("error");
  expect(turn.text).toBe("Missing credentials");
});

test("sends an async prompt with a gateway-owned message id", async () => {
  const sdk = createFakeSdkClient();
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const handle = await runtime.sendAsync({
    target: attachTarget,
    sessionId: "session-1",
    text: "Inspect this repo asynchronously",
    agent: "build",
    model: "openai/gpt-5.5",
  });

  expect(handle.id).toStartWith("gateway-");
  expect(handle).toMatchObject({
    sessionId: "session-1",
    targetId: "default",
    status: "running",
  });
  expect(sdk.calls.promptAsync).toEqual([
    {
      path: { id: "session-1" },
      query: { directory: "/work/repo" },
      body: {
        messageID: handle.id,
        agent: "build",
        model: { providerID: "openai", modelID: "gpt-5.5" },
        parts: [{ type: "text", text: "Inspect this repo asynchronously" }],
      },
    },
  ]);
});

test("rejects invalid async prompt model references before calling OpenCode", async () => {
  const sdk = createFakeSdkClient();
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  await expect(
    runtime.sendAsync({ target: attachTarget, sessionId: "session-1", text: "Hello", model: "missing-separator" }),
  ).rejects.toThrow("OpenCode model must be formatted as <providerID>/<modelID>");
  expect(sdk.calls.promptAsync).toEqual([]);
});

test("wraps async prompt SDK errors with an actionable message", async () => {
  const sdk = createFakeSdkClient({
    promptAsyncError: { data: { message: "Session is locked" } },
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  await expect(runtime.sendAsync({ target: attachTarget, sessionId: "session-1", text: "Hello" })).rejects.toThrow(
    "Unable to send async prompt to OpenCode session session-1: Session is locked",
  );
});

test("observes OpenCode status, text, and final events", async () => {
  const sdk = createFakeSdkClient({
    events: [
      { type: "session.status", properties: { sessionID: "session-1", status: { type: "busy" } } },
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-1", sessionID: "session-1", messageID: "assistant-1", type: "text", text: "Hello" },
          delta: "Hello",
        },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-1",
            sessionID: "session-1",
            role: "assistant",
            parentID: "message-user",
            cost: 0.2,
            tokens: { input: 2, output: 3, reasoning: 1 },
            time: { completed: 1_700_000_000_000 },
          },
        },
      },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const events = await collectRuntimeEvents(
    runtime.observe({ target: attachTarget, sessionId: "session-1", turnId: "message-user" }),
  );

  expect(events).toEqual([
    { type: "status", status: "running" },
    { type: "text_delta", text: "Hello" },
    { type: "final", text: "Hello", costUsd: 0.2, tokens: { input: 2, output: 3, total: 6 } },
  ]);
  expect(sdk.calls.subscribe).toEqual([{ query: { directory: "/work/repo" }, signal: undefined }]);
});

test("observes text deltas from full text updates when no SDK delta is present", async () => {
  const sdk = createFakeSdkClient({
    events: [
      {
        type: "message.part.updated",
        properties: { part: { id: "part-1", sessionID: "session-1", messageID: "assistant-1", type: "text", text: "Hel" } },
      },
      {
        type: "message.part.updated",
        properties: { part: { id: "part-1", sessionID: "session-1", messageID: "assistant-1", type: "text", text: "Hello" } },
      },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const events = await collectRuntimeEvents(runtime.observe({ target: attachTarget, sessionId: "session-1" }));

  expect(events).toEqual([
    { type: "text_delta", text: "Hel" },
    { type: "text_delta", text: "lo" },
  ]);
});

test("observes tool lifecycle events", async () => {
  const sdk = createFakeSdkClient({
    events: [
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-part-1",
            sessionID: "session-1",
            messageID: "assistant-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: { status: "pending", title: "Prepare command" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-part-1",
            sessionID: "session-1",
            messageID: "assistant-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: { status: "running", title: "Run command" },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: {
            id: "tool-part-1",
            sessionID: "session-1",
            messageID: "assistant-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: { status: "completed", title: "Command completed" },
          },
        },
      },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const events = await collectRuntimeEvents(runtime.observe({ target: attachTarget, sessionId: "session-1" }));

  expect(events).toEqual([
    { type: "tool_start", id: "call-1", name: "bash", summary: "Prepare command" },
    { type: "tool_update", id: "call-1", name: "bash", summary: "Run command" },
    { type: "tool_end", id: "call-1", name: "bash", ok: true, summary: "Command completed" },
  ]);
});

test("observes permission requests without leaking raw SDK payloads", async () => {
  const sdk = createFakeSdkClient({
    events: [
      {
        type: "permission.updated",
        properties: {
          id: "permission-1",
          sessionID: "session-1",
          messageID: "assistant-1",
          callID: "call-1",
          type: "tool",
          pattern: "bash:*",
          title: "Run shell command",
          metadata: { tool: "bash" },
        },
      },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const events = await collectRuntimeEvents(runtime.observe({ target: attachTarget, sessionId: "session-1" }));

  expect(events).toEqual([
    {
      type: "permission_request",
      id: "permission-1",
      summary: "Run shell command",
      details: {
        eventType: "permission.updated",
        type: "tool",
        pattern: "bash:*",
        messageID: "assistant-1",
        callID: "call-1",
        metadata: { tool: "bash" },
      },
    },
  ]);
});

test("observe filters events from other sessions and user prompt parts", async () => {
  const sdk = createFakeSdkClient({
    events: [
      { type: "session.status", properties: { sessionID: "other-session", status: { type: "busy" } } },
      {
        type: "message.part.updated",
        properties: { part: { id: "user-part", sessionID: "session-1", messageID: "message-user", type: "text", text: "ignored" } },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const events = await collectRuntimeEvents(
    runtime.observe({ target: attachTarget, sessionId: "session-1", turnId: "message-user" }),
  );

  expect(events).toEqual([{ type: "status", status: "idle" }]);
});

test("observe reports stream failures as retryable runtime errors", async () => {
  const sdk = createFakeSdkClient({ eventStreamError: new Error("connection dropped") });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const events = await collectRuntimeEvents(runtime.observe({ target: attachTarget, sessionId: "session-1" }));

  expect(events).toEqual([{ type: "error", message: "OpenCode event stream failed: connection dropped", retryable: true }]);
});

test("observe returns without subscribing when the signal is already aborted", async () => {
  const sdk = createFakeSdkClient();
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });
  const controller = new AbortController();
  controller.abort();

  const events = await collectRuntimeEvents(runtime.observe({ target: attachTarget, sessionId: "session-1", signal: controller.signal }));

  expect(events).toEqual([]);
  expect(sdk.calls.subscribe).toEqual([]);
});

test("polls session messages when prompt returns an empty body", async () => {
  const sdk = createFakeSdkClient({
    prompt: {},
    messageSnapshots: [
      [],
      [
        {
          info: { id: "message-user", role: "user", sessionID: "session-1" },
          parts: [{ type: "text", text: "Hello" }],
        },
        {
          info: { id: "message-assistant", role: "assistant", sessionID: "session-1" },
          parts: [{ type: "text", text: "Hello from OpenCode." }],
        },
      ],
    ],
  });
  const runtime = new OpenCodeRuntime({
    createClient: () => sdk.client,
    finalResponseTimeoutMs: 0,
    finalResponsePollIntervalMs: 0,
  });

  const turn = await runtime.send({ target: attachTarget, sessionId: "session-1", text: "Hello" });

  expect(turn).toMatchObject({
    id: "message-assistant",
    sessionId: "session-1",
    status: "completed",
    text: "Hello from OpenCode.",
  });
  expect(sdk.calls.messages).toHaveLength(2);
});

test("returns an error turn when OpenCode never produces an assistant message", async () => {
  const sdk = createFakeSdkClient({
    prompt: {},
    messageSnapshots: [
      [],
      [
        {
          info: {
            id: "message-user",
            role: "user",
            sessionID: "session-1",
            agent: "build",
            model: { providerID: "missing", modelID: "model" },
          },
          parts: [{ type: "text", text: "Hello" }],
        },
      ],
    ],
  });
  const runtime = new OpenCodeRuntime({
    createClient: () => sdk.client,
    finalResponseTimeoutMs: 0,
    finalResponsePollIntervalMs: 0,
  });

  const turn = await runtime.send({ target: attachTarget, sessionId: "session-1", text: "Hello" });

  expect(turn.status).toBe("error");
  expect(turn.text).toContain("did not produce an assistant response");
  expect(turn.text).toContain("agent build, model missing/model");
});

test("rejects unsupported attachments in phase 1", async () => {
  const sdk = createFakeSdkClient();
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  await expect(
    runtime.send({
      target: attachTarget,
      sessionId: "session-1",
      text: "See attached",
      attachments: [{ filename: "image.png", url: "https://example.com/image.png" }],
    }),
  ).rejects.toThrow("attachments");
  expect(sdk.calls.prompt).toEqual([]);
});

test("rejects unsupported attachments in async prompts", async () => {
  const sdk = createFakeSdkClient();
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  await expect(
    runtime.sendAsync({
      target: attachTarget,
      sessionId: "session-1",
      text: "See attached",
      attachments: [{ filename: "image.png", url: "https://example.com/image.png" }],
    }),
  ).rejects.toThrow("attachments");
  expect(sdk.calls.promptAsync).toEqual([]);
});

test("aborts a session", async () => {
  const sdk = createFakeSdkClient();
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  await runtime.abort({ target: attachTarget, sessionId: "session-1" });

  expect(sdk.calls.abort).toEqual([
    {
      path: { id: "session-1" },
      query: { directory: "/work/repo" },
    },
  ]);
});

test("lists sessions sorted by updated time and applies limit", async () => {
  const sdk = createFakeSdkClient({
    sessions: [
      { id: "older", title: "Older", time: { updated: 1_700_000_000_000 } },
      { id: "newer", title: "Newer", time: { updated: 1_700_000_010_000 } },
      { id: "middle", title: "Middle", time: { updated: 1_700_000_005_000 } },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const sessions = await runtime.listSessions({ target: attachTarget, limit: 2 });

  expect(sessions.map((session) => session.id)).toEqual(["newer", "middle"]);
  expect(sdk.calls.list).toEqual([{ query: { directory: "/work/repo" } }]);
});

test("rejects non-attach targets", async () => {
  const sdk = createFakeSdkClient();
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });
  const target: RuntimeTarget = {
    id: "managed",
    name: "Managed",
    mode: "managed",
    workdir: "/work/repo",
  };

  await expect(runtime.listSessions({ target })).rejects.toThrow(OpenCodeRuntimeError);
  expect(sdk.calls.list).toEqual([]);
});

test("wraps SDK error responses with an actionable message", async () => {
  const sdk = createFakeSdkClient({
    createSessionError: { data: { message: "OpenCode unavailable" } },
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  await expect(runtime.ensureSession({ target: attachTarget })).rejects.toThrow(
    "Unable to create OpenCode session: OpenCode unavailable",
  );
});

const attachTarget: RuntimeTarget = {
  id: "default",
  name: "Default",
  mode: "attach",
  serverUrl: "http://127.0.0.1:4096",
  workdir: "/work/repo",
};

interface FakeSdkOptions {
  createSession?: FakeSession;
  createSessionError?: unknown;
  getSession?: FakeSession;
  sessions?: FakeSession[];
  prompt?: FakePromptResponse;
  promptAsyncError?: unknown;
  messages?: FakePromptResponse[];
  messageSnapshots?: FakePromptResponse[][];
  events?: unknown[];
  eventSubscribeError?: unknown;
  eventStreamError?: unknown;
}

interface FakeSession {
  id: string;
  title?: string;
  time?: { created?: number; updated?: number };
}

interface FakePromptResponse {
  info?: {
    id?: string;
    sessionID?: string;
    role?: string;
    error?: unknown;
    cost?: number;
    agent?: string;
    model?: { providerID?: string; modelID?: string };
    tokens?: { input?: number; output?: number; reasoning?: number };
  };
  parts?: Array<{ type: string; text?: string }>;
}

function createFakeSdkClient(options: FakeSdkOptions = {}) {
  const calls: Record<"create" | "get" | "list" | "messages" | "prompt" | "promptAsync" | "abort" | "subscribe", unknown[]> = {
    create: [],
    get: [],
    list: [],
    messages: [],
    prompt: [],
    promptAsync: [],
    abort: [],
    subscribe: [],
  };
  const responses = {
    createSession: options.createSession ?? { id: "session-created" },
    getSession: options.getSession ?? { id: "session-existing" },
    sessions: options.sessions ?? [],
    messages: options.messages ?? [],
    messageSnapshots: options.messageSnapshots,
    prompt: options.prompt ?? { info: { id: "message-1", sessionID: "session-1" }, parts: [] },
    events: options.events ?? [],
  };

  return {
    calls,
    responses,
    client: {
      session: {
        async create(input: unknown) {
          calls.create.push(input);
          if (options.createSessionError) return { error: options.createSessionError };
          return { data: responses.createSession };
        },
        async get(input: unknown) {
          calls.get.push(input);
          return { data: responses.getSession };
        },
        async list(input: unknown) {
          calls.list.push(input);
          return { data: responses.sessions };
        },
        async messages(input: unknown) {
          calls.messages.push(input);
          return { data: responses.messageSnapshots?.[calls.messages.length - 1] ?? responses.messages };
        },
        async prompt(input: unknown) {
          calls.prompt.push(input);
          return { data: responses.prompt };
        },
        async promptAsync(input: unknown) {
          calls.promptAsync.push(input);
          if (options.promptAsyncError) return { error: options.promptAsyncError };
          return { data: undefined };
        },
        async abort(input: unknown) {
          calls.abort.push(input);
          return { data: true };
        },
      },
      event: {
        async subscribe(input: unknown) {
          calls.subscribe.push(input);
          if (options.eventSubscribeError) throw options.eventSubscribeError;
          return { stream: createEventStream(responses.events, options.eventStreamError) };
        },
      },
    },
  };
}

async function collectRuntimeEvents(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];

  for await (const event of events) {
    collected.push(event);
  }

  return collected;
}

async function* createEventStream(events: unknown[], error?: unknown): AsyncIterable<unknown> {
  for (const event of events) {
    yield event;
  }

  if (error) throw error;
}
