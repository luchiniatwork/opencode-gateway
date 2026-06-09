import { expect, test } from "bun:test";

import type { InboundMessage, SendReceipt } from "../channels/types.ts";
import { openGatewayDatabase, type GatewayDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrations.ts";
import { createConversationBindingRepository } from "../db/repositories/conversation-bindings.ts";
import { createProfileRepository } from "../db/repositories/profiles.ts";
import { createRunRepository } from "../db/repositories/runs.ts";
import { seedDatabaseFromConfig } from "../db/repositories/seeds.ts";
import { createTargetRepository } from "../db/repositories/targets.ts";
import type { ConversationBindingRecord, ProfileRecord, RunRecord, TargetRecord } from "../db/types.ts";
import type { ResolvedDispatch } from "../dispatch/resolver.ts";
import type { OutboundMessage } from "../messages/types.ts";
import type {
  AbortRuntimeTurnInput,
  AgentRuntime,
  EnsureSessionInput,
  ListRuntimeSessionsInput,
  ObserveRuntimeTurnInput,
  PermissionResponseInput,
  RuntimeEvent,
  RuntimeSession,
  RuntimeTurn,
  RuntimeTurnHandle,
  SendRuntimeMessageInput,
} from "../opencode/types.ts";
import { createTurnRunner } from "./turn-runner.ts";

test("turn runner starts async turns, stores message IDs, and finishes final events", async () => {
  const harness = await createHarness({ events: [{ type: "final", text: "done" }] });

  try {
    const result = await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 1);

    expect(result.status).toBe("started");
    expect(harness.runtime.calls.sendAsync).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        text: "inspect",
        agent: "cto-agent",
        model: "provider/model",
      }),
    ]);
    expect(harness.runtime.calls.observe).toEqual([
      expect.objectContaining({ sessionId: "session-1", turnId: "message-1" }),
    ]);
    expect(harness.deliveries).toEqual([{ kind: "final", format: "markdown", text: "done" }]);
    expect(runRows(harness.database)).toEqual([
      { id: "run-1", status: "completed", opencode_message_id: "message-1", error: null },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner marks sendAsync failures as run errors", async () => {
  const harness = await createHarness({ sendAsyncError: new Error("OpenCode unavailable") });

  try {
    const result = await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.error : undefined).toBe("OpenCode unavailable");
    expect(harness.deliveries).toEqual([]);
    expect(runRows(harness.database)).toEqual([
      { id: "run-1", status: "error", opencode_message_id: null, error: "OpenCode unavailable" },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner converts runtime error events to error messages and run errors", async () => {
  const harness = await createHarness({ events: [{ type: "error", message: "stream failed", retryable: true }] });

  try {
    await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 1);

    expect(harness.deliveries).toEqual([{ kind: "error", format: "plain", text: "OpenCode error: stream failed" }]);
    expect(runRows(harness.database)).toEqual([
      { id: "run-1", status: "error", opencode_message_id: "message-1", error: "stream failed" },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner aborts the active async turn and cancels observation", async () => {
  const harness = await createHarness({ waitForAbort: true });

  try {
    await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForObserve(harness.runtime);

    const result = await harness.runner.abortActive({
      binding: harness.resolution.binding,
      target: harness.resolution.target,
      reason: "test stop",
    });

    expect(result.status).toBe("aborted");
    expect(harness.runtime.calls.abort).toEqual([
      expect.objectContaining({ sessionId: "session-1", turnId: "message-1", reason: "test stop" }),
    ]);
    expect(runRows(harness.database)).toEqual([
      { id: "run-1", status: "aborted", opencode_message_id: "message-1", error: null },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner sends compact progress after the configured delay", async () => {
  const harness = await createHarness({
    events: [{ type: "status", status: "running" }, { type: "final", text: "done" }],
    eventDelayMs: 5,
    progressDelayMs: 1,
  });

  try {
    await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 2);

    expect(harness.deliveries).toEqual([
      { kind: "progress", format: "plain", text: "Working on it..." },
      { kind: "final", format: "markdown", text: "done" },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner renders tool progress for tools verbosity", async () => {
  const harness = await createHarness({
    events: [
      { type: "tool_start", id: "tool-1", name: "bash", summary: "Run tests" },
      { type: "tool_end", id: "tool-1", name: "bash", ok: true, summary: "Passed" },
      { type: "final", text: "done" },
    ],
    eventDelayMs: 5,
    progressDelayMs: 1,
    verbosity: "tools",
  });

  try {
    await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 3);

    expect(harness.deliveries).toEqual([
      {
        kind: "progress",
        format: "plain",
        text: "Working on it...\nTool bash started: Run tests",
      },
      { kind: "progress", format: "plain", text: "Tool bash completed: Passed" },
      { kind: "final", format: "markdown", text: "done" },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

interface HarnessOptions {
  events?: RuntimeEvent[];
  sendAsyncError?: Error;
  waitForAbort?: boolean;
  eventDelayMs?: number;
  progressDelayMs?: number;
  verbosity?: "off" | "compact" | "tools" | "verbose";
}

interface Harness {
  database: GatewayDatabase;
  runtime: FakeRuntime;
  resolution: ResolvedDispatch;
  deliveries: OutboundMessage[];
  delivery: {
    send(message: OutboundMessage): Promise<SendReceipt>;
  };
  runner: ReturnType<typeof createTurnRunner>;
}

async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const database = await openGatewayDatabase(":memory:");

  runMigrations(database.db, fixedNow);
  seedDatabaseFromConfig(
    database.db,
    {
      targets: [targetSeed()],
      profiles: [profileSeed()],
      accessRules: [],
    },
    fixedNow,
  );

  const bindings = createConversationBindingRepository(database.db, {
    now: fixedNow,
    createId: () => "binding-1",
  });
  const runs = createRunRepository(database.db, {
    now: fixedNow,
    createId: () => "run-1",
  });
  const targets = createTargetRepository(database.db, fixedNow);
  const profiles = createProfileRepository(database.db, fixedNow);
  const binding = bindings.upsert({
    conversationKey,
    channel: "telegram",
    accountId: "default",
    profileId: "cto",
    targetId: "default",
    opencodeSessionId: "session-1",
    agent: "cto-agent",
    model: "provider/model",
    busyMode: "queue",
    verbosity: options.verbosity ?? "compact",
  });
  const profile = requireRecord(profiles.getById("cto"), "profile");
  const target = requireRecord(targets.getById("default"), "target");
  const runtime = new FakeRuntime(options);
  const deliveries: OutboundMessage[] = [];
  const runner = createTurnRunner({ runtime, runs, progressDelayMs: options.progressDelayMs });

  return {
    database,
    runtime,
    resolution: resolved(binding, profile, target),
    deliveries,
    delivery: {
      async send(message) {
        deliveries.push(message);
        return receiptFor(`sent-${deliveries.length}`);
      },
    },
    runner,
  };
}

function receiptFor(platformMessageId: string): SendReceipt {
  return {
    channel: "telegram",
    accountId: "default",
    conversationKey,
    platformMessageId,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function resolved(binding: ConversationBindingRecord, profile: ProfileRecord, target: TargetRecord): ResolvedDispatch {
  return {
    role: "owner",
    binding,
    profile,
    target,
    agent: binding.agent,
    model: binding.model,
  };
}

function inboundMessage(): InboundMessage {
  return {
    id: "message-1",
    channel: "telegram",
    accountId: "default",
    conversation: { key: conversationKey, type: "dm", id: "123" },
    sender: { id: "123", username: "tiago" },
    timestamp: "2026-01-01T00:00:00.000Z",
    text: "inspect",
    attachments: [],
  };
}

function targetSeed() {
  return {
    id: "default",
    name: "Default workspace",
    mode: "attach" as const,
    serverUrl: "http://127.0.0.1:4096",
  };
}

function profileSeed() {
  return {
    id: "cto",
    displayName: "CTO",
    defaultTargetId: "default",
    defaultAgent: "cto-agent",
    defaultModel: "provider/model",
    defaults: { busyMode: "queue" as const, verbosity: "compact" as const },
  };
}

function fixedNow(): Date {
  return new Date("2026-01-01T00:00:00.000Z");
}

async function waitForDeliveries(deliveries: OutboundMessage[], count: number): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (deliveries.length < count && Date.now() < deadline) {
    await Bun.sleep(5);
  }

  expect(deliveries.length).toBeGreaterThanOrEqual(count);
}

async function waitForObserve(runtime: FakeRuntime): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (runtime.calls.observe.length === 0 && Date.now() < deadline) {
    await Bun.sleep(5);
  }

  expect(runtime.calls.observe).toHaveLength(1);
}

function runRows(database: GatewayDatabase): Array<{
  id: string;
  status: string;
  opencode_message_id: string | null;
  error: string | null;
}> {
  return database.db
    .query("SELECT id, status, opencode_message_id, error FROM runs ORDER BY id")
    .all() as Array<{ id: string; status: string; opencode_message_id: string | null; error: string | null }>;
}

function requireRecord<T>(record: T | undefined, label: string): T {
  if (!record) throw new Error(`missing ${label}`);
  return record;
}

const conversationKey = "telegram:default:dm:123";

class FakeRuntime implements AgentRuntime {
  readonly calls: {
    sendAsync: SendRuntimeMessageInput[];
    observe: ObserveRuntimeTurnInput[];
    abort: AbortRuntimeTurnInput[];
  } = {
    sendAsync: [],
    observe: [],
    abort: [],
  };

  private readonly events: RuntimeEvent[];
  private readonly sendAsyncError: Error | undefined;
  private readonly waitForAbort: boolean;
  private readonly eventDelayMs: number;

  constructor(options: HarnessOptions) {
    this.events = options.events ?? [];
    this.sendAsyncError = options.sendAsyncError;
    this.waitForAbort = options.waitForAbort ?? false;
    this.eventDelayMs = options.eventDelayMs ?? 0;
  }

  async ensureSession(input: EnsureSessionInput): Promise<RuntimeSession> {
    return { id: input.sessionId ?? "session-1", targetId: input.target.id };
  }

  async send(input: SendRuntimeMessageInput): Promise<RuntimeTurn> {
    return { id: "message-sync", sessionId: input.sessionId, status: "completed", text: input.text };
  }

  async sendAsync(input: SendRuntimeMessageInput): Promise<RuntimeTurnHandle> {
    this.calls.sendAsync.push(input);

    if (this.sendAsyncError) throw this.sendAsyncError;

    return {
      id: "message-1",
      sessionId: input.sessionId,
      targetId: input.target.id,
      status: "running",
    };
  }

  async *observe(input: ObserveRuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    this.calls.observe.push(input);

    if (this.waitForAbort) {
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }

    for (const [index, event] of this.events.entries()) {
      if (input.signal?.aborted) return;
      yield event;

      if (this.eventDelayMs > 0 && index < this.events.length - 1) {
        await Bun.sleep(this.eventDelayMs);
      }
    }
  }

  async abort(input: AbortRuntimeTurnInput): Promise<void> {
    this.calls.abort.push(input);
  }

  async respondToPermission(input: PermissionResponseInput): Promise<void> {
    throw new Error(`unexpected permission response ${input.permissionId}`);
  }

  async listSessions(input: ListRuntimeSessionsInput): Promise<RuntimeSession[]> {
    return [{ id: input.target.id, targetId: input.target.id }];
  }
}
