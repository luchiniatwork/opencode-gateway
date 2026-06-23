import { createApp } from "../src/app.ts";
import { ConfigError, loadConfig } from "../src/config/load.ts";
import type { GatewayConfig } from "../src/config/schema.ts";
import { openGatewayDatabase, type GatewayDatabase } from "../src/db/client.ts";
import { OpenCodeRuntime } from "../src/opencode/client.ts";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

interface SmokeOptions {
  configPath: string;
  prompt: string;
  openCodeTimeoutMs: number;
  runtimeProbe: boolean;
  serveGateway: boolean;
  permissionSmoke: boolean;
  permissionAlways: boolean;
  permissionTimeoutMs: number;
  gatewayRunTimeoutMs: number;
  reuseSmokeState: boolean;
}

interface PendingPermissionSmokeRow {
  id: string;
  run_id: string;
  status: "pending" | "approved" | "denied" | "expired";
  action_message_receipt_id: string | null;
  created_at: string;
}

interface ConversationBindingSmokeRow {
  id: string;
  conversation_key: string;
  profile_id: string;
  target_id: string;
  opencode_session_id: string;
  updated_at: string;
}

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;

try {
  await main(Bun.argv.slice(2));
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    console.error("Use examples/config.smoke.jsonc as a starting point for a real smoke config.");
    process.exit(1);
  }

  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

async function main(args: string[]): Promise<void> {
  const options = parseArgs(args);
  const config = await loadConfig(options.configPath);

  if (options.permissionAlways) {
    config.interactive.permissions.allowAlways = true;
  }

  if (options.permissionSmoke && !options.reuseSmokeState) {
    config.gateway.databasePath = await createTemporarySmokeDatabasePath();
  }

  if (options.serveGateway) {
    validateTelegramSmokeConfig(config);
    await probeTelegram(config);
  }

  if (options.runtimeProbe) {
    await probeOpenCode(config, options.prompt, options.openCodeTimeoutMs);
  }

  if (options.serveGateway) {
    await serveGatewayForTelegramSmoke(config, options);
  }
}

async function probeTelegram(config: GatewayConfig): Promise<void> {
  const telegram = config.channels.telegram;

  if (!telegram?.token) {
    throw new Error("Real smoke test requires channels.telegram.token");
  }

  const response = await fetch(`https://api.telegram.org/bot${telegram.token}/getMe`);

  if (!response.ok) {
    throw new Error(`Telegram getMe failed (${response.status}: ${response.statusText}). Check TELEGRAM_BOT_TOKEN.`);
  }

  const body = await response.json() as {
    ok?: boolean;
    description?: string;
    result?: { id?: number; username?: string };
  };

  if (!body.ok) {
    throw new Error(`Telegram getMe failed: ${body.description ?? "unknown error"}. Check TELEGRAM_BOT_TOKEN.`);
  }

  const botLabel = body.result?.username ? `@${body.result.username}` : String(body.result?.id ?? "unknown");

  console.log(`Telegram probe passed. Bot: ${botLabel}.`);
}

async function probeOpenCode(config: GatewayConfig, prompt: string, timeoutMs: number): Promise<void> {
  const profile = requiredEntry(config.profiles.entries, config.defaults.profile, "profile");
  const target = requiredEntry(config.opencode.targets, profile.defaultTargetId, "target");
  const runtime = new OpenCodeRuntime({ finalResponseTimeoutMs: timeoutMs });
  const session = await runtime.ensureSession({
    target,
    title: `opencode-gateway smoke ${new Date().toISOString()}`,
    profileId: profile.id,
    agent: profile.defaultAgent ?? target.defaultAgent,
    model: profile.defaultModel ?? target.defaultModel,
  });
  const turn = await runtime.send({
    target,
    sessionId: session.id,
    text: prompt,
    agent: profile.defaultAgent ?? target.defaultAgent,
    model: profile.defaultModel ?? target.defaultModel,
  });

  if (turn.status !== "completed") {
    throw new Error(`OpenCode smoke prompt did not complete: ${turn.status}${turn.text ? `: ${turn.text}` : ""}`);
  }

  const responseText = turn.text?.trim();

  if (!responseText) {
    throw new Error(
      `OpenCode smoke prompt completed without a text response (message: ${turn.id ?? "unknown"}). Check the target model/agent config, or run with --no-runtime-probe to test Telegram only.`,
    );
  }

  console.log(`OpenCode probe passed. Target: ${target.id}. Session: ${session.id}.`);
  console.log(`OpenCode response: ${responseText}`);
}

