import { expect, test } from "bun:test";

import type { InboundMessage } from "../channels/types.ts";
import { openGatewayDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrations.ts";
import { createAccessRuleRepository } from "../db/repositories/access-rules.ts";
import { createConversationBindingRepository } from "../db/repositories/conversation-bindings.ts";
import { createPendingPermissionRepository } from "../db/repositories/pending-permissions.ts";
import { createRunRepository } from "../db/repositories/runs.ts";
import { seedDatabaseFromConfig } from "../db/repositories/seeds.ts";
import { createTargetRepository } from "../db/repositories/targets.ts";
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
    this.permissionResponses.push(input);
  }

  async listSessions(input: ListRuntimeSessionsInput): Promise<RuntimeSession[]> {
    return [{ id: "session-1", targetId: input.target.id }];
  }
}

async function* emptyEvents(): AsyncIterable<RuntimeEvent> {}
