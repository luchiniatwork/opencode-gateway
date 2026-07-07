import { expect, test } from "bun:test";

import type { InboundMessage } from "../channels/types.ts";
import type { AccessRuleSeed, ConfigSeeds, GatewayConfig } from "../config/schema.ts";
import { openGatewayDatabase, type GatewayDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrations.ts";
import { createAccessRuleRepository } from "../db/repositories/access-rules.ts";
import { createConversationBindingRepository } from "../db/repositories/conversation-bindings.ts";
import { createProfileRepository } from "../db/repositories/profiles.ts";
import { createRunRepository } from "../db/repositories/runs.ts";
import { seedDatabaseFromConfig } from "../db/repositories/seeds.ts";
import { createTargetRepository } from "../db/repositories/targets.ts";
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
  RuntimeModel,
  RuntimeSession,
  RuntimeStartedTurn,
  RuntimeTurn,
  SendRuntimeMessageInput,
  StartRuntimeTurnInput,
} from "../opencode/types.ts";
import { createDispatchResolver, type DispatchResolver } from "./resolver.ts";

test("unknown sender is denied before binding or runtime work", async () => {
  const harness = await createHarness({ accessRules: [] });

  try {
    const result = await harness.resolver.dispatchMessage(inboundMessage({ senderId: "999" }));

    expect(result.status).toBe("denied");
    expect(result.status === "denied" ? result.decision.reason : undefined).toBe("unknown_sender");
    expect(harness.runtime.calls.ensureSession).toEqual([]);
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)).toBeUndefined();
  } finally {
    harness.database.close();
  }
});

test("blocked sender is denied", async () => {
  const harness = await createHarness({
    accessRules: [{ channel: "telegram", accountId: "default", senderId: "123", role: "blocked" }],
  });

  try {
    const result = await harness.resolver.dispatchMessage(inboundMessage());

    expect(result.status).toBe("denied");
    expect(result.status === "denied" ? result.decision.reason : undefined).toBe("blocked");
    expect(harness.runtime.calls.ensureSession).toEqual([]);
  } finally {
    harness.database.close();
  }
});

test("first message creates a durable binding and later messages reuse it", async () => {
  const harness = await createHarness();

  try {
    const first = await harness.resolver.ensureBindingForMessage(inboundMessage());
    const second = await harness.resolver.ensureBindingForMessage(inboundMessage({ text: "second" }));

    expect(first.status).toBe("resolved");
    expect(second.status).toBe("resolved");
    if (first.status !== "resolved" || second.status !== "resolved") throw new Error("expected resolved");

    expect(first.resolution.binding.opencodeSessionId).toBe("session-1");
    expect(first.resolution.binding.targetSource).toBe("profile_default");
    expect(second.resolution.binding.opencodeSessionId).toBe("session-1");
    expect(harness.runtime.calls.ensureSession).toHaveLength(1);
    expect(harness.runtime.calls.ensureSession[0]).not.toHaveProperty("title");
  } finally {
    harness.database.close();
  }
});

test("dispatch sends through the runtime and marks the run completed", async () => {
  const harness = await createHarness();

  try {
    const result = await harness.resolver.dispatchMessage(inboundMessage({ text: "inspect this repo" }));

    expect(result.status).toBe("sent");
    if (result.status !== "sent") throw new Error("expected sent");

    expect(result.turn.text).toBe("answer-1");
    expect(harness.runtime.calls.send).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        text: "inspect this repo",
        agent: "cto-agent",
        model: "provider/cto-model",
      }),
    ]);
    expect(harness.repositories.runs.getActiveByBindingId(result.resolution.binding.id)).toBeUndefined();
    expect(runRows(harness.database)).toEqual([
      { id: "run-1", status: "completed", opencode_message_id: "message-1", error: null },
    ]);
  } finally {
    harness.database.close();
  }
});

