import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../app.ts";
import type { ConfigSeeds, GatewayConfig } from "../config/schema.ts";
import { openGatewayDatabase, type GatewayDatabase } from "./client.ts";
import { runMigrations } from "./migrations.ts";
import { createAccessRuleRepository } from "./repositories/access-rules.ts";
import { createConversationBindingRepository } from "./repositories/conversation-bindings.ts";
import { createDeliveryReceiptRepository } from "./repositories/delivery-receipts.ts";
import { createPendingPermissionRepository } from "./repositories/pending-permissions.ts";
import { createProfileRepository } from "./repositories/profiles.ts";
import { createRunRepository } from "./repositories/runs.ts";
import { seedDatabaseFromConfig } from "./repositories/seeds.ts";
import { createTargetRepository } from "./repositories/targets.ts";

test("migrations create the phase 2 database tables", async () => {
  const database = await openTestDatabase();

  try {
    runMigrations(database.db, fixedNow);

    const rows = database.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = rows.map((row) => row.name);

    expect(tableNames).toContain("access_rules");
    expect(tableNames).toContain("conversation_bindings");
    expect(tableNames).toContain("delivery_receipts");
    expect(tableNames).toContain("pending_permissions");
    expect(tableNames).toContain("profiles");
    expect(tableNames).toContain("runs");
    expect(tableNames).toContain("schema_migrations");
    expect(tableNames).toContain("targets");
  } finally {
    database.close();
  }
});

test("migrations are idempotent", async () => {
  const database = await openTestDatabase();

  try {
    runMigrations(database.db, fixedNow);
    runMigrations(database.db, fixedNow);

    const row = database.db.query("SELECT COUNT(*) AS count FROM schema_migrations").get() as {
      count: number;
    };

    expect(row.count).toBe(3);
  } finally {
    database.close();
  }
});

