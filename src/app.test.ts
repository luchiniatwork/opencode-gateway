import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp, type GatewayChannelRegistration, type GatewayLogEntry } from "./app.ts";
import type {
  ChannelAdapter,
  ChannelEvent,
  ChannelLogger,
  ChannelStartContext,
  InboundMessage,
  OutboundTarget,
  SendReceipt,
} from "./channels/types.ts";
import type { GatewayConfig } from "./config/schema.ts";
import type { OutboundMessage } from "./messages/types.ts";
import type {
  AbortRuntimeTurnInput,
  AgentRuntime,
  EnsureSessionInput,
  ListRuntimeSessionsInput,
  RuntimeSession,
  RuntimeTurn,
  SendRuntimeMessageInput,
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

    expect(runtime.calls.ensureSession).toHaveLength(1);
    expect(runtime.calls.send).toHaveLength(1);
    expect(runtime.calls.send[0]?.text).toBe("Inspect this repo");
    expect(runtime.calls.send[0]?.sessionId).toBe("session-1");
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

      expect(secondRuntime.calls.ensureSession).toHaveLength(0);
      expect(secondRuntime.calls.send).toHaveLength(1);
      expect(secondRuntime.calls.send[0]?.sessionId).toBe("session-1");
      expect(secondChannel.sent[0]?.message.text).toBe("answer-1");
    } finally {
      await secondApp.stop();
    }
  } finally {
    await firstApp.stop();
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

function testConfig(databasePath: string): GatewayConfig {
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

class FakeChannel implements ChannelAdapter<unknown> {
  readonly id = "telegram";
  readonly sent: Array<{ target: OutboundTarget; message: OutboundMessage }> = [];
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

  async emit(message: InboundMessage): Promise<void> {
    await this.emitEvent({ type: "message", message });
  }

  async emitEvent(event: ChannelEvent): Promise<void> {
    if (!this.context) throw new Error("Fake channel is not started");
    await this.context.emit(event);
  }
}

class FakeRuntime implements AgentRuntime {
  readonly calls: {
    ensureSession: EnsureSessionInput[];
    send: SendRuntimeMessageInput[];
    abort: AbortRuntimeTurnInput[];
    listSessions: ListRuntimeSessionsInput[];
  } = {
    ensureSession: [],
    send: [],
    abort: [],
    listSessions: [],
  };

  private nextSessionNumber = 1;
  private nextMessageNumber = 1;

  async ensureSession(input: EnsureSessionInput): Promise<RuntimeSession> {
    this.calls.ensureSession.push(input);

    if (input.sessionId) {
      return {
        id: input.sessionId,
        targetId: input.target.id,
        title: `Existing ${input.sessionId}`,
      };
    }

    return {
      id: `session-${this.nextSessionNumber++}`,
      targetId: input.target.id,
      title: input.title,
    };
  }

  async send(input: SendRuntimeMessageInput): Promise<RuntimeTurn> {
    this.calls.send.push(input);

    const messageNumber = this.nextMessageNumber++;

    return {
      id: `message-${messageNumber}`,
      sessionId: input.sessionId,
      status: "completed",
      text: `answer-${messageNumber}`,
    };
  }

  async abort(input: AbortRuntimeTurnInput): Promise<void> {
    this.calls.abort.push(input);
  }

  async listSessions(input: ListRuntimeSessionsInput): Promise<RuntimeSession[]> {
    this.calls.listSessions.push(input);
    return [];
  }
}
