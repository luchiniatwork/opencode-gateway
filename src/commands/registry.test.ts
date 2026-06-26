import { expect, test } from "bun:test";

import type { InboundMessage } from "../channels/types.ts";
import type { AccessRuleSeed, ConfigSeeds, GatewayConfig } from "../config/schema.ts";
import { openGatewayDatabase, type GatewayDatabase } from "../db/client.ts";
import { runMigrations } from "../db/migrations.ts";
import { createAccessRuleRepository } from "../db/repositories/access-rules.ts";
import { createConversationBindingRepository } from "../db/repositories/conversation-bindings.ts";
import { createProfileRepository } from "../db/repositories/profiles.ts";
import { createPendingPermissionRepository } from "../db/repositories/pending-permissions.ts";
import { createRunRepository } from "../db/repositories/runs.ts";
import { seedDatabaseFromConfig } from "../db/repositories/seeds.ts";
import { createTargetRepository } from "../db/repositories/targets.ts";
import { createDispatchResolver, type DispatchResolver } from "../dispatch/resolver.ts";
import { createTurnRunner } from "../gateway/turn-runner.ts";
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
  RuntimeTurnHandle,
  SendRuntimeMessageInput,
  StartRuntimeTurnInput,
} from "../opencode/types.ts";
import { createCommandRouter, type CommandRouter } from "./registry.ts";

test("non-slash text is not handled as a command", async () => {
  const harness = await createHarness();

  try {
    const result = await harness.router.handle(inboundMessage({ text: "hello" }));

    expect(result).toEqual({ handled: false });
    expect(harness.runtime.calls.ensureSession).toEqual([]);
  } finally {
    harness.database.close();
  }
});

test("unknown command returns help guidance", async () => {
  const harness = await createHarness();

  try {
    const result = await harness.router.handle(inboundMessage({ text: "/nope" }));

    expect(responseText(result)).toContain("Unknown command: /nope");
    expect(responseText(result)).toContain("/help");
  } finally {
    harness.database.close();
  }
});

test("help lists agent and model commands", async () => {
  const harness = await createHarness();

  try {
    const result = await harness.router.handle(inboundMessage({ text: "/help" }));
    const text = responseText(result);

    expect(text).toContain("`/agent [name|default|clear]`");
    expect(text).toContain("`/agents`");
    expect(text).toContain("`/model [id|default|clear]`");
    expect(text).toContain("`/models`");
    expect(text).toContain("`/bind <target-id>`");
    expect(text).toContain("`/unbind`");
  } finally {
    harness.database.close();
  }
});

test("commandText takes precedence over text and strips bot mention", async () => {
  const harness = await createHarness();

  try {
    const result = await harness.router.handle(
      inboundMessage({ text: "not a command", commandText: "/profile@GatewayBot review" }),
    );

    expect(responseText(result)).toContain("Switched profile to Review (review).");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)?.profileId).toBe("review");
    expect(harness.runtime.calls.ensureSession).toHaveLength(1);
  } finally {
    harness.database.close();
  }
});

test("unknown sender is denied before command side effects", async () => {
  const harness = await createHarness({ accessRules: [] });

  try {
    const result = await harness.router.handle(inboundMessage({ text: "/new" }));

    expect(responseText(result)).toBe("Access denied: this sender is not allowlisted.");
    expect(harness.runtime.calls.ensureSession).toEqual([]);
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)).toBeUndefined();
  } finally {
    harness.database.close();
  }
});

test("unknown sender is denied before any command response", async () => {
  const harness = await createHarness({ accessRules: [] });

  try {
    const help = await harness.router.handle(inboundMessage({ text: "/help" }));
    const unknown = await harness.router.handle(inboundMessage({ text: "/nope" }));

    expect(responseText(help)).toBe("Access denied: this sender is not allowlisted.");
    expect(responseText(unknown)).toBe("Access denied: this sender is not allowlisted.");
    expect(harness.runtime.calls.ensureSession).toEqual([]);
  } finally {
    harness.database.close();
  }
});