test("dispatch uses binding agent and model overrides before profile defaults", async () => {
  const harness = await createHarness();

  try {
    const bindingResult = await harness.resolver.ensureBindingForMessage(inboundMessage());
    if (bindingResult.status !== "resolved") throw new Error("expected resolved");

    harness.repositories.bindings.updateAgent({
      conversationKey,
      agent: "binding-agent",
    });
    harness.repositories.bindings.updateModel({
      conversationKey,
      model: "provider/binding-model",
    });

    await harness.resolver.dispatchMessage(inboundMessage({ text: "with overrides" }));

    expect(harness.runtime.calls.send.at(-1)).toEqual(
      expect.objectContaining({
        text: "with overrides",
        agent: "binding-agent",
        model: "provider/binding-model",
      }),
    );

    harness.repositories.bindings.updateAgent({ conversationKey, agent: null });
    harness.repositories.bindings.updateModel({ conversationKey, model: null });

    await harness.resolver.dispatchMessage(inboundMessage({ text: "after clear" }));

    expect(harness.runtime.calls.send.at(-1)).toEqual(
      expect.objectContaining({
        text: "after clear",
        agent: "cto-agent",
        model: "provider/cto-model",
      }),
    );
  } finally {
    harness.database.close();
  }
});

test("runtime send errors mark the active run as error", async () => {
  const harness = await createHarness();
  harness.runtime.sendError = new Error("OpenCode unavailable");

  try {
    const result = await harness.resolver.dispatchMessage(inboundMessage());

    expect(result.status).toBe("error");
    expect(result.status === "error" ? result.error : undefined).toBe("OpenCode unavailable");
    expect(runRows(harness.database)).toEqual([
      { id: "run-1", status: "error", opencode_message_id: null, error: "OpenCode unavailable" },
    ]);
  } finally {
    harness.database.close();
  }
});

test("active run makes dispatch report busy without sending another prompt", async () => {
  const harness = await createHarness();

  try {
    const binding = await harness.resolver.ensureBindingForMessage(inboundMessage());
    if (binding.status !== "resolved") throw new Error("expected resolved");
    const run = harness.repositories.runs.create({
      bindingId: binding.resolution.binding.id,
      opencodeSessionId: binding.resolution.binding.opencodeSessionId,
    });

    const result = await harness.resolver.dispatchMessage(inboundMessage({ text: "queued?" }));

    expect(result.status).toBe("busy");
    expect(result.status === "busy" ? result.run.id : undefined).toBe(run.id);
    expect(harness.runtime.calls.send).toEqual([]);
  } finally {
    harness.database.close();
  }
});

test("reset creates a fresh session and updates the binding", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.ensureBindingForMessage(inboundMessage());

    const result = await harness.resolver.resetSession(inboundMessage());

    expect(result.status).toBe("rebound");
    if (result.status !== "rebound") throw new Error("expected rebound");

    expect(result.previousSessionId).toBe("session-1");
    expect(result.session.id).toBe("session-2");
    expect(result.resolution.binding.opencodeSessionId).toBe("session-2");
    expect(result.resolution.binding.targetSource).toBe("profile_default");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)?.opencodeSessionId).toBe(
      "session-2",
    );
  } finally {
    harness.database.close();
  }
});

test("useSession validates and rebinds to an existing runtime session", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.ensureBindingForMessage(inboundMessage());

    const result = await harness.resolver.useSession(inboundMessage(), "session-existing");

    expect(result.status).toBe("rebound");
    if (result.status !== "rebound") throw new Error("expected rebound");

    expect(result.previousSessionId).toBe("session-1");
    expect(result.session.id).toBe("session-existing");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)?.opencodeSessionId).toBe(
      "session-existing",
    );
    expect(harness.runtime.calls.ensureSession.at(-1)?.sessionId).toBe("session-existing");
  } finally {
    harness.database.close();
  }
});

test("useSession validation failure leaves the current binding unchanged", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.ensureBindingForMessage(inboundMessage());
    harness.runtime.missingSessionIds.add("missing-session");

    const result = await harness.resolver.useSession(inboundMessage(), "missing-session");

    expect(result.status).toBe("error");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)?.opencodeSessionId).toBe(
      "session-1",
    );
  } finally {
    harness.database.close();
  }
});