async function serveGatewayForTelegramSmoke(config: GatewayConfig, options: SmokeOptions): Promise<void> {
  const app = createApp({ config, turnRunTimeoutMs: options.gatewayRunTimeoutMs });

  await app.start();

  try {
    console.log(`Gateway smoke server running. Health: ${app.healthUrl ?? "unavailable"}`);
    console.log(`Gateway smoke database: ${config.gateway.databasePath}`);
    console.log(`Gateway turn timeout: ${options.gatewayRunTimeoutMs}ms`);

    if (options.permissionSmoke) {
      const passed = await runPermissionSmoke(config, options, app.healthUrl).catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        return false;
      });
      if (!passed) {
        console.error("Permission smoke did not complete. Gateway remains running for manual recovery; stop with Ctrl+C when done.");
      }
    } else {
      console.log("Manual Telegram acceptance:");
      console.log("1. From an allowlisted Telegram account, send: /status");
      console.log("2. Send: Reply with exactly: gateway smoke ok");
      console.log("3. Stop this script with Ctrl+C, start it again, then send another normal message.");
      console.log("4. Confirm the second message reuses the existing conversation session in /status.");
    }

    await waitForShutdownSignal();
  } finally {
    await app.stop();
  }
}

async function runPermissionSmoke(config: GatewayConfig, options: SmokeOptions, healthUrl: string | undefined): Promise<boolean> {
  const telegram = config.channels.telegram;
  const senderId = telegram?.allowFrom[0];

  if (!senderId) {
    throw new Error("Permission smoke requires channels.telegram.allowFrom[0] so access rules are seeded");
  }

  const profile = config.profiles.entries.find((entry) => entry.id === "permission-smoke");
  if (!profile) {
    throw new Error("Permission smoke requires a gateway profile with id: permission-smoke");
  }
  const target = requiredEntry(config.opencode.targets, profile.defaultTargetId, "permission smoke target");
  const runtime = new OpenCodeRuntime();

  const database = await openGatewayDatabase(config.gateway.databasePath, { createParentDir: false });
  const conversationKey = `telegram:default:dm:${senderId}`;

  try {
    console.log("");
    console.log("Permission smoke acceptance:");
    console.log(`Preparing Telegram DM binding: ${conversationKey}`);
    await preparePermissionSmokeBinding(database, runtime, config, conversationKey, profile, target, "initial");
    console.log("No /profile or /new command is needed; this smoke script prepares fresh sessions directly.");

    try {
      await runPermissionCase(database, runtime, config, conversationKey, profile, target, options, healthUrl, {
        name: "Approve once button",
        prompt: "Use bash to run: printf 'permission smoke approve once'",
        instruction: "Click the Approve once button on the permission card.",
        expectedStatus: "approved",
      });

      await runPermissionCase(database, runtime, config, conversationKey, profile, target, options, healthUrl, {
        name: "Deny button",
        prompt: "Use bash to run: printf 'permission smoke deny'",
        instruction: "Click the Deny button on the permission card.",
        expectedStatus: "denied",
      });

      await runPermissionCase(database, runtime, config, conversationKey, profile, target, options, healthUrl, {
        name: "Fallback command",
        prompt: "Use bash to run: printf 'permission smoke fallback'",
        instruction: "Type the fallback command shown below after the permission card appears.",
        expectedStatus: "approved",
        fallbackDecision: "approve",
      });

      if (options.permissionAlways) {
        if (!config.interactive.permissions.allowAlways) {
          console.log("Skipping always-allow smoke: interactive.permissions.allowAlways is false.");
        } else {
          await runPermissionCase(database, runtime, config, conversationKey, profile, target, options, healthUrl, {
            name: "Always allow",
            prompt: "Use bash to run: printf 'permission smoke always'",
            instruction: "Click Always allow, or type the fallback command shown below.",
            expectedStatus: "approved",
            fallbackDecision: "always",
          });
        }
      }
    } catch (error) {
      await printPermissionSmokeDiagnostics(database, conversationKey, target, healthUrl);
      throw error;
    }

    console.log("Permission smoke acceptance completed.");
    console.log("You can switch back with: /profile default");
    return true;
  } finally {
    database.close();
  }
}