test("pending permissions can be created, queried, listed, and resolved", async () => {
  const database = await openSeededDatabase();

  try {
    const run = createTestRun(database);
    const permissions = createPendingPermissionRepository(database.db, {
      now: fixedNow,
      createId: () => "permission-1",
    });

    const pending = permissions.create({
      runId: run.id,
      opencodePermissionId: "opencode-permission-1",
      summary: "Run bash command",
      details: { command: "bun test" },
      expiresAt: "2026-01-01T00:15:00.000Z",
    });

    expect(pending).toMatchObject({
      id: "permission-1",
      runId: run.id,
      opencodePermissionId: "opencode-permission-1",
      summary: "Run bash command",
      details: { command: "bun test" },
      status: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:15:00.000Z",
    });
    expect(permissions.getById("permission-1")?.summary).toBe("Run bash command");
    expect(permissions.getByOpenCodePermissionId("opencode-permission-1")?.id).toBe("permission-1");
    expect(permissions.listPendingByRunId(run.id).map((permission) => permission.id)).toEqual(["permission-1"]);

    const resolved = permissions.resolve({ id: "permission-1", status: "approved", actionMessageReceiptId: "receipt-1" });

    expect(resolved?.status).toBe("approved");
    expect(resolved?.resolvedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(resolved?.actionMessageReceiptId).toBe("receipt-1");
    expect(permissions.listPendingByRunId(run.id)).toEqual([]);
  } finally {
    database.close();
  }
});

test("delivery receipts can be created and listed by run or conversation", async () => {
  const database = await openSeededDatabase();

  try {
    const run = createTestRun(database);
    const receipts = createDeliveryReceiptRepository(database.db, {
      now: fixedNow,
      createId: () => "receipt-1",
    });

    const receipt = receipts.create({
      runId: run.id,
      channel: "telegram",
      accountId: "default",
      conversationKey: "telegram:default:dm:123",
      platformMessageId: "platform-message-1",
      kind: "final",
    });

    expect(receipt).toMatchObject({
      id: "receipt-1",
      runId: run.id,
      channel: "telegram",
      accountId: "default",
      conversationKey: "telegram:default:dm:123",
      platformMessageId: "platform-message-1",
      kind: "final",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(receipts.listByRunId(run.id).map((entry) => entry.id)).toEqual(["receipt-1"]);
    expect(receipts.listByConversationKey("telegram:default:dm:123").map((entry) => entry.id)).toEqual(["receipt-1"]);
  } finally {
    database.close();
  }
});

test("config seeds insert and update targets, profiles, and access rules", async () => {
  const database = await openMigratedDatabase();

  try {
    seedDatabaseFromConfig(database.db, baseSeeds(), fixedNow);
    seedDatabaseFromConfig(database.db, updatedSeeds(), laterNow);

    const targets = createTargetRepository(database.db).list();
    const profiles = createProfileRepository(database.db).list();
    const accessRules = createAccessRuleRepository(database.db);

    expect(targets).toHaveLength(1);
    expect(targets[0]?.name).toBe("Updated workspace");
    expect(targets[0]?.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(targets[0]?.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.displayName).toBe("Updated CTO");
    expect(accessRules.getRole({ channel: "telegram", accountId: "default", senderId: "123" })).toBe(
      "owner",
    );
  } finally {
    database.close();
  }
});

test("conversation bindings keep one row per conversation key", async () => {
  const database = await openSeededDatabase();

  try {
    let id = 0;
    const bindings = createConversationBindingRepository(database.db, {
      now: fixedNow,
      createId: () => `binding-${(id += 1)}`,
    });

    const first = bindings.upsert({
      conversationKey: "telegram:default:dm:123",
      channel: "telegram",
      accountId: "default",
      profileId: "cto",
      targetId: "default",
      opencodeSessionId: "session-1",
      busyMode: "queue",
      verbosity: "compact",
    });

    const second = bindings.upsert({
      conversationKey: "telegram:default:dm:123",
      channel: "telegram",
      accountId: "default",
      profileId: "cto",
      targetId: "default",
      opencodeSessionId: "session-2",
      sessionName: "new session",
      busyMode: "queue",
      verbosity: "tools",
    });

    const count = database.db
      .query("SELECT COUNT(*) AS count FROM conversation_bindings")
      .get() as { count: number };

    expect(first.id).toBe("binding-1");
    expect(second.id).toBe(first.id);
    expect(second.opencodeSessionId).toBe("session-2");
    expect(second.sessionName).toBe("new session");
    expect(second.verbosity).toBe("tools");
    expect(count.count).toBe(1);
    expect(bindings.getByConversationKey("telegram:default:dm:123")?.opencodeSessionId).toBe("session-2");
  } finally {
    database.close();
  }
});

test("conversation binding agent and model overrides can be set and cleared", async () => {
  const database = await openSeededDatabase();

  try {
    const bindings = createConversationBindingRepository(database.db, {
      now: fixedNow,
      createId: () => "binding-1",
    });
    const binding = bindings.upsert({
      conversationKey: "telegram:default:dm:123",
      channel: "telegram",
      accountId: "default",
      profileId: "cto",
      targetId: "default",
      opencodeSessionId: "session-1",
      busyMode: "queue",
      verbosity: "compact",
    });

    const withAgent = bindings.updateAgent({ conversationKey: binding.conversationKey, agent: "reviewer" });
    const withModel = bindings.updateModel({ conversationKey: binding.conversationKey, model: "provider/model" });

    expect(withAgent?.agent).toBe("reviewer");
    expect(withModel?.model).toBe("provider/model");
    expect(bindings.getByConversationKey(binding.conversationKey)).toMatchObject({
      agent: "reviewer",
      model: "provider/model",
    });

    const withoutAgent = bindings.updateAgent({ conversationKey: binding.conversationKey, agent: null });
    const withoutModel = bindings.updateModel({ conversationKey: binding.conversationKey, model: null });

    expect(withoutAgent?.agent).toBeUndefined();
    expect(withoutModel?.model).toBeUndefined();
    expect(bindings.getByConversationKey(binding.conversationKey)).toMatchObject({
      agent: undefined,
      model: undefined,
    });
  } finally {
    database.close();
  }
});

test("runs can be created, queried as active, and finished", async () => {
  const database = await openSeededDatabase();

  try {
    const bindings = createConversationBindingRepository(database.db, {
      now: fixedNow,
      createId: () => "binding-1",
    });
    const binding = bindings.upsert({
      conversationKey: "telegram:default:dm:123",
      channel: "telegram",
      accountId: "default",
      profileId: "cto",
      targetId: "default",
      opencodeSessionId: "session-1",
      busyMode: "queue",
      verbosity: "compact",
    });
    const runs = createRunRepository(database.db, {
      now: fixedNow,
      createId: () => "run-1",
    });

    const run = runs.create({ bindingId: binding.id, opencodeSessionId: binding.opencodeSessionId });

    expect(run.status).toBe("active");
    expect(runs.getActiveByBindingId(binding.id)?.id).toBe("run-1");

    const finished = runs.finish({ id: run.id, status: "completed", opencodeMessageId: "message-1" });

    expect(finished?.status).toBe("completed");
    expect(finished?.finishedAt).toBe("2026-01-01T00:00:00.000Z");
    expect(finished?.opencodeMessageId).toBe("message-1");
    expect(runs.getActiveByBindingId(binding.id)).toBeUndefined();
  } finally {
    database.close();
  }
});

test("app startup opens, migrates, seeds, and closes the configured database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-db-"));
  const databasePath = join(dir, "state.db");
  const entries: unknown[] = [];
  const app = createApp({
    config: testConfig(databasePath),
    logger: (entry) => entries.push(entry),
    now: fixedNow,
  });

  try {
    await app.start();

    expect(app.status.started).toBe(true);
    expect(app.status.databaseConnected).toBe(true);

    await app.stop();

    expect(app.status.started).toBe(false);
    expect(app.status.databaseConnected).toBe(false);

    const database = await openGatewayDatabase(databasePath);

    try {
      const targets = createTargetRepository(database.db).list();
      const accessRules = createAccessRuleRepository(database.db);

      expect(targets[0]?.id).toBe("default");
      expect(accessRules.getRole({ channel: "telegram", accountId: "default", senderId: "123" })).toBe(
        "owner",
      );
    } finally {
      database.close();
    }
  } finally {
    await app.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

function createTestRun(database: GatewayDatabase) {
  const bindings = createConversationBindingRepository(database.db, {
    now: fixedNow,
    createId: () => "binding-1",
  });
  const binding = bindings.upsert({
    conversationKey: "telegram:default:dm:123",
    channel: "telegram",
    accountId: "default",
    profileId: "cto",
    targetId: "default",
    opencodeSessionId: "session-1",
    busyMode: "queue",
    verbosity: "compact",
  });
  const runs = createRunRepository(database.db, {
    now: fixedNow,
    createId: () => "run-1",
  });

  return runs.create({ bindingId: binding.id, opencodeSessionId: binding.opencodeSessionId });
}

async function openTestDatabase(): Promise<GatewayDatabase> {
  return openGatewayDatabase(":memory:");
}

async function openMigratedDatabase(): Promise<GatewayDatabase> {
  const database = await openTestDatabase();
  runMigrations(database.db, fixedNow);
  return database;
}

async function openSeededDatabase(): Promise<GatewayDatabase> {
  const database = await openMigratedDatabase();
  seedDatabaseFromConfig(database.db, baseSeeds(), fixedNow);
  return database;
}

function fixedNow(): Date {
  return new Date("2026-01-01T00:00:00.000Z");
}

function laterNow(): Date {
  return new Date("2026-01-02T00:00:00.000Z");
}

function baseSeeds(): ConfigSeeds {
  return {
    targets: [
      {
        id: "default",
        name: "Default workspace",
        mode: "attach",
        serverUrl: "http://127.0.0.1:4096",
      },
    ],
    profiles: [
      {
        id: "cto",
        displayName: "CTO",
        defaultTargetId: "default",
        defaults: { busyMode: "queue", verbosity: "compact" },
      },
    ],
    accessRules: [
      {
        channel: "telegram",
        accountId: "default",
        senderId: "123",
        role: "owner",
      },
    ],
  };
}

function updatedSeeds(): ConfigSeeds {
  return {
    targets: [
      {
        id: "default",
        name: "Updated workspace",
        mode: "attach",
        serverUrl: "http://127.0.0.1:4097",
      },
    ],
    profiles: [
      {
        id: "cto",
        displayName: "Updated CTO",
        defaultTargetId: "default",
        defaults: { busyMode: "queue", verbosity: "tools" },
      },
    ],
    accessRules: [
      {
        channel: "telegram",
        accountId: "default",
        senderId: "123",
        role: "owner",
      },
    ],
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
      targets: baseSeeds().targets,
    },
    profiles: {
      default: "cto",
      entries: baseSeeds().profiles,
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
        allowAlways: false,
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
