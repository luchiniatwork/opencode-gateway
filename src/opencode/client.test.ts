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
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client, observeReconcileIntervalMs: 1 });

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

  expect(handle.id).toMatch(/^msg_[0-9a-f]{32}$/);
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

test("startTurn can use the reliable sync prompt path for final-answer-only turns", async () => {
  const sdk = createFakeSdkClient({
    prompt: {
      info: { id: "assistant-sync", sessionID: "session-1", role: "assistant", finish: "stop" },
      parts: [{ type: "text", text: "Sync final" }],
    },
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const turn = await runtime.startTurn({ target: attachTarget, sessionId: "session-1", text: "Hello", mode: "sync" });
  const events = await collectRuntimeEvents(turn.events);

  expect(events).toEqual([{ type: "final", text: "Sync final", costUsd: undefined, tokens: undefined }]);
  expect(sdk.calls.prompt).toHaveLength(1);
  expect(sdk.calls.promptAsync).toEqual([]);
  expect(sdk.calls.subscribe).toEqual([]);
});

test("startTurn sync path can observe permission requests while waiting for final response", async () => {
  const sdk = createFakeSdkClient({
    promptDelayMs: 10,
    prompt: {
      info: { id: "assistant-sync", sessionID: "session-1", role: "assistant", finish: "stop" },
      parts: [{ type: "text", text: "Approved final" }],
    },
    events: [
      {
        type: "permission.updated",
        properties: {
          id: "permission-1",
          sessionID: "session-1",
          messageID: "assistant-sync",
          callID: "call-1",
          type: "tool",
          title: "Run bash command",
        },
      },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client, observeReconcileIntervalMs: 1 });

  const turn = await runtime.startTurn({
    target: attachTarget,
    sessionId: "session-1",
    text: "Needs permission",
    mode: "sync",
    observePermissions: true,
  });
  const events = await collectRuntimeEvents(turn.events);

  expect(events).toEqual([
    expect.objectContaining({ type: "permission_request", id: "permission-1", summary: "Run bash command" }),
    { type: "final", text: "Approved final", costUsd: undefined, tokens: undefined },
  ]);
  expect(sdk.calls.subscribe).toHaveLength(1);
  expect(sdk.calls.prompt).toHaveLength(1);
  expect(sdk.calls.promptAsync).toEqual([]);
});

test("starts observing events before sending an async prompt", async () => {
  let eventStreamStarted = false;
  const sdk = createFakeSdkClient({
    onEventStreamStarted: () => {
      eventStreamStarted = true;
    },
    onPromptAsync: () => {
      expect(eventStreamStarted).toBe(true);
    },
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const turn = await runtime.startTurn({
    target: attachTarget,
    sessionId: "session-1",
    text: "Inspect this repo asynchronously",
    agent: "build",
    model: "openai/gpt-5.5",
  });

  expect(turn.handle.id).toMatch(/^msg_[0-9a-f]{32}$/);
  expect(sdk.calls.subscribe).toEqual([{ query: { directory: "/work/repo" }, signal: undefined }]);
  expect(sdk.calls.promptAsync).toHaveLength(1);
});

test("startTurn reconciles final response when OpenCode uses a different user message id", async () => {
  const sdk = createFakeSdkClient({
    events: [],
    messageSnapshots: [
      [{ info: { id: "existing-assistant", sessionID: "session-1", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "Old" }] }],
      [
        { info: { id: "existing-assistant", sessionID: "session-1", role: "assistant", finish: "stop" }, parts: [{ type: "text", text: "Old" }] },
        { info: { id: "actual-user", sessionID: "session-1", role: "user" }, parts: [{ type: "text", text: "Hello" }] },
        {
          info: { id: "assistant-final", sessionID: "session-1", role: "assistant", parentID: "actual-user", finish: "stop" },
          parts: [{ type: "text", text: "New final" }],
        },
      ],
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const turn = await runtime.startTurn({ target: attachTarget, sessionId: "session-1", text: "Hello" });
  const events = await collectRuntimeEvents(turn.events);

  expect(events).toEqual([{ type: "final", text: "New final", costUsd: undefined, tokens: undefined }]);
  expect(sdk.calls.messages).toHaveLength(2);
});

test("startTurn reconciles assistant errors when OpenCode uses a different user message id", async () => {
  const sdk = createFakeSdkClient({
    events: [],
    messageSnapshots: [
      [],
      [
        { info: { id: "actual-user", sessionID: "session-1", role: "user" }, parts: [{ type: "text", text: "Hello" }] },
        {
          info: {
            id: "assistant-error",
            sessionID: "session-1",
            role: "assistant",
            parentID: "actual-user",
            error: { data: { message: "input exceeds context window of this model" } },
          },
          parts: [],
        },
      ],
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const turn = await runtime.startTurn({ target: attachTarget, sessionId: "session-1", text: "Hello" });
  const events = await collectRuntimeEvents(turn.events);

  expect(events).toEqual([{ type: "error", message: "input exceeds context window of this model", retryable: undefined }]);
  expect(sdk.calls.messages).toHaveLength(2);
});

test("startTurn finalizes live assistant events when OpenCode reports a different user parent id", async () => {
  const sdk = createFakeSdkClient({
    events: [
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-final", sessionID: "session-1", messageID: "assistant-final", type: "text", text: "Follow-up done" },
          delta: "Follow-up done",
        },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-final",
            sessionID: "session-1",
            role: "assistant",
            parentID: "actual-user-id-from-opencode",
            finish: "stop",
            time: { completed: 1 },
          },
        },
      },
    ],
    messageSnapshots: [[], []],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client, observeReconcileIntervalMs: 1 });

  const turn = await runtime.startTurn({ target: attachTarget, sessionId: "session-1", text: "Follow up" });
  const events = await collectRuntimeEvents(turn.events);

  expect(events).toEqual([
    { type: "text_delta", text: "Follow-up done" },
    { type: "final", text: "Follow-up done", costUsd: undefined, tokens: undefined },
  ]);
});

test("startTurn finalizes when assistant completion arrives before its text part", async () => {
  const sdk = createFakeSdkClient({
    events: [
      {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-final",
            sessionID: "session-1",
            role: "assistant",
            parentID: "actual-user-id-from-opencode",
            finish: "stop",
            time: { completed: 1 },
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-final", sessionID: "session-1", messageID: "assistant-final", type: "text", text: "Late text" },
          delta: "Late text",
        },
      },
    ],
    messageSnapshots: [[], [], []],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client, observeReconcileIntervalMs: 1 });

  const turn = await runtime.startTurn({ target: attachTarget, sessionId: "session-1", text: "Follow up" });
  const events = await collectRuntimeEvents(turn.events);

  expect(events).toEqual([
    { type: "text_delta", text: "Late text" },
    { type: "final", text: "Late text", costUsd: undefined, tokens: undefined },
  ]);
});

test("startTurn observes payload-based message part deltas from the OpenCode API event shape", async () => {
  const sdk = createFakeSdkClient({
    events: [
      {
        type: "message.part.delta",
        payload: {
          sessionID: "session-1",
          messageID: "assistant-final",
          partID: "part-final",
          field: "text",
          delta: "Payload ",
        },
      },
      {
        type: "message.part.delta",
        payload: {
          sessionID: "session-1",
          messageID: "assistant-final",
          partID: "part-final",
          field: "text",
          delta: "delta",
        },
      },
      {
        type: "message.updated",
        payload: {
          sessionID: "session-1",
          info: {
            id: "assistant-final",
            role: "assistant",
            parentID: "actual-user-id-from-opencode",
            finish: "stop",
            time: { completed: 1 },
          },
        },
      },
    ],
    messageSnapshots: [[], []],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client, observeReconcileIntervalMs: 1 });

  const turn = await runtime.startTurn({ target: attachTarget, sessionId: "session-1", text: "Follow up" });
  const events = await collectRuntimeEvents(turn.events);

  expect(events).toEqual([
    { type: "text_delta", text: "Payload " },
    { type: "text_delta", text: "delta" },
    { type: "final", text: "Payload delta", costUsd: undefined, tokens: undefined },
  ]);
});

test("observe accepts message.updated session id from the event properties", async () => {
  const sdk = createFakeSdkClient({
    events: [
      {
        type: "message.part.updated",
        properties: {
          sessionID: "session-1",
          part: { id: "part-final", messageID: "assistant-final", type: "text", text: "Properties session" },
        },
      },
      {
        type: "message.updated",
        properties: {
          sessionID: "session-1",
          info: {
            id: "assistant-final",
            role: "assistant",
            parentID: "message-user",
            finish: "stop",
            time: { completed: 1 },
          },
        },
      },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client, observeReconcileIntervalMs: 1 });

  const events = await collectRuntimeEvents(runtime.observe({ target: attachTarget, sessionId: "session-1", turnId: "message-user" }));

  expect(events).toEqual([
    { type: "text_delta", text: "Properties session" },
    { type: "final", text: "Properties session", costUsd: undefined, tokens: undefined },
  ]);
});

test("startTurn keeps consuming events when periodic message reconciliation hangs", async () => {
  const sdk = createFakeSdkClient({
    events: [
      {
        type: "message.part.delta",
        payload: {
          sessionID: "session-1",
          messageID: "assistant-final",
          partID: "part-final",
          field: "text",
          delta: "Still observed",
        },
      },
      {
        type: "message.updated",
        payload: {
          sessionID: "session-1",
          info: {
            id: "assistant-final",
            role: "assistant",
            parentID: "actual-user-id-from-opencode",
            finish: "stop",
            time: { completed: 1 },
          },
        },
      },
    ],
    eventDelayMs: 5,
    hangMessagesAfterCall: 1,
  });
  const runtime = new OpenCodeRuntime({
    createClient: () => sdk.client,
    observeReconcileIntervalMs: 1,
    observeReconcileTimeoutMs: 1,
  });

  const turn = await runtime.startTurn({ target: attachTarget, sessionId: "session-1", text: "Follow up" });
  const events = await collectRuntimeEvents(turn.events);

  expect(events).toEqual([
    { type: "text_delta", text: "Still observed" },
    { type: "final", text: "Still observed", costUsd: undefined, tokens: undefined },
  ]);
  expect(sdk.calls.messages.length).toBeGreaterThan(1);
});

test("startTurn ignores replayed assistant events from the pre-prompt message snapshot", async () => {
  const sdk = createFakeSdkClient({
    events: [
      {
        type: "message.part.updated",
        properties: {
          part: { id: "old-part", sessionID: "session-1", messageID: "old-assistant", type: "text", text: "Old reply" },
          delta: "Old reply",
        },
      },
      {
        type: "message.updated",
        properties: {
          info: { id: "old-assistant", sessionID: "session-1", role: "assistant", parentID: "old-user", finish: "stop", time: { completed: 1 } },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { id: "new-part", sessionID: "session-1", messageID: "new-assistant", type: "text", text: "New reply" },
          delta: "New reply",
        },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            id: "new-assistant",
            sessionID: "session-1",
            role: "assistant",
            parentID: "actual-new-user",
            finish: "stop",
            time: { completed: 2 },
          },
        },
      },
    ],
    messageSnapshots: [
      [
        { info: { id: "old-user", sessionID: "session-1", role: "user" }, parts: [{ type: "text", text: "Earlier" }] },
        { info: { id: "old-assistant", sessionID: "session-1", role: "assistant", parentID: "old-user", finish: "stop" }, parts: [{ type: "text", text: "Old reply" }] },
      ],
      [],
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client, observeReconcileIntervalMs: 1 });

  const turn = await runtime.startTurn({ target: attachTarget, sessionId: "session-1", text: "Follow up" });
  const events = await collectRuntimeEvents(turn.events);

  expect(events).toEqual([
    { type: "text_delta", text: "New reply" },
    { type: "final", text: "New reply", costUsd: undefined, tokens: undefined },
  ]);
});

test("does not send an async prompt when pre-send observation fails", async () => {
  const sdk = createFakeSdkClient({ eventSubscribeError: new Error("SSE unavailable") });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  await expect(runtime.startTurn({ target: attachTarget, sessionId: "session-1", text: "Hello" })).rejects.toThrow(
    "Unable to observe OpenCode events before async prompt to OpenCode session session-1: SSE unavailable",
  );
  expect(sdk.calls.promptAsync).toEqual([]);
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
      { type: "session.idle", properties: { sessionID: "session-1" } },
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

test("observes final from completed assistant message without idle", async () => {
  const sdk = createFakeSdkClient({
    events: [
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-1", sessionID: "session-1", messageID: "assistant-1", type: "text", text: "Done" },
          delta: "Done",
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
            finish: "stop",
            time: { completed: 1 },
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
    { type: "text_delta", text: "Done" },
    { type: "final", text: "Done", costUsd: undefined, tokens: undefined },
  ]);
});

test("backfills final text for completed assistant message without idle", async () => {
  const sdk = createFakeSdkClient({
    events: [
      {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-1",
            sessionID: "session-1",
            role: "assistant",
            parentID: "message-user",
            finish: "stop",
            time: { completed: 1 },
          },
        },
      },
    ],
    messages: [
      {
        info: {
          id: "assistant-1",
          sessionID: "session-1",
          role: "assistant",
          parentID: "message-user",
          finish: "stop",
          time: { completed: 1 },
        },
        parts: [{ type: "text", text: "Backfilled done" }],
      },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const events = await collectRuntimeEvents(
    runtime.observe({ target: attachTarget, sessionId: "session-1", turnId: "message-user" }),
  );

  expect(events).toEqual([{ type: "final", text: "Backfilled done", costUsd: undefined, tokens: undefined }]);
  expect(sdk.calls.messages).toHaveLength(1);
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
          action: "bash",
          resources: ["printf 'hello from permission'"],
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
        action: "bash",
        resources: ["printf 'hello from permission'"],
        pattern: "bash:*",
        messageID: "assistant-1",
        callID: "call-1",
        metadata: { tool: "bash" },
      },
    },
  ]);
});

test("observe does not fail idle events while a permission request is pending", async () => {
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
          title: "Run shell command",
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client, observeReconcileIntervalMs: 1 });

  const events = await collectRuntimeEvents(
    runtime.observe({ target: attachTarget, sessionId: "session-1", turnId: "message-user" }),
  );

  expect(events).toEqual([
    expect.objectContaining({ type: "permission_request", id: "permission-1" }),
    { type: "status", status: "idle" },
  ]);
});

test("observe clears pending permission state on permission replies", async () => {
  const sdk = createFakeSdkClient({
    events: [
      { type: "permission.updated", properties: { id: "permission-1", sessionID: "session-1", title: "Run shell command" } },
      { type: "permission.replied", properties: { id: "permission-1", sessionID: "session-1" } },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client, observeReconcileIntervalMs: 1 });

  const events = await collectRuntimeEvents(
    runtime.observe({ target: attachTarget, sessionId: "session-1", turnId: "message-user" }),
  );

  expect(events).toEqual([
    expect.objectContaining({ type: "permission_request", id: "permission-1" }),
    { type: "status", status: "idle" },
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

test("observe does not finalize intermediate tool-call assistant messages", async () => {
  const sdk = createFakeSdkClient({
    events: [
      {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-tools",
            sessionID: "session-1",
            role: "assistant",
            parentID: "message-user",
            finish: "tool-calls",
            time: { completed: 1 },
          },
        },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-final",
            sessionID: "session-1",
            role: "assistant",
            parentID: "message-user",
          },
        },
      },
      {
        type: "message.part.updated",
        properties: {
          part: { id: "part-final", sessionID: "session-1", messageID: "assistant-final", type: "text", text: "Done" },
        },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-final",
            sessionID: "session-1",
            role: "assistant",
            parentID: "message-user",
            finish: "stop",
            time: { completed: 2 },
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const events = await collectRuntimeEvents(
    runtime.observe({ target: attachTarget, sessionId: "session-1", turnId: "message-user" }),
  );

  expect(events).toEqual([
    { type: "text_delta", text: "Done" },
    { type: "final", text: "Done", costUsd: undefined, tokens: undefined },
  ]);
});

test("observe waits for idle and finalizes the latest completed assistant message", async () => {
  const sdk = createFakeSdkClient({
    events: [
      {
        type: "message.updated",
        properties: { info: { id: "assistant-1", sessionID: "session-1", role: "assistant", parentID: "message-user" } },
      },
      {
        type: "message.part.updated",
        properties: { part: { id: "part-1", sessionID: "session-1", messageID: "assistant-1", type: "text", text: "First" } },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-1",
            sessionID: "session-1",
            role: "assistant",
            parentID: "message-user",
            finish: "stop",
            time: { completed: 1 },
          },
        },
      },
      {
        type: "message.updated",
        properties: { info: { id: "assistant-2", sessionID: "session-1", role: "assistant", parentID: "message-user" } },
      },
      {
        type: "message.part.updated",
        properties: { part: { id: "part-2", sessionID: "session-1", messageID: "assistant-2", type: "text", text: "Second" } },
      },
      {
        type: "message.updated",
        properties: {
          info: {
            id: "assistant-2",
            sessionID: "session-1",
            role: "assistant",
            parentID: "message-user",
            finish: "stop",
            time: { completed: 2 },
          },
        },
      },
      { type: "session.idle", properties: { sessionID: "session-1" } },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const events = await collectRuntimeEvents(
    runtime.observe({ target: attachTarget, sessionId: "session-1", turnId: "message-user" }),
  );

  expect(events).toEqual([
    { type: "text_delta", text: "First" },
    { type: "text_delta", text: "Second" },
    { type: "final", text: "Second", costUsd: undefined, tokens: undefined },
  ]);
});

test("observe backfills final response from messages on idle", async () => {
  const sdk = createFakeSdkClient({
    events: [{ type: "session.idle", properties: { sessionID: "session-1" } }],
    messages: [
      {
        info: {
          id: "assistant-final",
          sessionID: "session-1",
          role: "assistant",
          parentID: "message-user",
          finish: "stop",
          time: { completed: 1 },
          cost: 0.1,
          tokens: { input: 1, output: 2, reasoning: 3 },
        },
        parts: [{ type: "text", text: "Backfilled" }],
      },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const events = await collectRuntimeEvents(
    runtime.observe({ target: attachTarget, sessionId: "session-1", turnId: "message-user" }),
  );

  expect(events).toEqual([{ type: "final", text: "Backfilled", costUsd: 0.1, tokens: { input: 1, output: 2, total: 6 } }]);
  expect(sdk.calls.messages).toHaveLength(1);
});

test("observe keeps idle events non-terminal when no final response is available", async () => {
  const sdk = createFakeSdkClient({
    events: [{ type: "session.idle", properties: { sessionID: "session-1" } }],
    messages: [],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client, observeReconcileIntervalMs: 1 });

  const events = await collectRuntimeEvents(
    runtime.observe({ target: attachTarget, sessionId: "session-1", turnId: "message-user" }),
  );

  expect(events).toEqual([{ type: "status", status: "idle" }]);
});

test("observe backfills final response immediately when terminal events were missed", async () => {
  const sdk = createFakeSdkClient({
    events: [],
    messages: [
      {
        info: {
          id: "assistant-final",
          sessionID: "session-1",
          role: "assistant",
          parentID: "message-user",
          finish: "stop",
          time: { completed: 1 },
        },
        parts: [{ type: "text", text: "Already complete" }],
      },
    ],
  });
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  const events = await collectRuntimeEvents(
    runtime.observe({ target: attachTarget, sessionId: "session-1", turnId: "message-user" }),
  );

  expect(events).toEqual([{ type: "final", text: "Already complete", costUsd: undefined, tokens: undefined }]);
  expect(sdk.calls.messages).toHaveLength(1);
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

test("responds to permissions with once always and reject mappings", async () => {
  const sdk = createFakeSdkClient();
  const runtime = new OpenCodeRuntime({ createClient: () => sdk.client });

  await runtime.respondToPermission({
    target: attachTarget,
    sessionId: "session-1",
    permissionId: "permission-1",
    decision: "approve",
  });
  await runtime.respondToPermission({
    target: attachTarget,
    sessionId: "session-1",
    permissionId: "permission-2",
    decision: "always",
  });
  await runtime.respondToPermission({
    target: attachTarget,
    sessionId: "session-1",
    permissionId: "permission-3",
    decision: "deny",
  });

  expect(sdk.calls.respondToPermission).toEqual([
    {
      path: { id: "session-1", permissionID: "permission-1" },
      query: { directory: "/work/repo" },
      body: { response: "once" },
    },
    {
      path: { id: "session-1", permissionID: "permission-2" },
      query: { directory: "/work/repo" },
      body: { response: "always" },
    },
    {
      path: { id: "session-1", permissionID: "permission-3" },
      query: { directory: "/work/repo" },
      body: { response: "reject" },
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
  promptDelayMs?: number;
  promptAsyncError?: unknown;
  messages?: FakePromptResponse[];
  messageSnapshots?: FakePromptResponse[][];
  events?: unknown[];
  eventSubscribeError?: unknown;
  eventStreamError?: unknown;
  eventDelayMs?: number;
  hangMessagesAfterCall?: number;
  onEventStreamStarted?: () => void;
  onPromptAsync?: () => void | Promise<void>;
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
    parentID?: string;
    error?: unknown;
    cost?: number;
    finish?: string;
    time?: { completed?: number };
    agent?: string;
    model?: { providerID?: string; modelID?: string };
    tokens?: { input?: number; output?: number; reasoning?: number };
  };
  parts?: Array<{ type: string; text?: string }>;
}

function createFakeSdkClient(options: FakeSdkOptions = {}) {
  const calls: Record<
    "create" | "get" | "list" | "messages" | "prompt" | "promptAsync" | "abort" | "subscribe" | "respondToPermission",
    unknown[]
  > = {
    create: [],
    get: [],
    list: [],
    messages: [],
    prompt: [],
    promptAsync: [],
    abort: [],
    subscribe: [],
    respondToPermission: [],
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
      async postSessionIdPermissionsPermissionId(input: unknown) {
        calls.respondToPermission.push(input);
        return { data: true };
      },
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
          if (options.hangMessagesAfterCall !== undefined && calls.messages.length > options.hangMessagesAfterCall) {
            return new Promise<never>(() => undefined);
          }
          return { data: responses.messageSnapshots?.[calls.messages.length - 1] ?? responses.messages };
        },
        async prompt(input: unknown) {
          calls.prompt.push(input);
          if (options.promptDelayMs) await sleep(options.promptDelayMs);
          return { data: responses.prompt };
        },
        async promptAsync(input: unknown) {
          calls.promptAsync.push(input);
          await options.onPromptAsync?.();
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
          return { stream: createEventStream(responses.events, options.eventStreamError, options.onEventStreamStarted, options.eventDelayMs) };
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

async function* createEventStream(events: unknown[], error?: unknown, onStarted?: () => void, delayMs = 0): AsyncIterable<unknown> {
  onStarted?.();

  for (const event of events) {
    if (delayMs > 0) await sleep(delayMs);
    yield event;
  }

  if (error) throw error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