async function runPermissionCase(
  database: GatewayDatabase,
  runtime: OpenCodeRuntime,
  config: GatewayConfig,
  conversationKey: string,
  profile: GatewayConfig["profiles"]["entries"][number],
  target: GatewayConfig["opencode"]["targets"][number],
  options: SmokeOptions,
  healthUrl: string | undefined,
  input: {
    name: string;
    prompt: string;
    instruction: string;
    expectedStatus: "approved" | "denied";
    fallbackDecision?: "approve" | "always" | "deny";
  },
): Promise<void> {
  const startedAt = new Date().toISOString();

  console.log("");
  console.log(`Permission smoke case: ${input.name}`);
  const sessionId = await preparePermissionSmokeBinding(database, runtime, config, conversationKey, profile, target, input.name);
  console.log(`Prepared fresh OpenCode session: ${sessionId}`);
  console.log(`Send this Telegram message: ${input.prompt}`);

  const permission = await waitForCondition(
    `${input.name} permission card sent`,
    options.permissionTimeoutMs,
    async () => {
      const permission = latestPermissionCard(database, conversationKey, startedAt);
      if (permission) return permission;

      const latestUserText = await latestOpenCodeUserText(target, sessionId);
      if (latestUserText && latestUserText !== input.prompt) {
        return undefined;
      }

      return undefined;
    },
    () => printPermissionSmokeDiagnostics(database, conversationKey, target, healthUrl),
  );

  console.log(`Permission ID: ${permission.id}`);
  if (input.fallbackDecision) {
    console.log(`Fallback command: /permission ${input.fallbackDecision} ${permission.id}`);
  }

  console.log(input.instruction);

  await waitForCondition(
    `${input.name} resolved as ${input.expectedStatus}`,
    options.permissionTimeoutMs,
    async () => permissionStatus(database, permission.id) === input.expectedStatus,
    () => printPermissionSmokeDiagnostics(database, conversationKey, target, healthUrl),
  );
  await waitForCondition(
    `${input.name} run finished`,
    options.permissionTimeoutMs,
    async () => runStatus(database, permission.run_id) !== "active",
    () => printPermissionSmokeDiagnostics(database, conversationKey, target, healthUrl),
  );

  console.log(`${input.name} passed.`);
}