test("status reports context without creating a binding", async () => {
  const harness = await createHarness();

  try {
    const result = await harness.router.handle(inboundMessage({ text: "/status" }));
    const text = responseText(result);

    expect(text).toContain("Gateway status:");
    expect(text).toContain(`Conversation: ${conversationKey}`);
    expect(text).toContain("Role: owner");
    expect(text).toContain("Profile: CTO (cto)");
    expect(text).toContain("Target: Default workspace (default) (healthy)");
    expect(text).toContain("Target source: profile default");
    expect(text).toContain("Profile default target: Default workspace (default)");
    expect(text).toContain("Session: none");
    expect(text).toContain("Agent: cto-agent (profile default)");
    expect(text).toContain("Model: provider/cto-model (profile default)");
    expect(text).toContain("Verbosity: compact (profile default)");
    expect(harness.runtime.calls.ensureSession).toEqual([]);
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)).toBeUndefined();
  } finally {
    harness.database.close();
  }
});

test("status reports active run and pending permission diagnostics", async () => {
  const harness = await createHarness();

  try {
    const bindingResult = await harness.resolver.ensureBindingForMessage(inboundMessage());
    if (bindingResult.status !== "resolved") throw new Error("expected resolved binding");

    const run = harness.repositories.runs.create({
      bindingId: bindingResult.resolution.binding.id,
      opencodeSessionId: bindingResult.resolution.binding.opencodeSessionId,
      opencodeMessageId: "message-active",
    });
    harness.repositories.pendingPermissions.create({
      runId: run.id,
      opencodePermissionId: "opencode-permission-1",
      summary: "Run bash",
      expiresAt: "2026-01-01T00:15:00.000Z",
    });

    const result = await harness.router.handle(inboundMessage({ text: "/status" }));
    const text = responseText(result);

    expect(text).toContain(`Active run: ${run.id} (active) session=session-1 message=message-active`);
    expect(text).toContain("Pending permissions: 1 pending, 1 without action card");
  } finally {
    harness.database.close();
  }
});

test("agent and model view commands report effective defaults without creating a binding", async () => {
  const harness = await createHarness();

  try {
    const agent = await harness.router.handle(inboundMessage({ text: "/agent" }));
    const model = await harness.router.handle(inboundMessage({ text: "/model" }));

    expect(responseText(agent)).toContain("Effective agent: cto-agent (profile default)");
    expect(responseText(agent)).toContain("Agent override: none");
    expect(responseText(agent)).toContain("Target default: target-agent");
    expect(responseText(model)).toContain("Effective model: provider/cto-model (profile default)");
    expect(responseText(model)).toContain("Model override: none");
    expect(responseText(model)).toContain("Target default: provider/target-model");
    expect(harness.runtime.calls.ensureSession).toEqual([]);
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)).toBeUndefined();
  } finally {
    harness.database.close();
  }
});

test("agents and models commands list available runtime selections and mark current values", async () => {
  const harness = await createHarness();

  try {
    const agents = await harness.router.handle(inboundMessage({ text: "/agents" }));
    const models = await harness.router.handle(inboundMessage({ text: "/models" }));

    expect(responseText(agents)).toBe([
      "🤖 OpenCode agents for Default workspace (default):",
      "* cto-agent - CTO default",
      "- mobile-agent - Mobile specialist",
    ].join("\n"));
    expect(responseText(models)).toBe([
      "🧠 OpenCode models for Default workspace (default):",
      "* provider/cto-model (CTO model)",
      "- provider/custom-model (Custom model)",
    ].join("\n"));
    expect(harness.runtime.calls.listAgents).toEqual([expect.objectContaining({ target: expect.objectContaining({ id: "default" }) })]);
    expect(harness.runtime.calls.listModels).toEqual([expect.objectContaining({ target: expect.objectContaining({ id: "default" }) })]);
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)).toBeUndefined();
  } finally {
    harness.database.close();
  }
});

