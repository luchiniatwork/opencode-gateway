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
import { createProfileRepository } from "./repositories/profiles.ts";
import { createRunRepository } from "./repositories/runs.ts";
import { seedDatabaseFromConfig } from "./repositories/seeds.ts";
import { createTargetRepository } from "./repositories/targets.ts";

test("migrations create the phase 1 database tables", async () => {
  const database = await openTestDatabase();

  try {
    runMigrations(database.db, fixedNow);

    const rows = database.db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as { name: string }[];
    const tableNames = rows.map((row) => row.name);

    expect(tableNames).toContain("access_rules");
    expect(tableNames).toContain("conversation_bindings");
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

    expect(row.count).toBe(1);
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
      port: 8765,
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
    defaults: {
      profile: "cto",
      target: "default",
      busyMode: "queue",
      verbosity: "compact",
      inboundDebounceMs: 1500,
    },
  };
}