async function preparePermissionSmokeBinding(
  database: GatewayDatabase,
  runtime: OpenCodeRuntime,
  config: GatewayConfig,
  conversationKey: string,
  profile: GatewayConfig["profiles"]["entries"][number],
  target: GatewayConfig["opencode"]["targets"][number],
  label: string,
): Promise<string> {
  finishActiveRunsForConversation(database, conversationKey, `Permission smoke preparing ${label}.`);
  await abortBusyOpenCodeSessions(runtime, target);

  const session = await runtime.ensureSession({
    target,
    title: `permission smoke ${label} ${new Date().toISOString()}`,
    profileId: profile.id,
    agent: profile.defaultAgent ?? target.defaultAgent,
    model: profile.defaultModel ?? target.defaultModel,
  });
  const timestamp = new Date().toISOString();

  database.db
    .query(
      `INSERT INTO conversation_bindings (
        id, conversation_key, channel, account_id, profile_id, target_id, opencode_session_id,
        session_name, agent, model, busy_mode, verbosity, created_at, updated_at
      ) VALUES (?, ?, 'telegram', 'default', ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)
      ON CONFLICT(conversation_key) DO UPDATE SET
        channel = 'telegram',
        account_id = 'default',
        profile_id = excluded.profile_id,
        target_id = excluded.target_id,
        opencode_session_id = excluded.opencode_session_id,
        session_name = excluded.session_name,
        agent = NULL,
        model = NULL,
        busy_mode = excluded.busy_mode,
        verbosity = excluded.verbosity,
        updated_at = excluded.updated_at`,
    )
    .run(
      crypto.randomUUID(),
      conversationKey,
      profile.id,
      target.id,
      session.id,
      session.title ?? null,
      profile.defaults.busyMode ?? config.defaults.busyMode,
      profile.defaults.verbosity ?? config.defaults.verbosity,
      timestamp,
      timestamp,
    );

  return session.id;
}