test("agent command creates a binding, sets override, and clears it", async () => {
  const harness = await createHarness();

  try {
    const set = await harness.router.handle(inboundMessage({ text: "/agent mobile-agent" }));
    const bindingWithOverride = harness.repositories.bindings.getByConversationKey(conversationKey);

    expect(responseText(set)).toContain("Agent override set to mobile-agent.");
    expect(responseText(set)).toContain("Effective agent: mobile-agent (binding override)");
    expect(bindingWithOverride?.agent).toBe("mobile-agent");
    expect(bindingWithOverride?.opencodeSessionId).toBe("session-1");
    expect(harness.runtime.calls.ensureSession).toHaveLength(1);

    const status = await harness.router.handle(inboundMessage({ text: "/status" }));
    expect(responseText(status)).toContain("Agent: mobile-agent (binding override)");

    const clear = await harness.router.handle(inboundMessage({ text: "/agent clear" }));

    expect(responseText(clear)).toContain("Agent override cleared.");
    expect(responseText(clear)).toContain("Effective agent: cto-agent (profile default)");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)?.agent).toBeUndefined();
    expect(harness.runtime.calls.ensureSession).toHaveLength(1);
  } finally {
    harness.database.close();
  }
});

test("model command creates a binding, sets override, and clears it", async () => {
  const harness = await createHarness();

  try {
    const set = await harness.router.handle(inboundMessage({ text: "/model provider/custom-model" }));
    const bindingWithOverride = harness.repositories.bindings.getByConversationKey(conversationKey);

    expect(responseText(set)).toContain("Model override set to provider/custom-model.");
    expect(responseText(set)).toContain("Effective model: provider/custom-model (binding override)");
    expect(bindingWithOverride?.model).toBe("provider/custom-model");
    expect(bindingWithOverride?.opencodeSessionId).toBe("session-1");
    expect(harness.runtime.calls.ensureSession).toHaveLength(1);

    const status = await harness.router.handle(inboundMessage({ text: "/status" }));
    expect(responseText(status)).toContain("Model: provider/custom-model (binding override)");

    const clear = await harness.router.handle(inboundMessage({ text: "/model default" }));

    expect(responseText(clear)).toContain("Model override cleared.");
    expect(responseText(clear)).toContain("Effective model: provider/cto-model (profile default)");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)?.model).toBeUndefined();
    expect(harness.runtime.calls.ensureSession).toHaveLength(1);
  } finally {
    harness.database.close();
  }
});

test("agent and model set commands reject unavailable selections without creating a binding", async () => {
  const harness = await createHarness();

  try {
    const missingAgent = await harness.router.handle(inboundMessage({ text: "/agent missing-agent" }));
    const wrongCaseAgent = await harness.router.handle(inboundMessage({ text: "/agent Mobile-Agent" }));
    const missingModel = await harness.router.handle(inboundMessage({ text: "/model provider/missing-model" }));

    expect(responseText(missingAgent)).toBe("Agent not found: missing-agent. Run /agents to see available agents.");
    expect(responseText(wrongCaseAgent)).toBe("Agent not found: Mobile-Agent. Run /agents to see available agents.");
    expect(responseText(missingModel)).toBe("Model not found: provider/missing-model. Run /models to see available models.");
    expect(harness.runtime.calls.ensureSession).toEqual([]);
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)).toBeUndefined();
  } finally {
    harness.database.close();
  }
});