test("switchProfile keeps the current session when the target is unchanged", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.ensureBindingForMessage(inboundMessage());

    const result = await harness.resolver.switchProfile(inboundMessage(), "review");

    expect(result.status).toBe("rebound");
    if (result.status !== "rebound") throw new Error("expected rebound");

    expect(result.previousSessionId).toBe("session-1");
    expect(result.session.id).toBe("session-1");
    expect(result.resolution.binding.profileId).toBe("review");
    expect(result.resolution.binding.targetId).toBe("default");
    expect(result.resolution.binding.targetSource).toBe("profile_default");
    expect(result.resolution.binding.opencodeSessionId).toBe("session-1");
    expect(harness.runtime.calls.ensureSession).toHaveLength(1);
  } finally {
    harness.database.close();
  }
});

test("switchProfile creates a fresh session when the selected profile uses another target", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.ensureBindingForMessage(inboundMessage());

    const result = await harness.resolver.switchProfile(inboundMessage(), "ops");

    expect(result.status).toBe("rebound");
    if (result.status !== "rebound") throw new Error("expected rebound");

    expect(result.previousSessionId).toBe("session-1");
    expect(result.session.id).toBe("session-2");
    expect(result.session.targetId).toBe("ops-target");
    expect(result.resolution.binding.profileId).toBe("ops");
    expect(result.resolution.binding.targetId).toBe("ops-target");
    expect(result.resolution.binding.targetSource).toBe("profile_default");
  } finally {
    harness.database.close();
  }
});

test("switchProfile clears binding overrides unavailable on the new target", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.ensureBindingForMessage(inboundMessage());
    harness.repositories.bindings.updateAgent({ conversationKey, agent: "default-only-agent" });
    harness.repositories.bindings.updateModel({ conversationKey, model: "provider/default-only-model" });

    const result = await harness.resolver.switchProfile(inboundMessage(), "ops");

    expect(result.status).toBe("rebound");
    if (result.status !== "rebound") throw new Error("expected rebound");

    expect(result.clearedOverrides).toEqual([
      { kind: "agent", value: "default-only-agent", targetId: "ops-target" },
      { kind: "model", value: "provider/default-only-model", targetId: "ops-target" },
    ]);
    expect(result.resolution.binding.agent).toBeUndefined();
    expect(result.resolution.binding.model).toBeUndefined();
    expect(result.resolution.agent).toBe("ops-target-agent");
    expect(result.resolution.model).toBeUndefined();
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)).toMatchObject({
      agent: undefined,
      model: undefined,
      targetId: "ops-target",
    });
  } finally {
    harness.database.close();
  }
});

test("switchProfile preserves binding overrides available on the new target", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.ensureBindingForMessage(inboundMessage());
    harness.repositories.bindings.updateAgent({ conversationKey, agent: "shared-agent" });
    harness.repositories.bindings.updateModel({ conversationKey, model: "provider/shared-model" });

    const result = await harness.resolver.switchProfile(inboundMessage(), "ops");

    expect(result.status).toBe("rebound");
    if (result.status !== "rebound") throw new Error("expected rebound");

    expect(result.clearedOverrides).toBeUndefined();
    expect(result.resolution.binding.agent).toBe("shared-agent");
    expect(result.resolution.binding.model).toBe("provider/shared-model");
    expect(result.resolution.agent).toBe("shared-agent");
    expect(result.resolution.model).toBe("provider/shared-model");
  } finally {
    harness.database.close();
  }
});

test("bindTarget creates a session on the selected target and sets an explicit bind", async () => {
  const harness = await createHarness();

  try {
    const result = await harness.resolver.bindTarget(inboundMessage(), "ops-target");

    expect(result.status).toBe("rebound");
    if (result.status !== "rebound") throw new Error("expected rebound");

    expect(result.session.id).toBe("session-1");
    expect(result.session.targetId).toBe("ops-target");
    expect(result.resolution.binding.targetId).toBe("ops-target");
    expect(result.resolution.binding.targetSource).toBe("explicit_bind");
    expect(result.resolution.target.id).toBe("ops-target");
    expect(harness.runtime.calls.ensureSession).toEqual([
      expect.objectContaining({ target: expect.objectContaining({ id: "ops-target" }) }),
    ]);
  } finally {
    harness.database.close();
  }
});

test("bindTarget no-ops when the conversation is already explicitly bound to the target", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.bindTarget(inboundMessage(), "ops-target");

    const result = await harness.resolver.bindTarget(inboundMessage(), "ops-target");

    expect(result.status).toBe("noop");
    expect(result.status === "noop" ? result.reason : undefined).toBe("already_bound");
    expect(harness.runtime.calls.ensureSession).toHaveLength(1);
  } finally {
    harness.database.close();
  }
});