async function abortBusyOpenCodeSessions(
  runtime: OpenCodeRuntime,
  target: GatewayConfig["opencode"]["targets"][number],
): Promise<void> {
  const statuses = await fetchOpenCodeSessionStatuses(target).catch(() => ({}));
  const busySessionIds = Object.entries(statuses)
    .filter(([, status]) => status.type !== "idle")
    .map(([sessionId]) => sessionId);

  if (busySessionIds.length === 0) return;

  console.log(`Aborting ${busySessionIds.length} busy OpenCode session(s) before permission smoke: ${busySessionIds.join(", ")}`);

  for (const sessionId of busySessionIds) {
    await runtime.abort({ target, sessionId, reason: "Permission smoke preparing a fresh case" }).catch((error) => {
      console.warn(`Unable to abort busy OpenCode session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

function finishActiveRunsForConversation(database: GatewayDatabase, conversationKey: string, error: string): void {
  database.db
    .query(
      `UPDATE runs SET
        status = 'aborted',
        error = ?,
        finished_at = ?
      WHERE status = 'active'
        AND binding_id IN (SELECT id FROM conversation_bindings WHERE conversation_key = ?)`,
    )
    .run(error, new Date().toISOString(), conversationKey);
}

function latestPermissionCard(
  database: GatewayDatabase,
  conversationKey: string,
  startedAt: string,
): PendingPermissionSmokeRow | undefined {
  const row = database.db
    .query(
      `SELECT p.id, p.run_id, p.status, p.action_message_receipt_id, p.created_at
      FROM pending_permissions p
      JOIN runs r ON r.id = p.run_id
      JOIN conversation_bindings b ON b.id = r.binding_id
      WHERE b.conversation_key = ?
        AND p.created_at >= ?
        AND p.status = 'pending'
        AND p.action_message_receipt_id IS NOT NULL
      ORDER BY p.created_at DESC, p.id DESC
      LIMIT 1`,
    )
    .get(conversationKey, startedAt) as PendingPermissionSmokeRow | null;

  return row ?? undefined;
}

function permissionStatus(database: GatewayDatabase, permissionId: string): PendingPermissionSmokeRow["status"] | undefined {
  const row = database.db
    .query("SELECT status FROM pending_permissions WHERE id = ?")
    .get(permissionId) as { status: PendingPermissionSmokeRow["status"] } | null;

  return row?.status;
}

function runStatus(database: GatewayDatabase, runId: string): string | undefined {
  const row = database.db.query("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string } | null;

  return row?.status;
}

async function printPermissionSmokeDiagnostics(
  database: GatewayDatabase,
  conversationKey: string,
  target: GatewayConfig["opencode"]["targets"][number],
  healthUrl: string | undefined,
): Promise<void> {
  printPermissionSmokeDatabaseDiagnostics(database, conversationKey);

  const binding = permissionSmokeBinding(database, conversationKey);
  if (binding) {
    await printRecentOpenCodeMessages(target, binding.opencode_session_id);
  }

  await printOpenCodeSessionStatuses(target);

  if (!healthUrl) return;

  try {
    const response = await fetch(healthUrl);
    const body = await response.text();

    console.error(`- Gateway health (${response.status}): ${body}`);
  } catch (error) {
    console.error(`- Gateway health: unavailable (${error instanceof Error ? error.message : String(error)})`);
  }
}

async function printOpenCodeSessionStatuses(target: GatewayConfig["opencode"]["targets"][number]): Promise<void> {
  const statuses = await fetchOpenCodeSessionStatuses(target).catch((error) => {
    console.error(`- OpenCode statuses: unavailable (${error instanceof Error ? error.message : String(error)})`);
    return undefined;
  });

  if (!statuses) return;

  const entries = Object.entries(statuses).map(([sessionId, status]) => `${sessionId}:${status.type}`);
  console.error(`- OpenCode statuses: ${entries.length > 0 ? entries.join(" | ") : "none"}`);
}

async function fetchOpenCodeSessionStatuses(
  target: GatewayConfig["opencode"]["targets"][number],
): Promise<Record<string, { type: string }>> {
  if (!target.serverUrl) return {};

  const url = new URL("/session/status", target.serverUrl.endsWith("/") ? target.serverUrl : `${target.serverUrl}/`);
  if (target.workdir) url.searchParams.set("directory", target.workdir);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);

  const body = await response.json();
  return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, { type: string }> : {};
}

function permissionSmokeBinding(database: GatewayDatabase, conversationKey: string): { opencode_session_id: string } | undefined {
  const row = database.db
    .query("SELECT opencode_session_id FROM conversation_bindings WHERE conversation_key = ?")
    .get(conversationKey) as { opencode_session_id: string } | null;

  return row ?? undefined;
}

async function latestOpenCodeUserText(target: GatewayConfig["opencode"]["targets"][number], sessionId: string): Promise<string | undefined> {
  const messages = await fetchOpenCodeMessages(target, sessionId).catch(() => []);
  const latestUser = [...messages].reverse().find((message) => message.info?.role === "user");

  return latestUser ? messageText(latestUser) : undefined;
}

async function printRecentOpenCodeMessages(target: GatewayConfig["opencode"]["targets"][number], sessionId: string): Promise<void> {
  const messages = await fetchOpenCodeMessages(target, sessionId).catch((error) => {
    console.error(`- OpenCode messages: unavailable (${error instanceof Error ? error.message : String(error)})`);
    return [];
  });
  const recent = messages.slice(-5).map((message) => {
    const text = oneLine(messageText(message));
    const agent = message.info?.agent ? ` agent=${message.info.agent}` : "";
    const finish = message.info?.finish ? ` finish=${message.info.finish}` : "";

    return `${message.info?.role ?? "unknown"}:${message.info?.id ?? "unknown"}${agent}${finish} text=${text || "none"}`;
  });

  console.error(`- Recent OpenCode messages: ${recent.length > 0 ? recent.join(" | ") : "none"}`);
}

async function fetchOpenCodeMessages(
  target: GatewayConfig["opencode"]["targets"][number],
  sessionId: string,
): Promise<Array<{ info?: { id?: string; role?: string; agent?: string; finish?: string }; parts?: Array<{ type?: string; text?: string }> }>> {
  if (!target.serverUrl) return [];

  const url = new URL(`/session/${encodeURIComponent(sessionId)}/message`, target.serverUrl.endsWith("/") ? target.serverUrl : `${target.serverUrl}/`);
  if (target.workdir) url.searchParams.set("directory", target.workdir);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);

  const body = await response.json();
  return Array.isArray(body) ? body : [];
}

function messageText(message: { parts?: Array<{ type?: string; text?: string }> }): string {
  return (message.parts ?? [])
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").slice(0, 160);
}

function printPermissionSmokeDatabaseDiagnostics(database: GatewayDatabase, conversationKey: string): void {
  const binding = database.db
    .query(
      `SELECT id, profile_id, target_id, opencode_session_id, busy_mode, verbosity
      FROM conversation_bindings
      WHERE conversation_key = ?`,
    )
    .get(conversationKey) as { id: string; profile_id: string; target_id: string; opencode_session_id: string; busy_mode: string; verbosity: string } | null;
  const runs = database.db
    .query(
      `SELECT r.id, r.status, r.error, r.opencode_message_id
      FROM runs r
      JOIN conversation_bindings b ON b.id = r.binding_id
      WHERE b.conversation_key = ?
      ORDER BY r.started_at DESC
      LIMIT 5`,
    )
    .all(conversationKey) as Array<{ id: string; status: string; error: string | null; opencode_message_id: string | null }>;
  const permissions = database.db
    .query(
      `SELECT p.id, p.run_id, p.status, p.action_message_receipt_id, p.created_at, p.expires_at
      FROM pending_permissions p
      JOIN runs r ON r.id = p.run_id
      JOIN conversation_bindings b ON b.id = r.binding_id
      WHERE b.conversation_key = ?
      ORDER BY p.created_at DESC
      LIMIT 5`,
    )
    .all(conversationKey) as Array<{ id: string; run_id: string; status: string; action_message_receipt_id: string | null; created_at: string; expires_at: string }>;

  console.error("Permission smoke diagnostics:");
  console.error(`- Binding: ${binding ? `${binding.id} profile=${binding.profile_id} target=${binding.target_id} session=${binding.opencode_session_id} busy=${binding.busy_mode} verbosity=${binding.verbosity}` : "none"}`);
  console.error(`- Recent runs: ${runs.length > 0 ? runs.map((run) => `${run.id} status=${run.status} message=${run.opencode_message_id ?? "none"} error=${run.error ?? "none"}`).join(" | ") : "none"}`);
  console.error(`- Recent permissions: ${permissions.length > 0 ? permissions.map((permission) => `${permission.id} run=${permission.run_id} status=${permission.status} receipt=${permission.action_message_receipt_id ?? "none"} created=${permission.created_at} expires=${permission.expires_at}`).join(" | ") : "none"}`);
  console.error("Recovery commands in Telegram: /stop, then /new, then /profile default if you want to leave smoke mode.");
}

async function createTemporarySmokeDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "opencode-gateway-smoke-"));
  return join(directory, "state.db");
}

async function waitForCondition<T>(
  label: string,
  timeoutMs: number,
  fn: () => Promise<T | false | undefined> | T | false | undefined,
  onStillWaiting?: () => Promise<void> | void,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let nextStillWaitingLogAt = Date.now() + 10_000;

  do {
    const result = await fn();
    if (result) return result;
    if (onStillWaiting && Date.now() >= nextStillWaitingLogAt) {
      await onStillWaiting();
      nextStillWaitingLogAt = Date.now() + 10_000;
    }
    await Bun.sleep(500);
  } while (Date.now() < deadline);

  throw new Error(`Timed out waiting for ${label} after ${timeoutMs}ms`);
}

function validateTelegramSmokeConfig(config: GatewayConfig): void {
  const telegram = config.channels.telegram;

  if (!telegram?.enabled) {
    throw new Error("Real smoke test requires channels.telegram.enabled = true");
  }

  if (!telegram.token) {
    throw new Error("Real smoke test requires channels.telegram.token");
  }

  if (telegram.allowFrom.length === 0) {
    throw new Error("Real smoke test requires at least one channels.telegram.allowFrom sender id");
  }
}

function requiredEntry<T extends { id: string }>(entries: T[], id: string, label: string): T {
  const entry = entries.find((candidate) => candidate.id === id);

  if (!entry) {
    throw new Error(`Configured smoke ${label} not found: ${id}`);
  }

  return entry;
}

function parseArgs(args: string[]): SmokeOptions {
  let configPath: string | undefined;
  let prompt = "Reply with exactly: opencode-gateway smoke ok";
  let openCodeTimeoutMs = 15_000;
  let runtimeProbe = true;
  let serveGateway = true;
  let permissionSmoke = false;
  let permissionAlways = false;
  let permissionTimeoutMs = 120_000;
  let gatewayRunTimeoutMs = 60_000;
  let reuseSmokeState = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--config" || arg === "-c") {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) usage(`${arg} requires a path`);
      configPath = next;
      index += 1;
      continue;
    }

    if (arg === "--prompt") {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) usage("--prompt requires text");
      prompt = next;
      index += 1;
      continue;
    }

    if (arg === "--no-runtime-probe") {
      runtimeProbe = false;
      continue;
    }

    if (arg === "--opencode-timeout-ms") {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) usage("--opencode-timeout-ms requires a number");
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 0) usage("--opencode-timeout-ms must be a non-negative integer");
      openCodeTimeoutMs = parsed;
      index += 1;
      continue;
    }

    if (arg === "--no-serve") {
      serveGateway = false;
      continue;
    }

    if (arg === "--permission-smoke") {
      permissionSmoke = true;
      continue;
    }

    if (arg === "--permission-always") {
      permissionAlways = true;
      continue;
    }

    if (arg === "--permission-timeout-ms") {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) usage("--permission-timeout-ms requires a number");
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 0) usage("--permission-timeout-ms must be a non-negative integer");
      permissionTimeoutMs = parsed;
      index += 1;
      continue;
    }

    if (arg === "--gateway-run-timeout-ms") {
      const next = args[index + 1];
      if (!next || next.startsWith("-")) usage("--gateway-run-timeout-ms requires a number");
      const parsed = Number(next);
      if (!Number.isInteger(parsed) || parsed < 0) usage("--gateway-run-timeout-ms must be a non-negative integer");
      gatewayRunTimeoutMs = parsed;
      index += 1;
      continue;
    }

    if (arg === "--reuse-smoke-state") {
      reuseSmokeState = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      usage();
    }

    usage(`Unexpected argument: ${arg ?? ""}`);
  }

  if (!configPath) usage("--config is required");

  return { configPath, prompt, openCodeTimeoutMs, runtimeProbe, serveGateway, permissionSmoke, permissionAlways, permissionTimeoutMs, gatewayRunTimeoutMs, reuseSmokeState };
}

function usage(error?: string): never {
  if (error) console.error(error);
  console.error(`Usage:
  bun run smoke:real -- --config <path> [--prompt <text>] [--opencode-timeout-ms <ms>] [--no-runtime-probe] [--no-serve] [--permission-smoke] [--permission-always] [--permission-timeout-ms <ms>] [--gateway-run-timeout-ms <ms>] [--reuse-smoke-state]

Checks a real config, validates Telegram getMe, optionally sends a real OpenCode
prompt through the SDK wrapper, then starts the gateway for a manual Telegram DM
acceptance test. With --permission-smoke, it guides a Telegram permission card,
callback approve/deny, and /permission fallback acceptance flow.`);
  process.exit(error ? 1 : 0);
}

function waitForShutdownSignal(): Promise<void> {
  const keepAlive = setInterval(() => undefined, 60_000);

  return new Promise((resolve) => {
    const handlers = new Map<(typeof shutdownSignals)[number], () => void>();

    function cleanup(): void {
      clearInterval(keepAlive);

      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    }

    for (const signal of shutdownSignals) {
      const handler = (): void => {
        cleanup();
        resolve();
      };

      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  });
}