test("normal users can view but not mutate agent and model overrides", async () => {
  const harness = await createHarness({
    accessRules: [{ channel: "telegram", accountId: "default", senderId: "123", role: "user" }],
  });

  try {
    const view = await harness.router.handle(inboundMessage({ text: "/agent" }));
    const setAgent = await harness.router.handle(inboundMessage({ text: "/agent mobile-agent" }));
    const setModel = await harness.router.handle(inboundMessage({ text: "/model provider/custom-model" }));

    expect(responseText(view)).toContain("Effective agent: cto-agent (profile default)");
    expect(responseText(setAgent)).toBe("Agent changes require owner/admin access.");
    expect(responseText(setModel)).toBe("Model changes require owner/admin access.");
    expect(harness.runtime.calls.ensureSession).toEqual([]);
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)).toBeUndefined();
  } finally {
    harness.database.close();
  }
});

test("new command creates a fresh session binding", async () => {
  const harness = await createHarness();

  try {
    const result = await harness.router.handle(inboundMessage({ text: "/new" }));
    const binding = harness.repositories.bindings.getByConversationKey(conversationKey);

    expect(responseText(result)).toContain("Created a new OpenCode session.");
    expect(responseText(result)).toContain("Current session: session-1");
    expect(binding?.opencodeSessionId).toBe("session-1");
  } finally {
    harness.database.close();
  }
});

test("reset command replaces the current session", async () => {
  const harness = await createHarness();

  try {
    await harness.router.handle(inboundMessage({ text: "/new" }));

    const result = await harness.router.handle(inboundMessage({ text: "/reset" }));
    const text = responseText(result);

    expect(text).toContain("Reset this conversation to a new OpenCode session.");
    expect(text).toContain("Previous session: session-1");
    expect(text).toContain("Current session: session-2");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)?.opencodeSessionId).toBe(
      "session-2",
    );
  } finally {
    harness.database.close();
  }
});

test("stop command aborts and marks the active run aborted", async () => {
  const harness = await createHarness();

  try {
    const bindingResult = await harness.resolver.ensureBindingForMessage(inboundMessage());
    if (bindingResult.status !== "resolved") throw new Error("expected resolved binding");

    const run = harness.repositories.runs.create({
      bindingId: bindingResult.resolution.binding.id,
      opencodeSessionId: bindingResult.resolution.binding.opencodeSessionId,
      opencodeMessageId: "message-active",
    });

    const result = await harness.router.handle(inboundMessage({ text: "/stop" }));

    expect(responseText(result)).toBe(`Stopped active run ${run.id} for session session-1.`);
    expect(harness.runtime.calls.abort).toEqual([
      expect.objectContaining({ sessionId: "session-1", turnId: "message-active" }),
    ]);
    expect(harness.repositories.runs.getActiveByBindingId(bindingResult.resolution.binding.id)).toBeUndefined();
  } finally {
    harness.database.close();
  }
});

test("stop command releases the local run when remote abort fails", async () => {
  const harness = await createHarness();
  harness.runtime.abortError = new Error("abort unavailable");

  try {
    const bindingResult = await harness.resolver.ensureBindingForMessage(inboundMessage());
    if (bindingResult.status !== "resolved") throw new Error("expected resolved binding");

    const run = harness.repositories.runs.create({
      bindingId: bindingResult.resolution.binding.id,
      opencodeSessionId: bindingResult.resolution.binding.opencodeSessionId,
      opencodeMessageId: "message-active",
    });

    const result = await harness.router.handle(inboundMessage({ text: "/stop" }));
    const text = responseText(result);

    expect(text).toContain(`Stopped active run ${run.id} for session session-1.`);
    expect(text).toContain("Remote OpenCode abort failed: abort unavailable");
    expect(harness.runtime.calls.abort).toEqual([
      expect.objectContaining({ sessionId: "session-1", turnId: "message-active" }),
    ]);
    expect(harness.repositories.runs.getActiveByBindingId(bindingResult.resolution.binding.id)).toBeUndefined();
  } finally {
    harness.database.close();
  }
});