test("bindTarget pins the current profile default target without creating a new session", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.ensureBindingForMessage(inboundMessage());

    const result = await harness.resolver.bindTarget(inboundMessage(), "default");

    expect(result.status).toBe("rebound");
    if (result.status !== "rebound") throw new Error("expected rebound");

    expect(result.previousSessionId).toBe("session-1");
    expect(result.session.id).toBe("session-1");
    expect(result.resolution.binding.targetId).toBe("default");
    expect(result.resolution.binding.targetSource).toBe("explicit_bind");
    expect(harness.runtime.calls.ensureSession).toHaveLength(1);
  } finally {
    harness.database.close();
  }
});

test("bindTarget clears binding overrides unavailable on the selected target", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.ensureBindingForMessage(inboundMessage());
    harness.repositories.bindings.updateAgent({ conversationKey, agent: "default-only-agent" });
    harness.repositories.bindings.updateModel({ conversationKey, model: "provider/default-only-model" });

    const result = await harness.resolver.bindTarget(inboundMessage(), "ops-target");

    expect(result.status).toBe("rebound");
    if (result.status !== "rebound") throw new Error("expected rebound");

    expect(result.clearedOverrides).toEqual([
      { kind: "agent", value: "default-only-agent", targetId: "ops-target" },
      { kind: "model", value: "provider/default-only-model", targetId: "ops-target" },
    ]);
    expect(result.resolution.binding.agent).toBeUndefined();
    expect(result.resolution.binding.model).toBeUndefined();
    expect(result.resolution.binding.targetSource).toBe("explicit_bind");
  } finally {
    harness.database.close();
  }
});

test("switchProfile preserves an explicit target binding", async () => {
  const harness = await createHarness();

  try {
    const bound = await harness.resolver.bindTarget(inboundMessage(), "ops-target");
    if (bound.status !== "rebound") throw new Error("expected rebound");

    const result = await harness.resolver.switchProfile(inboundMessage(), "review");

    expect(result.status).toBe("rebound");
    if (result.status !== "rebound") throw new Error("expected rebound");

    expect(result.previousSessionId).toBe("session-1");
    expect(result.session.id).toBe("session-1");
    expect(result.resolution.binding.profileId).toBe("review");
    expect(result.resolution.binding.targetId).toBe("ops-target");
    expect(result.resolution.binding.targetSource).toBe("explicit_bind");
    expect(result.resolution.target.id).toBe("ops-target");
    expect(harness.runtime.calls.ensureSession).toHaveLength(1);
  } finally {
    harness.database.close();
  }
});

test("unbindTarget clears explicit bind and returns to the active profile default target", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.bindTarget(inboundMessage(), "ops-target");

    const result = await harness.resolver.unbindTarget(inboundMessage());

    expect(result.status).toBe("rebound");
    if (result.status !== "rebound") throw new Error("expected rebound");

    expect(result.previousSessionId).toBe("session-1");
    expect(result.previousTargetId).toBe("ops-target");
    expect(result.session.id).toBe("session-2");
    expect(result.session.targetId).toBe("default");
    expect(result.resolution.binding.targetId).toBe("default");
    expect(result.resolution.binding.targetSource).toBe("profile_default");
    expect(result.resolution.target.id).toBe("default");
  } finally {
    harness.database.close();
  }
});

test("unbindTarget refuses while an active run exists", async () => {
  const harness = await createHarness();

  try {
    const bound = await harness.resolver.bindTarget(inboundMessage(), "ops-target");
    if (bound.status !== "rebound") throw new Error("expected rebound");
    const run = harness.repositories.runs.create({
      bindingId: bound.resolution.binding.id,
      targetId: bound.resolution.target.id,
      opencodeSessionId: bound.resolution.binding.opencodeSessionId,
    });

    const result = await harness.resolver.unbindTarget(inboundMessage());

    expect(result.status).toBe("blocked");
    expect(result.status === "blocked" && result.reason === "active_run" ? result.run.id : undefined).toBe(run.id);
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)?.targetSource).toBe("explicit_bind");
  } finally {
    harness.database.close();
  }
});

