import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, type GatewayChannelRegistration, type GatewayLogEntry } from "./app.ts";
import type {
  ChannelAdapter,
  ChannelAction,
  ChannelEvent,
  ChannelLogger,
  ChannelStartContext,
  InboundMessage,
  OutboundTarget,
  SendReceipt,
  TypingState,
} from "./channels/types.ts";
import type { GatewayConfig } from "./config/schema.ts";
import { openGatewayDatabase } from "./db/client.ts";
import { runMigrations } from "./db/migrations.ts";
import { createConversationBindingRepository } from "./db/repositories/conversation-bindings.ts";
import { createRunRepository } from "./db/repositories/runs.ts";
import { seedDatabaseFromConfig } from "./db/repositories/seeds.ts";
import type { OutboundMessage } from "./messages/types.ts";
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
  RuntimeTurn,
  RuntimeTurnHandle,
  SendRuntimeMessageInput,
  StartRuntimeTurnInput,
} from "./opencode/types.ts";

test("gateway app starts and stops idempotently", async () => {
  const entries: GatewayLogEntry[] = [];
  const app = createApp({
    logger: (entry) => entries.push(entry),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  expect(app.status.started).toBe(false);

  await app.start();
  await app.start();

  expect(app.status.started).toBe(true);
  expect(entries).toEqual([
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "info",
      component: "app",
      message: "opencode-gateway starting",
    },
  ]);

  await app.stop();
  await app.stop();

  expect(app.status.started).toBe(false);
  expect(entries).toHaveLength(2);
  expect(entries[1]).toEqual({
    timestamp: "2026-01-01T00:00:00.000Z",
    level: "info",
    component: "app",
    message: "opencode-gateway stopped",
  });
});

test("gateway app handles commands before runtime dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ text: "/profiles", commandText: "/profiles" }));

    expect(runtime.calls.ensureSession).toHaveLength(0);
    expect(runtime.calls.send).toHaveLength(0);
    expect(runtime.calls.startTurn).toHaveLength(0);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.message.text).toContain("Gateway profiles:");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app fails fast when profile routing points at a managed target", async () => {
  const config = testConfig(":memory:");
  const target = config.opencode.targets[0];

  if (!target) throw new Error("expected test target");

  config.opencode.targets[0] = {
    ...target,
    mode: "managed",
    serverUrl: undefined,
    workdir: "/tmp/opencode-gateway-managed-target",
  };

  const app = createApp({
    config,
    logger: () => undefined,
    now: fixedNow,
  });

  let error: unknown;

  try {
    await app.start();
  } catch (caught) {
    error = caught;
  } finally {
    await app.stop();
  }

  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error ? error.message : "").toContain(
    "Phase 1 only supports attach-mode OpenCode targets for profile routing: default (managed)",
  );
});

test("gateway app fails fast when OpenCode target is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  runtime.listAgentsError = new Error("Unable to connect");
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  let error: unknown;

  try {
    await app.start();
  } catch (caught) {
    error = caught;
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }

  expect(error).toBeInstanceOf(Error);
  expect(error instanceof Error ? error.message : "").toContain(
    "OpenCode target default is unavailable at http://127.0.0.1:4096. Start OpenCode with `opencode serve` before starting the gateway. Unable to connect",
  );
  expect(channel.started).toBe(false);
  expect(app.status.databaseConnected).toBe(false);
});