test("new command stops active run before rebinding", async () => {
  const harness = await createHarness();

  try {
    const bindingResult = await harness.resolver.ensureBindingForMessage(inboundMessage());
    if (bindingResult.status !== "resolved") throw new Error("expected resolved binding");

    const run = harness.repositories.runs.create({
      bindingId: bindingResult.resolution.binding.id,
      opencodeSessionId: "old-session",
      opencodeMessageId: "message-active",
    });

    const result = await harness.router.handle(inboundMessage({ text: "/new" }));
    const text = responseText(result);

    expect(text).toContain(`Stopped active run ${run.id} for session old-session.`);
    expect(text).toContain("Created a new OpenCode session.");
    expect(text).toContain("Previous session: session-1");
    expect(text).toContain("Current session: session-2");
    expect(harness.runtime.calls.abort).toEqual([
      expect.objectContaining({ sessionId: "old-session", turnId: "message-active" }),
    ]);
    expect(harness.repositories.runs.getActiveByBindingId(bindingResult.resolution.binding.id)).toBeUndefined();
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)?.opencodeSessionId).toBe(
      "session-2",
    );
  } finally {
    harness.database.close();
  }
});

test("sessions command lists runtime sessions and marks the current one", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.ensureBindingForMessage(inboundMessage());
    harness.runtime.sessions = [
      { id: "session-2", targetId: "default", title: "Other" },
      { id: "session-1", targetId: "default", title: "Current" },
    ];

    const result = await harness.router.handle(inboundMessage({ text: "/sessions" }));
    const text = responseText(result);

    expect(text).toBe([
      "🧵 Recent sessions for Default workspace (default):",
      '- session-2 "Other"',
      '- session-1 "Current" (current)',
    ].join("\n"));
    expect(harness.runtime.calls.listSessions).toEqual([expect.objectContaining({ limit: 10 })]);
  } finally {
    harness.database.close();
  }
});

test("use-session command validates and rebinds", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.ensureBindingForMessage(inboundMessage());

    const result = await harness.router.handle(inboundMessage({ text: "/use-session existing-session" }));
    const text = responseText(result);

    expect(text).toContain("Conversation rebound to session existing-session.");
    expect(text).toContain("Previous session: session-1");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)?.opencodeSessionId).toBe(
      "existing-session",
    );
  } finally {
    harness.database.close();
  }
});

test("profiles command lists available profiles and marks current", async () => {
  const harness = await createHarness();

  try {
    const result = await harness.router.handle(inboundMessage({ text: "/profiles" }));
    const text = responseText(result);

    expect(text).toContain("Gateway profiles:");
    expect(text).toContain("* cto: CTO [verbosity=compact, busy=queue]");
    expect(text).toContain("- ops: Ops [verbosity=tools, busy=queue]");
    expect(text).toContain("- review: Review [verbosity=tools, busy=queue]");
  } finally {
    harness.database.close();
  }
});

test("profile command shows current profile", async () => {
  const harness = await createHarness();

  try {
    const result = await harness.router.handle(inboundMessage({ text: "/profile" }));
    const text = responseText(result);

    expect(text).toContain("Current profile: CTO (cto)");
    expect(text).toContain("Target: Default workspace (default)");
    expect(text).toContain("Target source: profile default");
    expect(text).toContain("Profile default target: Default workspace (default)");
    expect(text).toContain("Session: none");
    expect(text).toContain("Verbosity: compact (profile default)");
  } finally {
    harness.database.close();
  }
});

test("profile switch preserves session on same target and creates one on new target", async () => {
  const harness = await createHarness();

  try {
    await harness.resolver.ensureBindingForMessage(inboundMessage());

    const sameTarget = await harness.router.handle(inboundMessage({ text: "/profile review" }));
    expect(responseText(sameTarget)).toContain("Switched profile to Review (review).");
    expect(responseText(sameTarget)).toContain("Current session: session-1");
    expect(responseText(sameTarget)).toContain("Verbosity: tools");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)?.profileId).toBe("review");

    const newTarget = await harness.router.handle(inboundMessage({ text: "/profile ops" }));
    expect(responseText(newTarget)).toContain("Switched profile to Ops (ops).");
    expect(responseText(newTarget)).toContain("Previous session: session-1");
    expect(responseText(newTarget)).toContain("Current session: session-2");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)?.targetId).toBe("ops-target");
  } finally {
    harness.database.close();
  }
});