test("unbindTarget refuses while queued turns exist", async () => {
  const harness = await createHarness({ queuedTurnCount: 2 });

  try {
    await harness.resolver.bindTarget(inboundMessage(), "ops-target");

    const result = await harness.resolver.unbindTarget(inboundMessage());

    expect(result.status).toBe("blocked");
    expect(result.status === "blocked" ? result.reason : undefined).toBe("queued_turns");
    expect(result.status === "blocked" && result.reason === "queued_turns" ? result.queueSize : undefined).toBe(2);
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)?.targetSource).toBe("explicit_bind");
    expect(harness.runtime.calls.ensureSession).toHaveLength(1);
  } finally {
    harness.database.close();
  }
});

test("useSession validates against the explicit target when bound", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.bindTarget(inboundMessage(), "ops-target");

    const result = await harness.resolver.useSession(inboundMessage(), "session-existing");

    expect(result.status).toBe("rebound");
    if (result.status !== "rebound") throw new Error("expected rebound");

    expect(harness.runtime.calls.ensureSession.at(-1)).toEqual(expect.objectContaining({
      sessionId: "session-existing",
      target: expect.objectContaining({ id: "ops-target" }),
    }));
    expect(result.resolution.binding.targetSource).toBe("explicit_bind");
  } finally {
    harness.database.close();
  }
});

const conversationKey = "telegram:default:dm:123";

interface Harness {
  database: GatewayDatabase;
  resolver: DispatchResolver;
  runtime: FakeRuntime;
  repositories: ReturnType<typeof createRepositories>;
}

async function createHarness(
  options: { accessRules?: AccessRuleSeed[]; queuedTurnCount?: number | ((bindingId: string) => number) } = {},
): Promise<Harness> {
  const database = await openGatewayDatabase(":memory:");
  const config = testConfig();
  const runtime = new FakeRuntime();
  const repositories = createRepositories(database);
  const queuedTurnCount = options.queuedTurnCount;
  const getQueuedTurnCount: (bindingId: string) => number = typeof queuedTurnCount === "function"
    ? queuedTurnCount
    : () => queuedTurnCount ?? 0;

  runMigrations(database.db, fixedNow);
  seedDatabaseFromConfig(database.db, testSeeds(options.accessRules), fixedNow);

  return {
    database,
    runtime,
    repositories,
    resolver: createDispatchResolver({
      config,
      repositories,
      runtime,
      activity: {
        getQueuedTurnCount,
      },
    }),
  };
}

function createRepositories(database: GatewayDatabase) {
  let bindingId = 0;
  let runId = 0;

  return {
    accessRules: createAccessRuleRepository(database.db, { now: fixedNow }),
    bindings: createConversationBindingRepository(database.db, {
      now: fixedNow,
      createId: () => `binding-${(bindingId += 1)}`,
    }),
    profiles: createProfileRepository(database.db, fixedNow),
    targets: createTargetRepository(database.db, fixedNow),
    runs: createRunRepository(database.db, {
      now: fixedNow,
      createId: () => `run-${(runId += 1)}`,
    }),
  };
}

function testSeeds(accessRules: AccessRuleSeed[] = defaultAccessRules()): ConfigSeeds {
  return {
    targets: [
      {
        id: "default",
        name: "Default workspace",
        mode: "attach",
        serverUrl: "http://127.0.0.1:4096",
        defaultAgent: "target-agent",
        defaultModel: "provider/target-model",
      },
      {
        id: "ops-target",
        name: "Ops workspace",
        mode: "attach",
        serverUrl: "http://127.0.0.1:4097",
        defaultAgent: "ops-target-agent",
      },
    ],
    profiles: [
      {
        id: "cto",
        displayName: "CTO",
        defaultTargetId: "default",
        defaultAgent: "cto-agent",
        defaultModel: "provider/cto-model",
        defaults: { busyMode: "queue", verbosity: "compact" },
      },
      {
        id: "review",
        displayName: "Review",
        defaultTargetId: "default",
        defaultAgent: "review-agent",
        defaults: { busyMode: "queue", verbosity: "tools" },
      },
      {
        id: "ops",
        displayName: "Ops",
        defaultTargetId: "ops-target",
        defaults: { busyMode: "queue", verbosity: "tools" },
      },
    ],
    accessRules,
  };
}

