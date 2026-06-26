import { expect, test } from "bun:test";

import type { InboundMessage, SendReceipt, TypingState } from "../channels/types.ts";
import { openGatewayDatabase, type GatewayDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrations.ts";
import { createConversationBindingRepository } from "../db/repositories/conversation-bindings.ts";
import { createDeliveryReceiptRepository } from "../db/repositories/delivery-receipts.ts";
import { createPendingPermissionRepository } from "../db/repositories/pending-permissions.ts";
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
} from "../opencode/types.ts";
import { createTurnRunner } from "./turn-runner.ts";

test("turn runner starts turns, stores message IDs, and finishes final events", async () => {
  const harness = await createHarness({ events: [{ type: "final", text: "done" }] });

  try {
    const result = await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 1);

    expect(result.status).toBe("started");
    expect(harness.runtime.calls.startTurn).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        text: "inspect",
        agent: "cto-agent",
        model: "provider/model",
        mode: "sync",
        observePermissions: false,
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

test("turn runner marks startTurn failures as run errors", async () => {
  const harness = await createHarness({ startTurnError: new Error("OpenCode unavailable") });

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

test("turn runner times out startTurn hangs and releases the binding", async () => {
  const harness = await createHarness({ neverResolveStartTurn: true, startTimeoutMs: 1 });

  try {
    const result = await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });

    expect(result).toMatchObject({
      status: "error",
      error: "OpenCode did not accept the turn within 1ms.",
    });
    expect(runRows(harness.database)).toEqual([
      {
        id: "run-1",
        status: "error",
        opencode_message_id: null,
        error: "OpenCode did not accept the turn within 1ms.",
      },
    ]);

    harness.runtime.setNeverResolveStartTurn(false);
    harness.runtime.setEvents([{ type: "final", text: "second done" }]);

    const second = await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 1);

    expect(second.status).toBe("started");
    expect(harness.deliveries).toEqual([{ kind: "final", format: "markdown", text: "second done" }]);
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

test("turn runner aborts the active turn and cancels observation", async () => {
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

test("turn runner exposes active turn plan diagnostics", async () => {
  const harness = await createHarness({ waitForAbort: true, observePermissions: true });

  try {
    await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForObserve(harness.runtime);

    expect(harness.runner.getActiveDiagnostics(harness.resolution.binding.id)).toEqual({
      runId: "run-1",
      bindingId: harness.resolution.binding.id,
      startedAt: "2026-01-01T00:00:00.000Z",
      ageMs: 0,
      plan: {
        finalSource: "prompt",
        progressSource: "none",
        permissionSource: "events",
      },
    });
  } finally {
    await harness.runner.abortActive({ binding: harness.resolution.binding, target: harness.resolution.target });
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner times out turns without a final response", async () => {
  const harness = await createHarness({ waitForAbort: true, runTimeoutMs: 1 });

  try {
    await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 1);

    expect(harness.deliveries).toEqual([
      {
        kind: "error",
        format: "plain",
        text: "OpenCode error: OpenCode did not produce a final response within 1ms.",
      },
    ]);
    expect(runRows(harness.database)).toEqual([
      {
        id: "run-1",
        status: "error",
        opencode_message_id: "message-1",
        error: "OpenCode did not produce a final response within 1ms.",
      },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner releases the binding after a timeout so later turns can start", async () => {
  const harness = await createHarness({ neverResolveObserve: true, runTimeoutMs: 1 });

  try {
    await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 1);

    harness.runtime.setNeverResolveObserve(false);
    harness.runtime.setEvents([{ type: "final", text: "second done" }]);

    const second = await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 2);

    expect(second.status).toBe("started");
    expect(harness.deliveries).toEqual([
      {
        kind: "error",
        format: "plain",
        text: "OpenCode error: OpenCode did not produce a final response within 1ms.",
      },
      { kind: "final", format: "markdown", text: "second done" },
    ]);
    expect(runRows(harness.database)).toEqual([
      {
        id: "run-1",
        status: "error",
        opencode_message_id: "message-1",
        error: "OpenCode did not produce a final response within 1ms.",
      },
      { id: "run-2", status: "completed", opencode_message_id: "message-1", error: null },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner queues follow-up messages and drains after the active turn completes", async () => {
  const harness = await createHarness({
    eventBatches: [
      [{ type: "status", status: "running" }, { type: "final", text: "first done" }],
      [{ type: "final", text: "second done" }],
    ],
    eventDelayMs: 5,
  });

  try {
    const first = await harness.runner.start({
      message: inboundMessage({ id: "message-1", text: "first" }),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    const second = await harness.runner.start({
      message: inboundMessage({ id: "message-2", text: "second" }),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });

    expect(first.status).toBe("started");
    expect(second).toMatchObject({ status: "queued", queueSize: 1 });
    expect(harness.runner.getQueueDiagnostics(harness.resolution.binding.id)).toEqual({
      bindingId: harness.resolution.binding.id,
      size: 1,
      oldestEnqueuedAt: "2026-01-01T00:00:00.000Z",
      oldestAgeMs: 0,
    });

    await waitForDeliveries(harness.deliveries, 2);

    expect(harness.runtime.calls.startTurn.map((call) => call.text)).toEqual(["first", "second"]);
    expect(harness.deliveries).toEqual([
      { kind: "final", format: "markdown", text: "first done" },
      { kind: "final", format: "markdown", text: "second done" },
    ]);
    expect(harness.runner.getQueueDiagnostics(harness.resolution.binding.id)).toBeUndefined();
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner queues permission-producing follow-ups", async () => {
  const harness = await createHarness({
    eventBatches: [
      [{ type: "status", status: "running" }, { type: "final", text: "chat done" }],
      [
        { type: "permission_request", id: "opencode-permission-1", summary: "Run bash", details: { action: "bash", resources: ["printf queued"] } },
        { type: "final", text: "permission done" },
      ],
    ],
    eventDelayMs: 5,
    observePermissions: true,
    sendPermissionRequests: true,
  });

  try {
    await harness.runner.start({
      message: inboundMessage({ id: "message-1", text: "Whattup?" }),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    const queued = await harness.runner.start({
      message: inboundMessage({ id: "message-2", text: "Use bash to run: printf queued" }),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 3);

    expect(queued.status).toBe("queued");
    expect(harness.runtime.calls.startTurn.map((call) => call.text)).toEqual([
      "Whattup?",
      "Use bash to run: printf queued",
    ]);
    expect(harness.deliveries).toEqual([
      { kind: "final", format: "markdown", text: "chat done" },
      { kind: "status", format: "plain", text: "Permission card: permission-1" },
      { kind: "final", format: "markdown", text: "permission done" },
    ]);
    expect(pendingPermissionRows(harness.database)).toEqual([
      expect.objectContaining({ id: "permission-1", opencode_permission_id: "opencode-permission-1", status: "expired" }),
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner releases local active runs when remote abort fails", async () => {
  const harness = await createHarness({ waitForAbort: true, abortError: new Error("abort unavailable") });

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

    expect(result).toMatchObject({ status: "aborted", remoteAbortError: "abort unavailable" });
    expect(runRows(harness.database)).toEqual([
      { id: "run-1", status: "aborted", opencode_message_id: "message-1", error: "abort unavailable" },
    ]);
    expect(harness.runner.getActiveDiagnostics(harness.resolution.binding.id)).toBeUndefined();
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner timeout completes even if observe never resolves", async () => {
  const harness = await createHarness({ neverResolveObserve: true, runTimeoutMs: 1 });

  try {
    await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 1);

    expect(harness.deliveries).toEqual([
      {
        kind: "error",
        format: "plain",
        text: "OpenCode error: OpenCode did not produce a final response within 1ms.",
      },
    ]);
    expect(runRows(harness.database)).toEqual([
      {
        id: "run-1",
        status: "error",
        opencode_message_id: "message-1",
        error: "OpenCode did not produce a final response within 1ms.",
      },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner sends no progress for compact final-answer-only turns", async () => {
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
    await waitForDeliveries(harness.deliveries, 1);

    expect(harness.deliveries).toEqual([
      { kind: "final", format: "markdown", text: "done" },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner keeps channel typing active during compact turns", async () => {
  const harness = await createHarness({ events: [{ type: "final", text: "done" }], eventDelayMs: 5 });

  try {
    await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForTyping(harness.typing, 1);
    await waitForDeliveries(harness.deliveries, 1);
    await waitForTyping(harness.typing, 2);

    expect(harness.typing).toEqual(["typing", "idle"]);
    expect(harness.deliveries).toEqual([{ kind: "final", format: "markdown", text: "done" }]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner persists delivery receipts for progress and final messages", async () => {
  const harness = await createHarness({
    events: [{ type: "status", status: "running" }, { type: "final", text: "done" }],
    eventDelayMs: 5,
    progressDelayMs: 1,
    verbosity: "verbose",
  });

  try {
    await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 2);

    expect(deliveryReceiptRows(harness.database)).toEqual([
      { id: "receipt-1", run_id: "run-1", platform_message_id: "sent-1", kind: "progress" },
      { id: "receipt-2", run_id: "run-1", platform_message_id: "sent-2", kind: "final" },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner expires unresolved permission requests when the run finishes", async () => {
  const harness = await createHarness({
    events: [
      { type: "permission_request", id: "opencode-permission-1", summary: "Run bash", details: { tool: "bash" } },
      { type: "final", text: "done" },
    ],
    permissionTtlMs: 60_000,
  });

  try {
    await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 1);

    expect(pendingPermissionRows(harness.database)).toEqual([
      {
        id: "permission-1",
        run_id: "run-1",
        opencode_permission_id: "opencode-permission-1",
        summary: "Run bash",
        details_json: JSON.stringify({ tool: "bash" }),
        status: "expired",
        expires_at: "2026-01-01T00:01:00.000Z",
      },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner observes permissions for compact profiles without progress messages", async () => {
  const harness = await createHarness({
    events: [
      { type: "permission_request", id: "opencode-permission-1", summary: "Run bash", details: { tool: "bash" } },
      { type: "final", text: "done" },
    ],
    observePermissions: true,
    sendPermissionRequests: true,
    progressDelayMs: 1,
  });

  try {
    await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 2);

    expect(harness.runtime.calls.startTurn[0]).toEqual(expect.objectContaining({ mode: "sync", observePermissions: true }));
    expect(harness.deliveries).toEqual([
      { kind: "status", format: "plain", text: "Permission card: permission-1" },
      { kind: "final", format: "markdown", text: "done" },
    ]);
    expect(pendingPermissionRows(harness.database)).toEqual([
      expect.objectContaining({ id: "permission-1", opencode_permission_id: "opencode-permission-1", status: "expired" }),
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner resurfaces an already-pending OpenCode permission instead of dropping the card", async () => {
  const harness = await createHarness({
    events: [
      { type: "permission_request", id: "opencode-permission-1", summary: "Run bash", details: { action: "bash", resources: ["printf hello"] } },
      { type: "final", text: "done" },
    ],
    observePermissions: true,
    sendPermissionRequests: true,
  });

  try {
    insertExistingPendingPermission(harness.database, harness.resolution.binding.id);

    await harness.runner.start({
      message: inboundMessage(),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 2);

    expect(harness.deliveries).toEqual([
      { kind: "status", format: "plain", text: "Permission card: permission-existing" },
      { kind: "final", format: "markdown", text: "done" },
    ]);
    expect(pendingPermissionRows(harness.database)).toEqual([
      expect.objectContaining({ id: "permission-existing", opencode_permission_id: "opencode-permission-1", status: "expired" }),
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner does not resurrect expired OpenCode permissions when they are reported again", async () => {
  const permissionEvent: RuntimeEvent = {
    type: "permission_request",
    id: "opencode-permission-1",
    summary: "Run bash",
    details: { action: "bash", resources: ["printf stale"] },
  };
  const harness = await createHarness({
    eventBatches: [
      [permissionEvent, { type: "final", text: "first done" }],
      [permissionEvent, { type: "final", text: "second done" }],
    ],
    observePermissions: true,
    sendPermissionRequests: true,
  });

  try {
    await harness.runner.start({
      message: inboundMessage({ id: "message-1", text: "first" }),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 2);

    await harness.runner.start({
      message: inboundMessage({ id: "message-2", text: "second" }),
      resolution: harness.resolution,
      delivery: harness.delivery,
    });
    await waitForDeliveries(harness.deliveries, 3);

    expect(harness.deliveries).toEqual([
      { kind: "status", format: "plain", text: "Permission card: permission-1" },
      { kind: "final", format: "markdown", text: "first done" },
      { kind: "final", format: "markdown", text: "second done" },
    ]);
    expect(pendingPermissionRows(harness.database)).toEqual([
      expect.objectContaining({ id: "permission-1", opencode_permission_id: "opencode-permission-1", status: "expired" }),
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

    expect(harness.runtime.calls.startTurn[0]).toEqual(expect.objectContaining({
      mode: "async",
      observeProgress: true,
    }));
    expect(harness.deliveries).toEqual([
      {
        kind: "progress",
        format: "plain",
        text: "Tool bash started: Run tests",
      },
      { kind: "progress", format: "plain", text: "Tool bash completed: Passed" },
      { kind: "final", format: "markdown", text: "done" },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

test("turn runner renders subagent updates and todos for tools verbosity", async () => {
  const harness = await createHarness({
    events: [
      { type: "tool_start", id: "task-1", name: "general", category: "subagent", summary: "Inspect bug" },
      { type: "tool_update", id: "grep-1", name: "grep", category: "subagent", summary: "Search runtime events" },
      {
        type: "todo_update",
        source: "subagent",
        todos: [
          { content: "Search runtime events", status: "in_progress", priority: "high" },
          { content: "Summarize findings", status: "pending", priority: "medium" },
        ],
      },
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
    await waitForDeliveries(harness.deliveries, 4);

    expect(harness.runtime.calls.startTurn[0]).toEqual(expect.objectContaining({
      mode: "async",
      observeProgress: true,
    }));
    expect(harness.deliveries).toEqual([
      { kind: "progress", format: "plain", text: "Subagent general started: Inspect bug" },
      { kind: "progress", format: "plain", text: "Subagent grep updated: Search runtime events" },
      {
        kind: "progress",
        format: "plain",
        text: [
          "Subagent todos:",
          "[~] Search runtime events (high)",
          "[ ] Summarize findings (medium)",
        ].join("\n"),
      },
      { kind: "final", format: "markdown", text: "done" },
    ]);
  } finally {
    await harness.runner.stop();
    harness.database.close();
  }
});

interface HarnessOptions {
  events?: RuntimeEvent[];
  eventBatches?: RuntimeEvent[][];
  startTurnError?: Error;
  neverResolveStartTurn?: boolean;
  abortError?: Error;
  waitForAbort?: boolean;
  neverResolveObserve?: boolean;
  eventDelayMs?: number;
  progressDelayMs?: number;
  runTimeoutMs?: number;
  startTimeoutMs?: number;
  permissionTtlMs?: number;
  verbosity?: "off" | "compact" | "tools" | "verbose";
  observePermissions?: boolean;
  sendPermissionRequests?: boolean;
}

interface Harness {
  database: GatewayDatabase;
  runtime: FakeRuntime;
  resolution: ResolvedDispatch;
  deliveries: OutboundMessage[];
  typing: TypingState[];
  delivery: {
    send(message: OutboundMessage): Promise<SendReceipt>;
    setTyping(state: TypingState): Promise<void>;
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
  let runId = 0;
  const runs = createRunRepository(database.db, {
    now: fixedNow,
    createId: () => `run-${(runId += 1)}`,
  });
  let deliveryReceiptId = 0;
  const deliveryReceipts = createDeliveryReceiptRepository(database.db, {
    now: fixedNow,
    createId: () => `receipt-${(deliveryReceiptId += 1)}`,
  });
  let pendingPermissionId = 0;
  const pendingPermissions = createPendingPermissionRepository(database.db, {
    now: fixedNow,
    createId: () => `permission-${(pendingPermissionId += 1)}`,
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
  const typing: TypingState[] = [];
  const runner = createTurnRunner({
    runtime,
    runs,
    pendingPermissions,
    deliveryReceipts,
    progressDelayMs: options.progressDelayMs,
    runTimeoutMs: options.runTimeoutMs,
    startTimeoutMs: options.startTimeoutMs,
    permissionTtlMs: options.permissionTtlMs,
    observePermissions: options.observePermissions,
    onPermissionRequest: options.sendPermissionRequests
      ? async (input) => {
          await input.delivery.send({ kind: "status", format: "plain", text: `Permission card: ${input.permission.id}` });
        }
      : undefined,
    now: fixedNow,
  });

  return {
    database,
    runtime,
    resolution: resolved(binding, profile, target),
    deliveries,
    typing,
    delivery: {
      async send(message) {
        deliveries.push(message);
        return receiptFor(`sent-${deliveries.length}`);
      },
      async setTyping(state) {
        typing.push(state);
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

function inboundMessage(options: { id?: string; text?: string } = {}): InboundMessage {
  return {
    id: options.id ?? "message-1",
    channel: "telegram",
    accountId: "default",
    conversation: { key: conversationKey, type: "dm", id: "123" },
    sender: { id: "123", username: "tiago" },
    timestamp: "2026-01-01T00:00:00.000Z",
    text: options.text ?? "inspect",
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

async function waitForTyping(typing: TypingState[], count: number): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (typing.length < count && Date.now() < deadline) {
    await Bun.sleep(5);
  }

  expect(typing.length).toBeGreaterThanOrEqual(count);
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

function deliveryReceiptRows(database: GatewayDatabase): Array<{
  id: string;
  run_id: string | null;
  platform_message_id: string;
  kind: string;
}> {
  return database.db
    .query("SELECT id, run_id, platform_message_id, kind FROM delivery_receipts ORDER BY id")
    .all() as Array<{ id: string; run_id: string | null; platform_message_id: string; kind: string }>;
}

function pendingPermissionRows(database: GatewayDatabase): Array<{
  id: string;
  run_id: string;
  opencode_permission_id: string;
  summary: string;
  details_json: string | null;
  status: string;
  expires_at: string;
}> {
  return database.db
    .query(
      `SELECT id, run_id, opencode_permission_id, summary, details_json, status, expires_at
      FROM pending_permissions ORDER BY id`,
    )
    .all() as Array<{
      id: string;
      run_id: string;
      opencode_permission_id: string;
      summary: string;
      details_json: string | null;
      status: string;
      expires_at: string;
    }>; 
}

function insertExistingPendingPermission(database: GatewayDatabase, bindingId: string): void {
  database.db
    .query(
      `INSERT INTO runs (id, binding_id, opencode_session_id, opencode_message_id, status, started_at, finished_at, error)
       VALUES ('run-existing', ?, 'session-1', 'message-existing', 'aborted', '2025-12-31T23:59:00.000Z', '2025-12-31T23:59:30.000Z', NULL)`,
    )
    .run(bindingId);

  database.db
    .query(
      `INSERT INTO pending_permissions (
        id, run_id, opencode_permission_id, summary, details_json, action_message_receipt_id,
        status, created_at, expires_at, resolved_at
      ) VALUES (
        'permission-existing', 'run-existing', 'opencode-permission-1', 'Run bash',
        '{"action":"bash","resources":["printf hello"]}', NULL,
        'pending', '2025-12-31T23:59:01.000Z', '2026-01-01T00:15:00.000Z', NULL
      )`,
    )
    .run();
}

function requireRecord<T>(record: T | undefined, label: string): T {
  if (!record) throw new Error(`missing ${label}`);
  return record;
}

const conversationKey = "telegram:default:dm:123";

class FakeRuntime implements AgentRuntime {
  readonly calls: {
    startTurn: StartRuntimeTurnInput[];
    observe: ObserveRuntimeTurnInput[];
    abort: AbortRuntimeTurnInput[];
  } = {
    startTurn: [],
    observe: [],
    abort: [],
  };

  private events: RuntimeEvent[];
  private readonly eventBatches: RuntimeEvent[][] | undefined;
  private readonly startTurnError: Error | undefined;
  private neverResolveStartTurn: boolean;
  private readonly abortError: Error | undefined;
  private readonly waitForAbort: boolean;
  private neverResolveObserve: boolean;
  private readonly eventDelayMs: number;

  constructor(options: HarnessOptions) {
    this.events = options.events ?? [];
    this.eventBatches = options.eventBatches;
    this.startTurnError = options.startTurnError;
    this.neverResolveStartTurn = options.neverResolveStartTurn ?? false;
    this.abortError = options.abortError;
    this.waitForAbort = options.waitForAbort ?? false;
    this.neverResolveObserve = options.neverResolveObserve ?? false;
    this.eventDelayMs = options.eventDelayMs ?? 0;
  }

  async ensureSession(input: EnsureSessionInput): Promise<RuntimeSession> {
    return { id: input.sessionId ?? "session-1", targetId: input.target.id };
  }

  async send(input: SendRuntimeMessageInput): Promise<RuntimeTurn> {
    return { id: "message-sync", sessionId: input.sessionId, status: "completed", text: input.text };
  }

  async sendAsync(input: SendRuntimeMessageInput): Promise<RuntimeTurnHandle> {
    return {
      id: "message-1",
      sessionId: input.sessionId,
      targetId: input.target.id,
      status: "running",
    };
  }

  async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    this.calls.startTurn.push(input);

    if (this.startTurnError) throw this.startTurnError;
    if (this.neverResolveStartTurn) await new Promise<never>(() => undefined);

    const handle = {
      id: "message-1",
      sessionId: input.sessionId,
      targetId: input.target.id,
      status: "running" as const,
    };

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

  async *observe(input: ObserveRuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    this.calls.observe.push(input);

    if (this.waitForAbort) {
      await new Promise<void>((resolve) => {
        input.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      return;
    }

    if (this.neverResolveObserve) {
      await new Promise<void>(() => undefined);
      return;
    }

    const events = this.eventBatches?.[this.calls.observe.length - 1] ?? this.events;

    for (const [index, event] of events.entries()) {
      if (input.signal?.aborted) return;
      yield event;

      if (this.eventDelayMs > 0 && index < events.length - 1) {
        await Bun.sleep(this.eventDelayMs);
      }
    }
  }

  async abort(input: AbortRuntimeTurnInput): Promise<void> {
    this.calls.abort.push(input);
    if (this.abortError) throw this.abortError;
  }

  setEvents(events: RuntimeEvent[]): void {
    this.events = events;
  }

  setNeverResolveObserve(neverResolveObserve: boolean): void {
    this.neverResolveObserve = neverResolveObserve;
  }

  setNeverResolveStartTurn(neverResolveStartTurn: boolean): void {
    this.neverResolveStartTurn = neverResolveStartTurn;
  }

  async respondToPermission(input: PermissionResponseInput): Promise<void> {
    throw new Error(`unexpected permission response ${input.permissionId}`);
  }

  async listSessions(input: ListRuntimeSessionsInput): Promise<RuntimeSession[]> {
    return [{ id: input.target.id, targetId: input.target.id }];
  }

  async listAgents(_input: ListRuntimeAgentsInput): Promise<RuntimeAgent[]> {
    return [];
  }

  async listModels(_input: ListRuntimeModelsInput): Promise<RuntimeModel[]> {
    return [];
  }
}