test("bind command explicitly binds the conversation to a target", async () => {
  const harness = await createHarness();

  try {
    const result = await harness.router.handle(inboundMessage({ text: "/bind ops-target" }));
    const text = responseText(result);

    expect(text).toContain("Bound conversation to Ops workspace (ops-target).");
    expect(text).toContain("Current session: session-1");
    expect(text).toContain("Target source: explicit bind");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)).toMatchObject({
      targetId: "ops-target",
      targetSource: "explicit_bind",
    });
  } finally {
    harness.database.close();
  }
});

test("bind command requires owner or admin access", async () => {
  const harness = await createHarness({
    accessRules: [{ channel: "telegram", accountId: "default", senderId: "123", role: "user" }],
  });

  try {
    const result = await harness.router.handle(inboundMessage({ text: "/bind ops-target" }));

    expect(responseText(result)).toBe("Target binding changes require owner/admin access.");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)).toBeUndefined();
  } finally {
    harness.database.close();
  }
});

test("profile switch preserves an explicit bind from the bind command", async () => {
  const harness = await createHarness();

  try {
    await harness.router.handle(inboundMessage({ text: "/bind ops-target" }));

    const result = await harness.router.handle(inboundMessage({ text: "/profile review" }));
    const text = responseText(result);

    expect(text).toContain("Switched profile to Review (review).");
    expect(text).toContain("Target: Ops workspace (ops-target)");
    expect(text).toContain("Target source: explicit bind");
    expect(text).toContain("Current session: session-1");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)).toMatchObject({
      profileId: "review",
      targetId: "ops-target",
      targetSource: "explicit_bind",
    });
  } finally {
    harness.database.close();
  }
});

test("unbind command clears explicit target binding", async () => {
  const harness = await createHarness();

  try {
    await harness.router.handle(inboundMessage({ text: "/bind ops-target" }));

    const result = await harness.router.handle(inboundMessage({ text: "/unbind" }));
    const text = responseText(result);

    expect(text).toContain("Cleared explicit target bind.");
    expect(text).toContain("Target now follows profile CTO (cto): Default workspace (default).");
    expect(text).toContain("Previous target: Ops workspace (ops-target)");
    expect(text).toContain("Current session: session-2");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)).toMatchObject({
      targetId: "default",
      targetSource: "profile_default",
    });
  } finally {
    harness.database.close();
  }
});

test("profile switch reports binding overrides cleared for the new target", async () => {
  const harness = await createHarness();

  try {
    await harness.router.handle(inboundMessage({ text: "/agent mobile-agent" }));
    await harness.router.handle(inboundMessage({ text: "/model provider/custom-model" }));

    const result = await harness.router.handle(inboundMessage({ text: "/profile ops" }));
    const text = responseText(result);

    expect(text).toContain("Switched profile to Ops (ops).");
    expect(text).toContain("Target: Ops workspace (ops-target)");
    expect(text).toContain("Cleared agent override: mobile-agent is not available on target ops-target.");
    expect(text).toContain("Cleared model override: provider/custom-model is not available on target ops-target.");
    expect(text).toContain("Effective agent: ops-target-agent (target default)");
    expect(text).toContain("Effective model: none");
    expect(harness.repositories.bindings.getByConversationKey(conversationKey)).toMatchObject({
      targetId: "ops-target",
      agent: undefined,
      model: undefined,
    });
  } finally {
    harness.database.close();
  }
});

const conversationKey = "telegram:default:dm:123";

