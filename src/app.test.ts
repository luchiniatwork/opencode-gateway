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
  ListRuntimeSessionsInput,
  ObserveRuntimeTurnInput,
  PermissionResponseInput,
  RuntimeEvent,
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
    await waitForSent(channel, 2);

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

    expect(runtime.calls.respondToPermission).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        permissionId: "opencode-permission-1",
        decision: "approve",
      }),
    ]);
    expect(channel.edited[0]?.message.text).toContain("approved once by Tiago");
    expect(channel.edited[0]?.message.actions).toBeUndefined();
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
    await waitForSent(channel, 2);

    const permissionId = channel.sent[0]?.message.actions?.[0]?.value;
    await channel.emit(
      inboundMessage({
        id: "message-2",
        text: `/permission always ${permissionId}`,
        commandText: `/permission always ${permissionId}`,
      }),
    );
    await waitForSent(channel, 3);

    expect(runtime.calls.respondToPermission).toEqual([]);
    expect(channel.sent[2]?.message.text).toBe("Always allow is disabled by configuration.");
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
    await waitForSent(channel, 2);

    const alwaysAction = channel.sent[0]?.message.actions?.find((action) => action.id === "permission.always");
    expect(alwaysAction).toMatchObject({ label: "Always allow" });

    await channel.emitAction(permissionAction({ actionId: "permission.always", value: alwaysAction?.value, messageId: "sent-1" }));
    await waitForEdited(channel, 1);

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
      runtime: { activeRuns: [], pendingPermissions: [] },
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

function testConfig(databasePath: string, options: { allowAlways?: boolean } = {}): GatewayConfig {
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
          defaults: { busyMode: "queue", verbosity: "compact" },
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
      busyMode: "queue",
      verbosity: "compact",
      inboundDebounceMs: 1500,
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

function permissionAction(options: { actionId: string; value?: string; messageId: string }): ChannelAction {
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
      id: "123",
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
    respondToPermission: PermissionResponseInput[];
  } = {
    ensureSession: [],
    send: [],
    startTurn: [],
    sendAsync: [],
    observe: [],
    abort: [],
    listSessions: [],
    respondToPermission: [],
  };

  private nextSessionNumber = 1;
  private nextMessageNumber = 1;
  private sessions: RuntimeSession[] = [];
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
}

class PermissionRuntime extends FakeRuntime {
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

    yield* this.syncEvents(input);
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

class SlowRuntime extends FakeRuntime {
  private resolveSendStarted: (() => void) | undefined;
  private resolveSend: ((turn: RuntimeTurn) => void) | undefined;

  readonly sendStarted = new Promise<void>((resolve) => {
    this.resolveSendStarted = resolve;
  });

  private readonly sendFinished = new Promise<RuntimeTurn>((resolve) => {
    this.resolveSend = resolve;
  });

  override async send(input: SendRuntimeMessageInput): Promise<RuntimeTurn> {
    this.calls.send.push(input);
    this.resolveSendStarted?.();

    return this.sendFinished;
  }

  finishSend(turn: RuntimeTurn): void {
    this.resolveSend?.(turn);
  }
}