test("gateway app dispatches non-command messages to OpenCode and sends final response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ text: "Inspect this repo" }));
    await waitForSent(channel, 1);

    expect(runtime.calls.ensureSession).toHaveLength(1);
    expect(runtime.calls.startTurn).toHaveLength(1);
    expect(runtime.calls.startTurn[0]).toEqual(expect.objectContaining({
      text: "Inspect this repo",
      sessionId: "session-1",
      mode: "sync",
      observePermissions: true,
    }));
    expect(channel.sent).toEqual([
      {
        target: expect.objectContaining({
          channel: "telegram",
          accountId: "default",
          conversationKey,
          conversationId: "123",
        }),
        message: {
          kind: "final",
          format: "markdown",
          text: "answer-1",
        },
      },
    ]);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app answers consecutive compact messages through the sync prompt path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new SyncOnlyRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
    turnRunTimeoutMs: 20,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "first" }));
    await waitForSent(channel, 1);

    await channel.emit(inboundMessage({ id: "message-2", text: "second" }));
    await waitForSent(channel, 2);

    expect(runtime.calls.startTurn.map((call) => call.mode)).toEqual(["sync", "sync"]);
    expect(runtime.calls.send.map((call) => call.text)).toEqual(["first", "second"]);
    expect(runtime.calls.sendAsync).toEqual([]);
    expect(runtime.calls.observe).toEqual([]);
    expect(channel.sent.map((entry) => entry.message.text)).toEqual(["answer-1", "answer-2"]);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app debounces rapid non-command messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db"), { inboundDebounceMs: 20 }),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "first" }));
    await channel.emit(inboundMessage({ id: "message-2", text: "second" }));
    await waitForSent(channel, 1);

    expect(runtime.calls.startTurn).toEqual([
      expect.objectContaining({
        text: "first\n\nsecond",
        sessionId: "session-1",
      }),
    ]);
    expect(channel.sent.map((entry) => entry.message.text)).toEqual(["answer-1"]);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app handles commands immediately while a message is debounced", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db"), { inboundDebounceMs: 20 }),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "first" }));
    await channel.emit(inboundMessage({ id: "message-2", text: "/status", commandText: "/status" }));
    await waitForSent(channel, 1);

    expect(channel.sent[0]?.message.text).toContain("Gateway status:");
    expect(runtime.calls.startTurn).toEqual([]);

    await waitForSent(channel, 2);

    expect(runtime.calls.startTurn).toEqual([expect.objectContaining({ text: "first" })]);
    expect(channel.sent[1]?.message.text).toBe("answer-1");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app denies unknown senders before debounce", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db"), { inboundDebounceMs: 20 }),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ senderId: "999", text: "hello" }));

    expect(runtime.calls.ensureSession).toHaveLength(0);
    expect(runtime.calls.startTurn).toHaveLength(0);
    expect(channel.sent).toEqual([
      expect.objectContaining({
        message: {
          kind: "error",
          format: "plain",
          text: "Access denied: this sender is not allowlisted.",
        },
      }),
    ]);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app sends permission buttons and approves callback actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new PermissionRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ text: "Need a permission" }));
    await waitForSent(channel, 1);

    const card = channel.sent[0]?.message;
    const permissionId = card?.actions?.[0]?.value;

    expect(card).toMatchObject({
      kind: "status",
      text: expect.stringContaining("Command:\nprintf 'permission smoke approve once'"),
      actions: [
        { id: "permission.approve", label: "Approve once" },
        { id: "permission.deny", label: "Deny" },
      ],
    });
    expect(card?.actions?.map((action) => action.id)).not.toContain("permission.always");
    expect(permissionId).toBeDefined();

    await channel.emitAction(permissionAction({ actionId: "permission.approve", value: permissionId, messageId: "sent-1" }));
    await waitForEdited(channel, 1);
    await waitForSent(channel, 2);

    expect(runtime.calls.respondToPermission).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        permissionId: "opencode-permission-1",
        decision: "approve",
      }),
    ]);
    expect(channel.edited[0]?.message.text).toContain("approved once by Tiago");
    expect(channel.edited[0]?.message.actions).toBeUndefined();
    expect(channel.sent[1]?.message).toEqual({ kind: "final", format: "markdown", text: "answer-1" });
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app denies callback actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new PermissionRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ text: "Need a permission" }));
    await waitForSent(channel, 1);

    const denyAction = channel.sent[0]?.message.actions?.find((action) => action.id === "permission.deny");
    expect(denyAction).toBeDefined();

    await channel.emitAction(permissionAction({ actionId: "permission.deny", value: denyAction?.value, messageId: "sent-1" }));
    await waitForEdited(channel, 1);

    expect(runtime.calls.respondToPermission).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        permissionId: "opencode-permission-1",
        decision: "deny",
      }),
    ]);
    expect(channel.edited[0]?.message.text).toContain("denied by Tiago");
    expect(channel.edited[0]?.message.actions).toBeUndefined();
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app accepts permission fallback approve commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new PermissionRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ text: "Need a permission" }));
    await waitForSent(channel, 1);

    const permissionId = channel.sent[0]?.message.actions?.[0]?.value;
    await channel.emit(
      inboundMessage({
        id: "message-2",
        text: `/permission approve ${permissionId}`,
        commandText: `/permission approve ${permissionId}`,
      }),
    );
    await waitForSent(channel, 3);

    expect(runtime.calls.respondToPermission).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        permissionId: "opencode-permission-1",
        decision: "approve",
      }),
    ]);
    expect(channel.sent[1]?.message.text).toContain("approved once by Tiago");
    expect(channel.sent[2]?.message).toEqual({ kind: "final", format: "markdown", text: "answer-1" });
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app handles permission fallback commands immediately when debounce is enabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new PermissionRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db"), { inboundDebounceMs: 20 }),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ text: "Need a permission" }));
    await waitForSent(channel, 1);

    const permissionId = channel.sent[0]?.message.actions?.[0]?.value;
    await channel.emit(
      inboundMessage({
        id: "message-2",
        text: `/permission approve ${permissionId}`,
        commandText: `/permission approve ${permissionId}`,
      }),
    );
    await waitForSent(channel, 3);

    expect(runtime.calls.respondToPermission).toEqual([
      expect.objectContaining({ permissionId: "opencode-permission-1", decision: "approve" }),
    ]);
    expect(channel.sent[1]?.message.text).toContain("approved once by Tiago");
    expect(channel.sent[2]?.message).toEqual({ kind: "final", format: "markdown", text: "answer-1" });
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app requires owner or admin for permission callback actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new PermissionRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ text: "Need a permission" }));
    await waitForSent(channel, 1);

    const permissionId = channel.sent[0]?.message.actions?.[0]?.value;
    await channel.emitAction(permissionAction({ actionId: "permission.approve", value: permissionId, messageId: "sent-1", senderId: "456" }));
    await waitForSent(channel, 2);

    expect(runtime.calls.respondToPermission).toEqual([]);
    expect(channel.sent[1]?.message).toEqual({
      kind: "error",
      format: "plain",
      text: "Permission responses require owner/admin access.",
    });
    expect(channel.edited).toEqual([]);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app rejects always fallback when always allow is disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new PermissionRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ text: "Need a permission" }));
    await waitForSent(channel, 1);

    const permissionId = channel.sent[0]?.message.actions?.[0]?.value;
    await channel.emit(
      inboundMessage({
        id: "message-2",
        text: `/permission always ${permissionId}`,
        commandText: `/permission always ${permissionId}`,
      }),
    );
    await waitForSent(channel, 2);

    expect(runtime.calls.respondToPermission).toEqual([]);
    expect(channel.sent[1]?.message.text).toBe("Always allow is disabled by configuration.");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app can enable always allow permission actions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new PermissionRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db"), { allowAlways: true }),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ text: "Need a permission" }));
    await waitForSent(channel, 1);

    const alwaysAction = channel.sent[0]?.message.actions?.find((action) => action.id === "permission.always");
    expect(alwaysAction).toMatchObject({ label: "Always allow" });

    await channel.emitAction(permissionAction({ actionId: "permission.always", value: alwaysAction?.value, messageId: "sent-1" }));
    await waitForEdited(channel, 1);
    await waitForSent(channel, 2);

    expect(runtime.calls.respondToPermission).toEqual([
      expect.objectContaining({
        permissionId: "opencode-permission-1",
        decision: "always",
      }),
    ]);
    expect(channel.edited[0]?.message.text).toContain("approved always by Tiago");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app rejects permission actions after the run is no longer active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new PermissionRuntime({ completeWithoutResponse: true });
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ text: "Need a permission" }));
    await waitForSent(channel, 2);

    const permissionId = channel.sent[0]?.message.actions?.[0]?.value;
    const editCountBeforeAction = channel.edited.length;
    await channel.emitAction(permissionAction({ actionId: "permission.approve", value: permissionId, messageId: "sent-1" }));
    await waitForEdited(channel, editCountBeforeAction + 1);

    expect(runtime.calls.respondToPermission).toEqual([]);
    expect(channel.edited.at(-1)?.message.text).toContain(`Permission request ${permissionId} is already expired.`);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app visibly expires unresolved permission cards when a run finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new PermissionRuntime({ completeWithoutResponse: true });
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ text: "Need a permission" }));
    await waitForSent(channel, 2);
    await waitForEdited(channel, 1);

    expect(channel.sent[0]?.message.actions?.map((action) => action.id)).toEqual(["permission.approve", "permission.deny"]);
    expect(channel.sent[1]?.message).toEqual({ kind: "final", format: "markdown", text: "answer-1" });
    expect(channel.edited[0]?.message).toEqual({
      kind: "status",
      format: "markdown",
      text: expect.stringContaining("expired because the run completed"),
    });
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app accepts a second message after the first turn completes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "first" }));
    await waitForSent(channel, 1);
    await channel.emit(inboundMessage({ id: "message-2", text: "second" }));
    await waitForSent(channel, 2);

    expect(runtime.calls.startTurn.map((call) => call.text)).toEqual(["first", "second"]);
    expect(channel.sent.map((entry) => entry.message.text)).toEqual(["answer-1", "answer-2"]);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app queues a second message while the first turn is active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new QueueRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    const firstEmit = channel.emit(inboundMessage({ id: "message-1", text: "first" }));
    await runtime.firstSendStarted;

    await channel.emit(inboundMessage({ id: "message-2", text: "second" }));
    await waitForSent(channel, 1);

    expect(channel.sent[0]?.message.text).toContain("Queued behind active run");

    runtime.finishFirstSend();
    await firstEmit;
    await waitForSent(channel, 3);

    expect(runtime.calls.startTurn.map((call) => call.text)).toEqual(["first", "second"]);
    expect(channel.sent.map((entry) => entry.message.text)).toEqual([
      expect.stringContaining("Queued behind active run"),
      "answer-1",
      "answer-2",
    ]);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app drains multiple queued messages in arrival order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new QueueRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "first" }));
    await runtime.firstSendStarted;

    await channel.emit(inboundMessage({ id: "message-2", text: "second" }));
    await channel.emit(inboundMessage({ id: "message-3", text: "third" }));
    await waitForSent(channel, 2);

    runtime.finishFirstSend();
    await waitForSent(channel, 5);

    expect(runtime.calls.startTurn.map((call) => call.text)).toEqual(["first", "second", "third"]);
    expect(channel.sent.map((entry) => entry.message.text)).toEqual([
      expect.stringContaining("Queue size: 1."),
      expect.stringContaining("Queue size: 2."),
      "answer-1",
      "answer-2",
      "answer-3",
    ]);
  } finally {
    runtime.finishFirstSend();
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app /status reports queue diagnostics while a turn is active", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new QueueRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "first" }));
    await runtime.firstSendStarted;

    await channel.emit(inboundMessage({ id: "message-2", text: "second" }));
    await waitForSent(channel, 1);

    await channel.emit(inboundMessage({ id: "message-3", text: "/status", commandText: "/status" }));
    await waitForSent(channel, 2);

    expect(channel.sent[1]?.message.text).toContain("Active run:");
    expect(channel.sent[1]?.message.text).toContain("plan=final:prompt");
    expect(channel.sent[1]?.message.text).toContain("Queue: 1 pending, oldest age=0ms");
  } finally {
    runtime.finishFirstSend();
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app logs debounce lifecycle with routing context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const entries: GatewayLogEntry[] = [];
  const app = createApp({
    config: testConfig(join(dir, "state.db"), { inboundDebounceMs: 20 }),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: (entry) => entries.push(entry),
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "first" }));
    await channel.emit(inboundMessage({ id: "message-2", text: "second" }));
    await waitForSent(channel, 1);

    expect(entries).toContainEqual(expect.objectContaining({
      message: "debounce queued",
      channel: "telegram",
      accountId: "default",
      conversationKey,
      firstMessageId: "message-1",
      lastMessageId: "message-2",
      messageCount: 2,
      flushAfterMs: 20,
    }));
    expect(entries).toContainEqual(expect.objectContaining({
      message: "debounce flushed",
      channel: "telegram",
      accountId: "default",
      conversationKey,
      firstMessageId: "message-1",
      lastMessageId: "message-2",
      messageCount: 2,
      debounceReason: "timer",
    }));
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app logs when a queued turn is drained", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new QueueRuntime();
  const entries: GatewayLogEntry[] = [];
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: (entry) => entries.push(entry),
    now: fixedNow,
  });

  try {
    await app.start();
    const firstEmit = channel.emit(inboundMessage({ id: "message-1", text: "first" }));
    await runtime.firstSendStarted;

    await channel.emit(inboundMessage({ id: "message-2", text: "second" }));
    await waitForSent(channel, 1);

    runtime.finishFirstSend();
    await firstEmit;
    await waitForSent(channel, 3);

    expect(entries).toContainEqual(expect.objectContaining({
      message: "queue drained",
      channel: "telegram",
      accountId: "default",
      conversationKey,
      profileId: "cto",
      targetId: "default",
      sessionId: "session-1",
      initialQueueSize: 1,
    }));
  } finally {
    runtime.finishFirstSend();
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app starts queued messages with the current binding state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new QueueRuntime();
  const config = testConfig(join(dir, "state.db"));
  config.opencode.targets.push({
    id: "review",
    name: "Review workspace",
    mode: "attach",
    serverUrl: "http://127.0.0.1:4097",
  });
  config.profiles.entries.push({
    id: "review",
    displayName: "Review",
    defaultTargetId: "review",
    defaultAgent: "review-agent",
    defaultModel: "provider/review-model",
    defaults: { busyMode: "queue", verbosity: "compact" },
  });
  const app = createApp({
    config,
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "first" }));
    await runtime.firstSendStarted;

    await channel.emit(inboundMessage({ id: "message-2", text: "second" }));
    await waitForSent(channel, 1);

    await channel.emit(inboundMessage({ id: "message-3", text: "/profile review", commandText: "/profile review" }));
    await waitForSent(channel, 2);

    runtime.finishFirstSend();
    await waitForSent(channel, 4);

    expect(channel.sent.map((entry) => entry.message.text)).toEqual([
      expect.stringContaining("Queued behind active run"),
      expect.stringContaining("Switched profile to Review (review)."),
      "answer-1",
      "answer-2",
    ]);
    expect(runtime.calls.startTurn.map((call) => call.text)).toEqual(["first", "second"]);
    expect(runtime.calls.startTurn[1]).toEqual(expect.objectContaining({
      sessionId: "session-2",
      target: expect.objectContaining({ id: "review" }),
      agent: "review-agent",
      model: "provider/review-model",
    }));
  } finally {
    runtime.finishFirstSend();
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app uses agent and model command overrides for future turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "/agent mobile-agent", commandText: "/agent mobile-agent" }));
    await waitForSent(channel, 1);

    await channel.emit(
      inboundMessage({ id: "message-2", text: "/model provider/custom-model", commandText: "/model provider/custom-model" }),
    );
    await waitForSent(channel, 2);

    await channel.emit(inboundMessage({ id: "message-3", text: "inspect" }));
    await waitForSent(channel, 3);

    expect(channel.sent.map((entry) => entry.message.text)).toEqual([
      expect.stringContaining("Agent override set to mobile-agent."),
      expect.stringContaining("Model override set to provider/custom-model."),
      "answer-1",
    ]);
    expect(runtime.calls.startTurn).toEqual([
      expect.objectContaining({
        text: "inspect",
        sessionId: "session-1",
        agent: "mobile-agent",
        model: "provider/custom-model",
      }),
    ]);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app preserves agent and model overrides across restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const databasePath = join(dir, "state.db");
  const firstChannel = new FakeChannel();
  const firstApp = createApp({
    config: testConfig(databasePath),
    runtime: new FakeRuntime(),
    channels: [fakeRegistration(firstChannel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await firstApp.start();
    await firstChannel.emit(inboundMessage({ id: "message-1", text: "/agent mobile-agent", commandText: "/agent mobile-agent" }));
    await waitForSent(firstChannel, 1);
    await firstChannel.emit(
      inboundMessage({ id: "message-2", text: "/model provider/custom-model", commandText: "/model provider/custom-model" }),
    );
    await waitForSent(firstChannel, 2);
    await firstApp.stop();

    const secondChannel = new FakeChannel();
    const secondRuntime = new FakeRuntime();
    const secondApp = createApp({
      config: testConfig(databasePath),
      runtime: secondRuntime,
      channels: [fakeRegistration(secondChannel)],
      logger: () => undefined,
      now: fixedNow,
    });

    try {
      await secondApp.start();
      await secondChannel.emit(inboundMessage({ id: "message-3", text: "inspect" }));
      await waitForSent(secondChannel, 1);

      expect(secondRuntime.calls.ensureSession).toEqual([]);
      expect(secondRuntime.calls.startTurn).toEqual([
        expect.objectContaining({
          text: "inspect",
          sessionId: "session-1",
          agent: "mobile-agent",
          model: "provider/custom-model",
        }),
      ]);
      expect(secondChannel.sent[0]?.message.text).toBe("answer-1");
    } finally {
      await secondApp.stop();
    }
  } finally {
    await firstApp.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app rejects unavailable agent and model selections", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "/agent missing-agent", commandText: "/agent missing-agent" }));
    await waitForSent(channel, 1);

    await channel.emit(inboundMessage({ id: "message-2", text: "/model provider/missing", commandText: "/model provider/missing" }));
    await waitForSent(channel, 2);

    await channel.emit(inboundMessage({ id: "message-3", text: "/status", commandText: "/status" }));
    await waitForSent(channel, 3);

    expect(channel.sent.map((entry) => entry.message.text)).toEqual([
      "Agent not found: missing-agent. Run /agents to see available agents.",
      "Model not found: provider/missing. Run /models to see available models.",
      expect.stringContaining("Session: none"),
    ]);
    expect(runtime.calls.ensureSession).toEqual([]);
    expect(runtime.calls.startTurn).toEqual([]);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app clears invalid overrides on profile target switch before future turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  runtime.agentsByTarget.set("review", [{ id: "review-agent", description: "Review specialist" }]);
  runtime.modelsByTarget.set("review", [
    { id: "provider/review-model", providerId: "provider", modelId: "review-model", name: "Review model" },
  ]);
  const config = testConfig(join(dir, "state.db"));
  config.opencode.targets.push({
    id: "review",
    name: "Review workspace",
    mode: "attach",
    serverUrl: "http://127.0.0.1:4097",
  });
  config.profiles.entries.push({
    id: "review",
    displayName: "Review",
    defaultTargetId: "review",
    defaultAgent: "review-agent",
    defaultModel: "provider/review-model",
    defaults: { busyMode: "queue", verbosity: "compact" },
  });
  const app = createApp({
    config,
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "/agent mobile-agent", commandText: "/agent mobile-agent" }));
    await waitForSent(channel, 1);

    await channel.emit(
      inboundMessage({ id: "message-2", text: "/model provider/custom-model", commandText: "/model provider/custom-model" }),
    );
    await waitForSent(channel, 2);

    await channel.emit(inboundMessage({ id: "message-3", text: "/profile review", commandText: "/profile review" }));
    await waitForSent(channel, 3);

    await channel.emit(inboundMessage({ id: "message-4", text: "inspect" }));
    await waitForSent(channel, 4);

    expect(channel.sent[2]?.message.text).toContain("Cleared agent override: mobile-agent is not available on target review.");
    expect(channel.sent[2]?.message.text).toContain("Cleared model override: provider/custom-model is not available on target review.");
    expect(runtime.calls.startTurn).toEqual([
      expect.objectContaining({
        text: "inspect",
        target: expect.objectContaining({ id: "review" }),
        agent: "review-agent",
        model: "provider/review-model",
      }),
    ]);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app /stop aborts the active run and leaves queued messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new QueueRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "first" }));
    await runtime.firstSendStarted;

    await channel.emit(inboundMessage({ id: "message-2", text: "second" }));
    await waitForSent(channel, 1);

    await channel.emit(inboundMessage({ id: "message-3", text: "/stop", commandText: "/stop" }));
    await waitForSent(channel, 3);

    expect(runtime.calls.startTurn.map((call) => call.text)).toEqual(["first", "second"]);
    expect(channel.sent.map((entry) => entry.message.text)).toEqual([
      expect.stringContaining("Queued behind active run"),
      expect.stringContaining("Stopped active run"),
      "answer-2",
    ]);
  } finally {
    runtime.finishFirstSend();
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const [busyMode, expectedText] of [
  ["reject", "Busy mode reject is active"],
  ["steer", "Busy mode steer is not implemented yet"],
  ["interrupt", "Busy mode interrupt is not implemented yet"],
] as const) {
  test(`gateway app reports ${busyMode} busy mode without queueing`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
    const channel = new FakeChannel();
    const runtime = new QueueRuntime();
    const app = createApp({
      config: testConfig(join(dir, "state.db"), { busyMode }),
      runtime,
      channels: [fakeRegistration(channel)],
      logger: () => undefined,
      now: fixedNow,
    });

    try {
      await app.start();
      await channel.emit(inboundMessage({ id: "message-1", text: "first" }));
      await runtime.firstSendStarted;

      await channel.emit(inboundMessage({ id: "message-2", text: "second" }));
      await waitForSent(channel, 1);

      expect(runtime.calls.startTurn.map((call) => call.text)).toEqual(["first"]);
      expect(channel.sent[0]?.message.text).toContain(expectedText);
    } finally {
      runtime.finishFirstSend();
      await app.stop();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("gateway app accepts a second message after a timed-out turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new StuckThenFinalRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
    turnRunTimeoutMs: 1,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "first" }));
    await waitForSent(channel, 1);
    await channel.emit(inboundMessage({ id: "message-2", text: "second" }));
    await waitForSent(channel, 2);

    expect(runtime.calls.startTurn.map((call) => call.text)).toEqual(["first", "second"]);
    expect(channel.sent.map((entry) => entry.message.text)).toEqual([
      "OpenCode error: OpenCode did not produce a final response within 1ms.",
      "answer-1",
    ]);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app sends typing feedback while handling messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new SlowRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    const emitPromise = channel.emit(inboundMessage({ text: "Take your time" }));

    await runtime.sendStarted;

    expect(channel.typing[0]?.state).toBe("typing");

    runtime.finishSend({
      id: "message-slow",
      sessionId: "session-1",
      status: "running",
      text: "slow answer",
    });
    await emitPromise;
    await waitForSent(channel, 1);

    expect(channel.typing.map((entry) => entry.state)).toContain("idle");
    expect(channel.sent[0]?.message.text).toBe("slow answer");
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app serves health JSON", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime: new FakeRuntime(),
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();

    const healthUrl = app.healthUrl;

    expect(healthUrl).toBeDefined();

    const response = await fetch(healthUrl as string);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      version: "0.1.0",
      gateway: "healthy",
      channels: { "telegram:default": "running" },
      opencodeTargets: { default: "configured" },
      profiles: { default: "cto", active: ["cto"] },
      runtime: {
        activeRunCount: 0,
        queuedTurnCount: 0,
        queuedBindingCount: 0,
        pendingPermissionCount: 0,
        activeRuns: [],
        pendingPermissions: [],
      },
    });

    const missing = await fetch(new URL("/missing", healthUrl).toString());

    expect(missing.status).toBe(404);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app denies unknown senders before runtime dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ senderId: "999", text: "hello" }));

    expect(runtime.calls.ensureSession).toHaveLength(0);
    expect(runtime.calls.send).toHaveLength(0);
    expect(channel.sent).toHaveLength(1);
    expect(channel.sent[0]?.message).toEqual({
      kind: "error",
      format: "plain",
      text: "Access denied: this sender is not allowlisted.",
    });
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app reuses persisted session binding after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const databasePath = join(dir, "state.db");
  const firstChannel = new FakeChannel();
  const firstRuntime = new FakeRuntime();
  const firstApp = createApp({
    config: testConfig(databasePath),
    runtime: firstRuntime,
    channels: [fakeRegistration(firstChannel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await firstApp.start();
    await firstChannel.emit(inboundMessage({ text: "first" }));
    await waitForSent(firstChannel, 1);
    await firstApp.stop();

    const secondChannel = new FakeChannel();
    const secondRuntime = new FakeRuntime();
    const secondApp = createApp({
      config: testConfig(databasePath),
      runtime: secondRuntime,
      channels: [fakeRegistration(secondChannel)],
      logger: () => undefined,
      now: fixedNow,
    });

    try {
      await secondApp.start();
      await secondChannel.emit(inboundMessage({ id: "message-2", text: "second" }));
      await waitForSent(secondChannel, 1);

      expect(secondRuntime.calls.ensureSession).toHaveLength(0);
      expect(secondRuntime.calls.startTurn).toHaveLength(1);
      expect(secondRuntime.calls.startTurn[0]?.sessionId).toBe("session-1");
      expect(secondChannel.sent[0]?.message.text).toBe("answer-1");
    } finally {
      await secondApp.stop();
    }
  } finally {
    await firstApp.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app marks stale active runs aborted on startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const databasePath = join(dir, "state.db");
  const config = testConfig(databasePath);
  const database = await openGatewayDatabase(databasePath);

  try {
    runMigrations(database.db, fixedNow);
    seedDatabaseFromConfig(
      database.db,
      {
        targets: config.opencode.targets,
        profiles: config.profiles.entries,
        accessRules: [{ channel: "telegram", accountId: "default", senderId: "123", role: "owner" }],
      },
      fixedNow,
    );

    const bindings = createConversationBindingRepository(database.db, { now: fixedNow, createId: () => "binding-1" });
    const runs = createRunRepository(database.db, { now: fixedNow, createId: () => "run-1" });
    const binding = bindings.upsert({
      conversationKey,
      channel: "telegram",
      accountId: "default",
      profileId: "cto",
      targetId: "default",
      opencodeSessionId: "session-stale",
      busyMode: "queue",
      verbosity: "compact",
    });

    runs.create({ bindingId: binding.id, opencodeSessionId: "session-stale", opencodeMessageId: "message-stale" });
    database.close();

    const channel = new FakeChannel();
    const app = createApp({
      config,
      runtime: new FakeRuntime(),
      channels: [fakeRegistration(channel)],
      logger: () => undefined,
      now: fixedNow,
    });

    try {
      await app.start();
    } finally {
      await app.stop();
    }

    const verified = await openGatewayDatabase(databasePath);

    try {
      expect(
        verified.db.query("SELECT status, error FROM runs WHERE id = 'run-1'").get(),
      ).toEqual({ status: "aborted", error: "Gateway restarted before observing a final response." });
    } finally {
      verified.close();
    }
  } finally {
    database.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app /new rebinds while old sessions remain listable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new FakeRuntime();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ text: "first" }));
    await waitForSent(channel, 1);
    await channel.emit(inboundMessage({ id: "message-2", text: "/new", commandText: "/new" }));
    await channel.emit(inboundMessage({ id: "message-3", text: "/sessions", commandText: "/sessions" }));

    expect(runtime.calls.startTurn).toHaveLength(1);
    expect(runtime.calls.ensureSession).toHaveLength(2);
    expect(runtime.calls.listSessions).toEqual([expect.objectContaining({ limit: 10 })]);
    expect(channel.sent).toHaveLength(3);
    expect(channel.sent[1]?.message.text).toContain("Previous session: session-1");
    expect(channel.sent[1]?.message.text).toContain("Current session: session-2");
    expect(channel.sent[2]?.message.text).toContain('- session-1 "Generated: first"');
    expect(channel.sent[2]?.message.text).toContain('- session-2 "" (current)');
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app /stop aborts the active run target after a profile switch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const runtime = new QueueRuntime();
  const config = testConfig(join(dir, "state.db"));
  config.opencode.targets.push({
    id: "review",
    name: "Review workspace",
    mode: "attach",
    serverUrl: "http://127.0.0.1:4097",
  });
  config.profiles.entries.push({
    id: "review",
    displayName: "Review",
    defaultTargetId: "review",
    defaults: { busyMode: "queue", verbosity: "compact" },
  });
  const app = createApp({
    config,
    runtime,
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();
    await channel.emit(inboundMessage({ id: "message-1", text: "first" }));
    await runtime.firstSendStarted;

    await channel.emit(inboundMessage({ id: "message-2", text: "/profile review", commandText: "/profile review" }));
    await waitForSent(channel, 1);

    await channel.emit(inboundMessage({ id: "message-3", text: "/stop", commandText: "/stop" }));
    await waitForSent(channel, 2);

    expect(runtime.calls.abort[0]).toEqual(expect.objectContaining({
      target: expect.objectContaining({ id: "default" }),
      sessionId: "session-1",
    }));
  } finally {
    runtime.finishFirstSend();
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("gateway app stops started channels and closes the database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-app-"));
  const channel = new FakeChannel();
  const app = createApp({
    config: testConfig(join(dir, "state.db")),
    runtime: new FakeRuntime(),
    channels: [fakeRegistration(channel)],
    logger: () => undefined,
    now: fixedNow,
  });

  try {
    await app.start();

    expect(channel.started).toBe(true);
    expect(app.status.databaseConnected).toBe(true);

    await app.stop();

    expect(channel.stopped).toBe(true);
    expect(app.status.databaseConnected).toBe(false);
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

const conversationKey = "telegram:default:dm:123";

function fakeRegistration(channel: FakeChannel): GatewayChannelRegistration<unknown> {
  return {
    adapter: channel,
    accountId: "default",
    config: {},
  };
}

function testConfig(
  databasePath: string,
  options: { allowAlways?: boolean; busyMode?: GatewayConfig["defaults"]["busyMode"]; inboundDebounceMs?: number } = {},
): GatewayConfig {
  const busyMode = options.busyMode ?? "queue";

  return {
    gateway: {
      host: "127.0.0.1",
      port: 0,
      databasePath,
      logLevel: "info",
    },
    opencode: {
      targets: [
        {
          id: "default",
          name: "Default workspace",
          mode: "attach",
          serverUrl: "http://127.0.0.1:4096",
        },
      ],
    },
    profiles: {
      default: "cto",
      entries: [
        {
          id: "cto",
          displayName: "CTO",
          defaultTargetId: "default",
          defaults: { busyMode, verbosity: "compact" },
        },
      ],
    },
    channels: {
      telegram: {
        enabled: false,
        allowFrom: ["123"],
        groups: {},
      },
    },
    interactive: {
      permissions: {
        mode: "buttons",
        fallbackCommands: true,
        allowAlways: options.allowAlways ?? false,
      },
    },
    defaults: {
      profile: "cto",
      target: "default",
      busyMode,
      verbosity: "compact",
      inboundDebounceMs: options.inboundDebounceMs ?? 0,
    },
  };
}

function inboundMessage(options: { id?: string; senderId?: string; text?: string; commandText?: string } = {}): InboundMessage {
  return {
    id: options.id ?? "message-1",
    channel: "telegram",
    accountId: "default",
    conversation: {
      key: conversationKey,
      type: "dm",
      id: "123",
    },
    sender: {
      id: options.senderId ?? "123",
      username: "tiago",
      displayName: "Tiago",
    },
    timestamp: "2026-01-01T00:00:00.000Z",
    text: options.text ?? "hello",
    commandText: options.commandText,
    attachments: [],
  };
}

function fixedNow(): Date {
  return new Date("2026-01-01T00:00:00.000Z");
}

async function waitForSent(channel: FakeChannel, count: number): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (channel.sent.length < count && Date.now() < deadline) {
    await Bun.sleep(5);
  }

  expect(channel.sent.length).toBeGreaterThanOrEqual(count);
}

async function waitForEdited(channel: FakeChannel, count: number): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (channel.edited.length < count && Date.now() < deadline) {
    await Bun.sleep(5);
  }

  expect(channel.edited.length).toBeGreaterThanOrEqual(count);
}

function permissionAction(options: { actionId: string; value?: string; messageId: string; senderId?: string }): ChannelAction {
  return {
    id: "callback-1",
    channel: "telegram",
    accountId: "default",
    conversation: {
      key: conversationKey,
      type: "dm",
      id: "123",
    },
    sender: {
      id: options.senderId ?? "123",
      username: "tiago",
      displayName: "Tiago",
    },
    message: {
      id: options.messageId,
      timestamp: "2026-01-01T00:00:00.000Z",
    },
    actionId: options.actionId,
    value: options.value,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

class FakeChannel implements ChannelAdapter<unknown> {
  readonly id = "telegram";
  readonly sent: Array<{ target: OutboundTarget; message: OutboundMessage }> = [];
  readonly edited: Array<{ receipt: SendReceipt; message: OutboundMessage }> = [];
  readonly typing: Array<{ target: OutboundTarget; state: TypingState }> = [];
  started = false;
  stopped = false;
  private context: ChannelStartContext<unknown> | undefined;

  async start(ctx: ChannelStartContext<unknown>): Promise<void> {
    this.started = true;
    this.stopped = false;
    this.context = ctx;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async send(target: OutboundTarget, message: OutboundMessage): Promise<SendReceipt> {
    this.sent.push({ target, message });

    return {
      channel: target.channel,
      accountId: target.accountId,
      conversationKey: target.conversationKey,
      platformMessageId: `sent-${this.sent.length}`,
      timestamp: "2026-01-01T00:00:00.000Z",
    };
  }

  async edit(receipt: SendReceipt, message: OutboundMessage): Promise<SendReceipt> {
    this.edited.push({ receipt, message });
    return receipt;
  }

  async sendTyping(target: OutboundTarget, state: TypingState): Promise<void> {
    this.typing.push({ target, state });
  }

  async emit(message: InboundMessage): Promise<void> {
    await this.emitEvent({ type: "message", message });
  }

  async emitEvent(event: ChannelEvent): Promise<void> {
    if (!this.context) throw new Error("Fake channel is not started");
    await this.context.emit(event);
  }

  async emitAction(action: ChannelAction): Promise<void> {
    await this.emitEvent({ type: "action", action });
  }
}

class FakeRuntime implements AgentRuntime {
  readonly calls: {
    ensureSession: EnsureSessionInput[];
    send: SendRuntimeMessageInput[];
    startTurn: StartRuntimeTurnInput[];
    sendAsync: SendRuntimeMessageInput[];
    observe: ObserveRuntimeTurnInput[];
    abort: AbortRuntimeTurnInput[];
    listSessions: ListRuntimeSessionsInput[];
    listAgents: ListRuntimeAgentsInput[];
    listModels: ListRuntimeModelsInput[];
    respondToPermission: PermissionResponseInput[];
  } = {
    ensureSession: [],
    send: [],
    startTurn: [],
    sendAsync: [],
    observe: [],
    abort: [],
    listSessions: [],
    listAgents: [],
    listModels: [],
    respondToPermission: [],
  };

  private nextSessionNumber = 1;
  private nextMessageNumber = 1;
  private sessions: RuntimeSession[] = [];
  agents: RuntimeAgent[] = [
    { id: "mobile-agent", description: "Mobile specialist" },
    { id: "review-agent", description: "Review specialist" },
  ];
  models: RuntimeModel[] = [
    { id: "provider/custom-model", providerId: "provider", modelId: "custom-model", name: "Custom model" },
    { id: "provider/review-model", providerId: "provider", modelId: "review-model", name: "Review model" },
  ];
  readonly agentsByTarget = new Map<string, RuntimeAgent[]>();
  readonly modelsByTarget = new Map<string, RuntimeModel[]>();
  listAgentsError: Error | undefined;
  protected readonly asyncAnswers = new Map<string, string>();

  async ensureSession(input: EnsureSessionInput): Promise<RuntimeSession> {
    this.calls.ensureSession.push(input);

    if (input.sessionId) {
      return {
        id: input.sessionId,
        targetId: input.target.id,
        title: `Existing ${input.sessionId}`,
      };
    }

    const session = {
      id: `session-${this.nextSessionNumber++}`,
      targetId: input.target.id,
      title: input.title,
    };

    this.sessions.push(session);

    return session;
  }

  async send(input: SendRuntimeMessageInput): Promise<RuntimeTurn> {
    this.calls.send.push(input);

    const messageNumber = this.nextMessageNumber++;
    const session = this.sessions.find((candidate) => candidate.id === input.sessionId);

    if (session && !session.title) {
      session.title = `Generated: ${input.text}`;
    }

    return {
      id: `message-${messageNumber}`,
      sessionId: input.sessionId,
      status: "completed",
      text: `answer-${messageNumber}`,
    };
  }

  async sendAsync(input: SendRuntimeMessageInput): Promise<RuntimeTurnHandle> {
    this.calls.sendAsync.push(input);

    const messageNumber = this.nextMessageNumber++;
    const id = `message-${messageNumber}`;
    const session = this.sessions.find((candidate) => candidate.id === input.sessionId);

    if (session && !session.title) {
      session.title = `Generated: ${input.text}`;
    }

    this.asyncAnswers.set(id, `answer-${messageNumber}`);

    return {
      id,
      sessionId: input.sessionId,
      targetId: input.target.id,
      status: "running",
    };
  }

  async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    this.calls.startTurn.push(input);

    if (input.mode === "sync") {
      return {
        handle: {
          id: "message-sync",
          sessionId: input.sessionId,
          targetId: input.target.id,
          status: "running",
        },
        events: this.syncEvents(input),
      };
    }

    const handle = await this.sendAsync(input);

    return {
      handle,
      events: this.observe({
        target: input.target,
        sessionId: input.sessionId,
        turnId: handle.id,
        signal: input.signal,
      }),
    };
  }

  protected async *syncEvents(input: StartRuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    const turn = await this.send(input);

    if (input.signal?.aborted) return;

    if (turn.status === "error") {
      yield { type: "error", message: turn.text ?? "OpenCode returned an error response" };
      return;
    }

    yield {
      type: "final",
      text: turn.text ?? "",
      costUsd: turn.costUsd,
      tokens: turn.tokens,
    };
  }

  async *observe(input: ObserveRuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    this.calls.observe.push(input);

    if (input.signal?.aborted) return;

    yield {
      type: "final",
      text: this.asyncAnswers.get(input.turnId ?? "") ?? "answer",
    };
  }

  async abort(input: AbortRuntimeTurnInput): Promise<void> {
    this.calls.abort.push(input);
  }

  async respondToPermission(input: PermissionResponseInput): Promise<void> {
    this.calls.respondToPermission.push(input);
  }

  async listSessions(input: ListRuntimeSessionsInput): Promise<RuntimeSession[]> {
    this.calls.listSessions.push(input);
    return this.sessions;
  }

  async listAgents(input: ListRuntimeAgentsInput): Promise<RuntimeAgent[]> {
    this.calls.listAgents.push(input);
    if (this.listAgentsError) throw this.listAgentsError;
    return this.agentsByTarget.get(input.target.id) ?? this.agents;
  }

  async listModels(input: ListRuntimeModelsInput): Promise<RuntimeModel[]> {
    this.calls.listModels.push(input);
    return this.modelsByTarget.get(input.target.id) ?? this.models;
  }
}

class PermissionRuntime extends FakeRuntime {
  private readonly completeWithoutResponse: boolean;
  private readonly permissionResponseReceived: Promise<void>;
  private resolvePermissionResponse: (() => void) | undefined;

  constructor(options: { completeWithoutResponse?: boolean } = {}) {
    super();
    this.completeWithoutResponse = options.completeWithoutResponse ?? false;
    this.permissionResponseReceived = new Promise((resolve) => {
      this.resolvePermissionResponse = resolve;
    });
  }

  override async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    this.calls.startTurn.push(input);

    return {
      handle: {
        id: "message-sync",
        sessionId: input.sessionId,
        targetId: input.target.id,
        status: "running",
      },
      events: this.permissionEvents(input),
    };
  }

  private async *permissionEvents(input: StartRuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    if (input.observePermissions) {
      yield {
        type: "permission_request",
        id: "opencode-permission-1",
        summary: "Run bash command",
        details: { action: "bash", resources: ["printf 'permission smoke approve once'"] },
      };
    }

    if (!this.completeWithoutResponse) {
      await this.waitForPermissionResponse(input.signal);
      if (input.signal?.aborted) return;
    }

    yield* this.syncEvents(input);
  }

  override async respondToPermission(input: PermissionResponseInput): Promise<void> {
    await super.respondToPermission(input);
    this.resolvePermissionResponse?.();
  }

  private async waitForPermissionResponse(signal: AbortSignal | undefined): Promise<void> {
    if (signal?.aborted) return;

    await new Promise<void>((resolve) => {
      const done = () => {
        signal?.removeEventListener("abort", done);
        resolve();
      };

      signal?.addEventListener("abort", done, { once: true });
      this.permissionResponseReceived.then(done);
    });
  }

  override async *observe(input: ObserveRuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    this.calls.observe.push(input);

    if (input.signal?.aborted) return;

    yield {
      type: "permission_request",
      id: "opencode-permission-1",
      summary: "Run bash command",
      details: { action: "bash", resources: ["printf 'permission smoke approve once'"] },
    };
    yield {
      type: "final",
      text: this.asyncAnswers.get(input.turnId ?? "") ?? "answer",
    };
  }
}

class StuckThenFinalRuntime extends FakeRuntime {
  private turnCount = 0;

  override async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    this.calls.startTurn.push(input);
    this.turnCount += 1;

    return {
      handle: {
        id: `message-stuck-${this.turnCount}`,
        sessionId: input.sessionId,
        targetId: input.target.id,
        status: "running",
      },
      events: this.turnCount === 1 ? this.neverFinal(input.signal) : this.syncEvents(input),
    };
  }

  private async *neverFinal(signal: AbortSignal | undefined): AsyncIterable<RuntimeEvent> {
    await new Promise<void>((resolve) => {
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

class SyncOnlyRuntime extends FakeRuntime {
  override async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    if (input.mode === "sync") return super.startTurn(input);

    this.calls.startTurn.push(input);

    return {
      handle: {
        id: `message-async-${this.calls.startTurn.length}`,
        sessionId: input.sessionId,
        targetId: input.target.id,
        status: "running",
      },
      events: this.neverFinal(input.signal),
    };
  }

  private async *neverFinal(signal: AbortSignal | undefined): AsyncIterable<RuntimeEvent> {
    await new Promise<void>((resolve) => {
      signal?.addEventListener("abort", () => resolve(), { once: true });
    });
  }
}

class QueueRuntime extends FakeRuntime {
  private resolveFirstSendStarted: (() => void) | undefined;
  private resolveFirstSend: (() => void) | undefined;
  private turnCount = 0;

  readonly firstSendStarted = new Promise<void>((resolve) => {
    this.resolveFirstSendStarted = resolve;
  });
  private readonly firstSendFinished = new Promise<void>((resolve) => {
    this.resolveFirstSend = resolve;
  });

  override async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    this.calls.startTurn.push(input);
    this.turnCount += 1;
    const messageNumber = this.turnCount;

    return {
      handle: {
        id: `message-${messageNumber}`,
        sessionId: input.sessionId,
        targetId: input.target.id,
        status: "running",
      },
      events: this.turnEvents(input.signal, messageNumber),
    };
  }

  private async *turnEvents(signal: AbortSignal | undefined, messageNumber: number): AsyncIterable<RuntimeEvent> {
    if (messageNumber === 1) {
      this.resolveFirstSendStarted?.();
      await this.firstSendFinished;
    }

    if (signal?.aborted) return;

    yield { type: "final", text: `answer-${messageNumber}` };
  }

  finishFirstSend(): void {
    this.resolveFirstSend?.();
  }
}

class SlowRuntime extends FakeRuntime {
  private resolveSendStarted: (() => void) | undefined;
  private resolveSend: ((turn: RuntimeTurn) => void) | undefined;

  readonly sendStarted = new Promise<void>((resolve) => {
    this.resolveSendStarted = resolve;
  });

  private readonly sendFinished = new Promise<RuntimeTurn>((resolve) => {
    this.resolveSend = resolve;
  });

  override async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    this.calls.startTurn.push(input);

    return {
      handle: {
        id: "message-slow",
        sessionId: input.sessionId,
        targetId: input.target.id,
        status: "running",
      },
      events: this.turnEvents(input.signal),
    };
  }

  private async *turnEvents(signal: AbortSignal | undefined): AsyncIterable<RuntimeEvent> {
    this.resolveSendStarted?.();
    const turn = await this.sendFinished;

    if (signal?.aborted) return;

    if (turn.status === "error") {
      yield { type: "error", message: turn.text ?? "OpenCode returned an error response" };
      return;
    }

    yield {
      type: "final",
      text: turn.text ?? "",
      costUsd: turn.costUsd,
      tokens: turn.tokens,
    };
  }

  finishSend(turn: RuntimeTurn): void {
    this.resolveSend?.(turn);
  }
}