interface Harness {
  database: GatewayDatabase;
  resolver: DispatchResolver;
  router: CommandRouter;
  runtime: FakeRuntime;
  repositories: ReturnType<typeof createRepositories>;
}

async function createHarness(options: { accessRules?: AccessRuleSeed[] } = {}): Promise<Harness> {
  const database = await openGatewayDatabase(":memory:");
  const config = testConfig();
  const runtime = new FakeRuntime();
  const repositories = createRepositories(database);

  runMigrations(database.db, fixedNow);
  seedDatabaseFromConfig(database.db, testSeeds(options.accessRules), fixedNow);

  const resolver = createDispatchResolver({ config, repositories, runtime });
  const turnRunner = createTurnRunner({ runtime, runs: repositories.runs });
  const router = createCommandRouter({
    config,
    repositories,
    resolver,
    runtime,
    turnRunner,
    pendingPermissions: repositories.pendingPermissions,
    getHealth: () => ({ gateway: "healthy", targets: { default: "healthy", "ops-target": "healthy" } }),
  });

  return { database, runtime, repositories, resolver, router };
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
    pendingPermissions: createPendingPermissionRepository(database.db, { now: fixedNow }),
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

function inboundMessage(options: { senderId?: string; text?: string; commandText?: string } = {}): InboundMessage {
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
    commandText: options.commandText,
    attachments: [],
  };
}

function fixedNow(): Date {
  return new Date("2026-01-01T00:00:00.000Z");
}

function responseText(result: Awaited<ReturnType<CommandRouter["handle"]>>): string {
  if (!result.handled) throw new Error("expected command to be handled");
  return result.messages.map((message) => message.text).join("\n");
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

  sessions: RuntimeSession[] = [];
  agents: RuntimeAgent[] = [
    { id: "cto-agent", description: "CTO default" },
    { id: "mobile-agent", description: "Mobile specialist" },
  ];
  models: RuntimeModel[] = [
    { id: "provider/cto-model", providerId: "provider", modelId: "cto-model", name: "CTO model" },
    { id: "provider/custom-model", providerId: "provider", modelId: "custom-model", name: "Custom model" },
  ];
  readonly agentsByTarget = new Map<string, RuntimeAgent[]>([
    ["ops-target", [{ id: "ops-target-agent", description: "Ops target default" }]],
  ]);
  readonly modelsByTarget = new Map<string, RuntimeModel[]>([
    ["ops-target", []],
  ]);
  abortError: Error | undefined;
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

  async sendAsync(input: SendRuntimeMessageInput): Promise<never> {
    throw new Error("FakeRuntime.sendAsync is not implemented in Phase 1 tests");
  }

  async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    throw new Error("FakeRuntime.startTurn is not implemented in command tests");
  }

  async *observe(input: ObserveRuntimeTurnInput): AsyncIterable<never> {
    throw new Error("FakeRuntime.observe is not implemented in Phase 1 tests");
  }

  async abort(input: AbortRuntimeTurnInput): Promise<void> {
    this.calls.abort.push(input);
    if (this.abortError) throw this.abortError;
  }

  async respondToPermission(input: PermissionResponseInput): Promise<void> {
    throw new Error("FakeRuntime.respondToPermission is not implemented in Phase 1 tests");
  }

  async listSessions(input: ListRuntimeSessionsInput): Promise<RuntimeSession[]> {
    this.calls.listSessions.push(input);
    return this.sessions;
  }

  async listAgents(input: ListRuntimeAgentsInput): Promise<RuntimeAgent[]> {
    this.calls.listAgents.push(input);
    return this.agentsByTarget.get(input.target.id) ?? this.agents;
  }

  async listModels(input: ListRuntimeModelsInput): Promise<RuntimeModel[]> {
    this.calls.listModels.push(input);
    return this.modelsByTarget.get(input.target.id) ?? this.models;
  }
}