function testConfig(): GatewayConfig {
  const seeds = testSeeds();

  return {
    gateway: {
      host: "127.0.0.1",
      port: 8765,
      databasePath: ":memory:",
      logLevel: "info",
    },
    opencode: { targets: seeds.targets },
    profiles: { default: "cto", entries: seeds.profiles },
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

function defaultAccessRules(): AccessRuleSeed[] {
  return [{ channel: "telegram", accountId: "default", senderId: "123", role: "owner" }];
}

function inboundMessage(options: { senderId?: string; text?: string } = {}): InboundMessage {
  return {
    id: "message-1",
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
    attachments: [],
  };
}

function fixedNow(): Date {
  return new Date("2026-01-01T00:00:00.000Z");
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

class FakeRuntime implements AgentRuntime {
  readonly calls: {
    ensureSession: EnsureSessionInput[];
    send: SendRuntimeMessageInput[];
    abort: AbortRuntimeTurnInput[];
    listSessions: ListRuntimeSessionsInput[];
    listAgents: ListRuntimeAgentsInput[];
    listModels: ListRuntimeModelsInput[];
  } = {
    ensureSession: [],
    send: [],
    abort: [],
    listSessions: [],
    listAgents: [],
    listModels: [],
  };

  readonly missingSessionIds = new Set<string>();
  readonly agentsByTarget = new Map<string, RuntimeAgent[]>([
    ["default", [{ id: "cto-agent" }, { id: "default-only-agent" }, { id: "shared-agent" }]],
    ["ops-target", [{ id: "ops-target-agent" }, { id: "shared-agent" }]],
  ]);
  readonly modelsByTarget = new Map<string, RuntimeModel[]>([
    [
      "default",
      [
        { id: "provider/cto-model", providerId: "provider", modelId: "cto-model" },
        { id: "provider/default-only-model", providerId: "provider", modelId: "default-only-model" },
        { id: "provider/shared-model", providerId: "provider", modelId: "shared-model" },
      ],
    ],
    ["ops-target", [{ id: "provider/shared-model", providerId: "provider", modelId: "shared-model" }]],
  ]);
  sendError: Error | undefined;
  private nextSessionNumber = 1;
  private nextMessageNumber = 1;

  async ensureSession(input: EnsureSessionInput): Promise<RuntimeSession> {
    this.calls.ensureSession.push(input);

    if (input.sessionId) {
      if (this.missingSessionIds.has(input.sessionId)) {
        throw new Error(`Session not found: ${input.sessionId}`);
      }

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

    if (this.sendError) throw this.sendError;

    const messageNumber = this.nextMessageNumber++;

    return {
      id: `message-${messageNumber}`,
      sessionId: input.sessionId,
      status: "completed",
      text: `answer-${messageNumber}`,
    };
  }

  async sendAsync(input: SendRuntimeMessageInput): Promise<never> {
    throw new Error("FakeRuntime.sendAsync is not implemented in Phase 1 tests");
  }

  async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    throw new Error("FakeRuntime.startTurn is not implemented in resolver tests");
  }

  async *observe(input: ObserveRuntimeTurnInput): AsyncIterable<never> {
    throw new Error("FakeRuntime.observe is not implemented in Phase 1 tests");
  }

  async abort(input: AbortRuntimeTurnInput): Promise<void> {
    this.calls.abort.push(input);
  }

  async respondToPermission(input: PermissionResponseInput): Promise<void> {
    throw new Error("FakeRuntime.respondToPermission is not implemented in Phase 1 tests");
  }

  async listSessions(input: ListRuntimeSessionsInput): Promise<RuntimeSession[]> {
    this.calls.listSessions.push(input);
    return [];
  }

  async listAgents(input: ListRuntimeAgentsInput): Promise<RuntimeAgent[]> {
    this.calls.listAgents.push(input);
    return this.agentsByTarget.get(input.target.id) ?? [];
  }

  async listModels(input: ListRuntimeModelsInput): Promise<RuntimeModel[]> {
    this.calls.listModels.push(input);
    return this.modelsByTarget.get(input.target.id) ?? [];
  }
}
