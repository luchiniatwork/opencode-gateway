import { expect, test } from "bun:test";

import type { ChannelAction, InboundMessage, SendReceipt } from "../channels/types.ts";
import { openGatewayDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrations.ts";
import { createAccessRuleRepository } from "../db/repositories/access-rules.ts";
import { createConversationBindingRepository } from "../db/repositories/conversation-bindings.ts";
import { createPendingPermissionRepository } from "../db/repositories/pending-permissions.ts";
import { createRunRepository } from "../db/repositories/runs.ts";
import { seedDatabaseFromConfig } from "../db/repositories/seeds.ts";
import { createTargetRepository } from "../db/repositories/targets.ts";
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
import { createPermissionInteractionService } from "./permissions.ts";

test("permission approval uses the run target even if the binding moved", async () => {
  const database = await openGatewayDatabase(":memory:");

  try {
    runMigrations(database.db, fixedNow);
    seedDatabaseFromConfig(
      database.db,
      {
        targets: [targetSeed("default"), targetSeed("other")],
        profiles: [profileSeed()],
        accessRules: [{ channel: "telegram", accountId: "default", senderId: "123", role: "owner" }],
      },
      fixedNow,
    );

    const repositories = {
      accessRules: createAccessRuleRepository(database.db, { now: fixedNow }),
      bindings: createConversationBindingRepository(database.db, { now: fixedNow, createId: () => "binding-1" }),
      pendingPermissions: createPendingPermissionRepository(database.db, { now: fixedNow, createId: () => "permission-1" }),
      runs: createRunRepository(database.db, { now: fixedNow, createId: () => "run-1" }),
      targets: createTargetRepository(database.db, fixedNow),
    };
    const binding = repositories.bindings.upsert({
      conversationKey,
      channel: "telegram",
      accountId: "default",
      profileId: "cto",
      targetId: "default",
      opencodeSessionId: "session-1",
      busyMode: "queue",
      verbosity: "compact",
    });
    const run = repositories.runs.create({
      bindingId: binding.id,
      targetId: "default",
      opencodeSessionId: "session-1",
      opencodeMessageId: "message-1",
    });
    const permission = repositories.pendingPermissions.create({
      runId: run.id,
      opencodePermissionId: "opencode-permission-1",
      summary: "Run bash",
      expiresAt: "2026-01-01T00:15:00.000Z",
    });
    repositories.bindings.updateSession({
      conversationKey,
      targetId: "other",
      opencodeSessionId: "session-2",
    });

    const runtime = new RecordingRuntime();
    const service = createPermissionInteractionService({
      config: { mode: "buttons", fallbackCommands: true, allowAlways: false },
      repositories,
      runtime,
      now: fixedNow,
    });

    const response = await service.handleFallbackCommand(inboundMessage(), "approve", permission.id);

    expect(response.text).toContain("approved once by Tiago");
    expect(runtime.permissionResponses).toEqual([
      expect.objectContaining({
        target: expect.objectContaining({ id: "default" }),
        sessionId: "session-1",
        permissionId: "opencode-permission-1",
        decision: "approve",
      }),
    ]);
  } finally {
    database.close();
  }
});

test("permission fallback commands can be disabled", async () => {
  const harness = await createPermissionHarness({ fallbackCommands: false });

  try {
    const response = await harness.service.handleFallbackCommand(inboundMessage(), "approve", harness.permission.id);

    expect(response).toEqual({
      kind: "status",
      format: "markdown",
      text: "Permission fallback commands are disabled by configuration.",
    });
    expect(harness.runtime.permissionResponses).toEqual([]);
    expect(harness.repositories.pendingPermissions.getById(harness.permission.id)?.status).toBe("pending");
  } finally {
    harness.database.close();
  }
});

test("permission fallback commands validate missing and unknown permission IDs", async () => {
  const harness = await createPermissionHarness();

  try {
    const missingId = await harness.service.handleFallbackCommand(inboundMessage(), "approve", undefined);
    const notFound = await harness.service.handleFallbackCommand(inboundMessage(), "deny", "permission-missing");

    expect(missingId).toEqual({
      kind: "status",
      format: "markdown",
      text: "Usage: `/permission approve <id>`, `/permission deny <id>`, or `/permission always <id>`",
    });
    expect(notFound).toEqual({
      kind: "error",
      format: "plain",
      text: "Permission request not found: permission-missing",
    });
    expect(harness.runtime.permissionResponses).toEqual([]);
    expect(harness.repositories.pendingPermissions.getById(harness.permission.id)?.status).toBe("pending");
  } finally {
    harness.database.close();
  }
});

test("permission response runtime failures leave permissions pending", async () => {
  const harness = await createPermissionHarness();
  harness.runtime.respondError = new Error("permission endpoint unavailable");

  try {
    const response = await harness.service.handleFallbackCommand(inboundMessage(), "approve", harness.permission.id);

    expect(response).toEqual({
      kind: "error",
      format: "plain",
      text: `Unable to respond to permission ${harness.permission.id}: permission endpoint unavailable`,
    });
    expect(harness.repositories.pendingPermissions.getById(harness.permission.id)?.status).toBe("pending");
  } finally {
    harness.database.close();
  }
});

test("permission action resolution falls back to sending when editing fails", async () => {
  const harness = await createPermissionHarness();
  const delivery = recordingDelivery({ failEdit: true });

  try {
    const handled = await harness.service.handleAction(permissionAction(harness.permission.id), delivery);

    expect(handled).toBe(true);
    expect(delivery.edits).toHaveLength(1);
    expect(delivery.sent).toEqual([
      {
        kind: "status",
        format: "markdown",
        text: `Permission ${harness.permission.id} approved once by Tiago.`,
      },
    ]);
    expect(harness.repositories.pendingPermissions.getById(harness.permission.id)?.status).toBe("approved");
    expect(harness.runtime.permissionResponses).toEqual([
      expect.objectContaining({ permissionId: "opencode-permission-1", decision: "approve" }),
    ]);
  } finally {
    harness.database.close();
  }
});

interface PermissionHarness {
  database: Awaited<ReturnType<typeof openGatewayDatabase>>;
  repositories: ReturnType<typeof createPermissionRepositories>;
  runtime: RecordingRuntime;
  service: ReturnType<typeof createPermissionInteractionService>;
  permission: ReturnType<ReturnType<typeof createPendingPermissionRepository>["create"]>;
}

async function createPermissionHarness(
  options: { fallbackCommands?: boolean } = {},
): Promise<PermissionHarness> {
  const database = await openGatewayDatabase(":memory:");
  runMigrations(database.db, fixedNow);
  seedDatabaseFromConfig(
    database.db,
    {
      targets: [targetSeed("default")],
      profiles: [profileSeed()],
      accessRules: [{ channel: "telegram", accountId: "default", senderId: "123", role: "owner" }],
    },
    fixedNow,
  );

  const repositories = createPermissionRepositories(database);
  const binding = repositories.bindings.upsert({
    conversationKey,
    channel: "telegram",
    accountId: "default",
    profileId: "cto",
    targetId: "default",
    opencodeSessionId: "session-1",
    busyMode: "queue",
    verbosity: "compact",
  });
  const run = repositories.runs.create({
    bindingId: binding.id,
    targetId: "default",
    opencodeSessionId: "session-1",
    opencodeMessageId: "message-1",
  });
  const permission = repositories.pendingPermissions.create({
    runId: run.id,
    opencodePermissionId: "opencode-permission-1",
    summary: "Run bash",
    expiresAt: "2026-01-01T00:15:00.000Z",
  });
  const runtime = new RecordingRuntime();
  const service = createPermissionInteractionService({
    config: { mode: "buttons", fallbackCommands: options.fallbackCommands ?? true, allowAlways: false },
    repositories,
    runtime,
    now: fixedNow,
  });

  return { database, repositories, runtime, service, permission };
}

function createPermissionRepositories(database: Awaited<ReturnType<typeof openGatewayDatabase>>) {
  return {
    accessRules: createAccessRuleRepository(database.db, { now: fixedNow }),
    bindings: createConversationBindingRepository(database.db, { now: fixedNow, createId: () => "binding-1" }),
    pendingPermissions: createPendingPermissionRepository(database.db, { now: fixedNow, createId: () => "permission-1" }),
    runs: createRunRepository(database.db, { now: fixedNow, createId: () => "run-1" }),
    targets: createTargetRepository(database.db, fixedNow),
  };
}

function permissionAction(permissionId: string): ChannelAction {
  return {
    id: "callback-1",
    channel: "telegram",
    accountId: "default",
    conversation: { key: conversationKey, type: "dm", id: "123" },
    sender: { id: "123", username: "tiago", displayName: "Tiago" },
    message: { id: "sent-1", timestamp: "2026-01-01T00:00:00.000Z" },
    actionId: "permission.approve",
    value: permissionId,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function recordingDelivery(options: { failEdit?: boolean } = {}): {
  sent: OutboundMessage[];
  edits: Array<{ receipt: SendReceipt; message: OutboundMessage }>;
  send(message: OutboundMessage): Promise<SendReceipt>;
  edit(receipt: SendReceipt, message: OutboundMessage): Promise<SendReceipt>;
} {
  const sent: OutboundMessage[] = [];
  const edits: Array<{ receipt: SendReceipt; message: OutboundMessage }> = [];

  return {
    sent,
    edits,
    async send(message) {
      sent.push(message);
      return receipt("sent-fallback");
    },
    async edit(editReceipt, message) {
      edits.push({ receipt: editReceipt, message });
      if (options.failEdit) throw new Error("edit failed");
      return editReceipt;
    },
  };
}

function receipt(platformMessageId: string): SendReceipt {
  return {
    channel: "telegram",
    accountId: "default",
    conversationKey,
    platformMessageId,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function targetSeed(id: string) {
  return {
    id,
    name: `${id} target`,
    mode: "attach" as const,
    serverUrl: `http://127.0.0.1/${id}`,
  };
}

function profileSeed() {
  return {
    id: "cto",
    displayName: "CTO",
    defaultTargetId: "default",
    defaults: { busyMode: "queue" as const, verbosity: "compact" as const },
  };
}

function inboundMessage(): InboundMessage {
  return {
    id: "message-1",
    channel: "telegram",
    accountId: "default",
    conversation: { key: conversationKey, type: "dm", id: "123" },
    sender: { id: "123", username: "tiago", displayName: "Tiago" },
    timestamp: "2026-01-01T00:00:00.000Z",
    text: "/permission approve permission-1",
    commandText: "/permission approve permission-1",
    attachments: [],
  };
}

function fixedNow(): Date {
  return new Date("2026-01-01T00:00:00.000Z");
}

const conversationKey = "telegram:default:dm:123";

class RecordingRuntime implements AgentRuntime {
  readonly permissionResponses: PermissionResponseInput[] = [];
  respondError: Error | undefined;

  async ensureSession(input: EnsureSessionInput): Promise<RuntimeSession> {
    return { id: input.sessionId ?? "session-1", targetId: input.target.id };
  }

  async send(input: SendRuntimeMessageInput): Promise<RuntimeTurn> {
    return { sessionId: input.sessionId, status: "completed", text: input.text };
  }

  async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    return {
      handle: { id: "message-1", sessionId: input.sessionId, targetId: input.target.id, status: "running" },
      events: emptyEvents(),
    };
  }

  async sendAsync(input: SendRuntimeMessageInput): Promise<RuntimeTurnHandle> {
    return { id: "message-1", sessionId: input.sessionId, targetId: input.target.id, status: "running" };
  }

  async *observe(_input: ObserveRuntimeTurnInput): AsyncIterable<RuntimeEvent> {}

  async abort(_input: AbortRuntimeTurnInput): Promise<void> {}

  async respondToPermission(input: PermissionResponseInput): Promise<void> {
    if (this.respondError) throw this.respondError;
    this.permissionResponses.push(input);
  }

  async listSessions(input: ListRuntimeSessionsInput): Promise<RuntimeSession[]> {
    return [{ id: "session-1", targetId: input.target.id }];
  }

  async listAgents(_input: ListRuntimeAgentsInput): Promise<RuntimeAgent[]> {
    return [];
  }

  async listModels(_input: ListRuntimeModelsInput): Promise<RuntimeModel[]> {
    return [];
  }
}

async function* emptyEvents(): AsyncIterable<RuntimeEvent> {}
