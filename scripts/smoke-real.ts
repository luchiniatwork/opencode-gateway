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
      const passed = await runPermissionSmoke(config, options).catch((error) => {
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

async function runPermissionSmoke(config: GatewayConfig, options: SmokeOptions): Promise<boolean> {
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
      await runPermissionCase(database, runtime, config, conversationKey, profile, target, options, {
        name: "Approve once button",
        prompt: "Use bash to run: printf 'permission smoke approve once'",
        instruction: "Click the Approve once button on the permission card.",
        expectedStatus: "approved",
      });

      await runPermissionCase(database, runtime, config, conversationKey, profile, target, options, {
        name: "Deny button",
        prompt: "Use bash to run: printf 'permission smoke deny'",
        instruction: "Click the Deny button on the permission card.",
        expectedStatus: "denied",
      });

      await runPermissionCase(database, runtime, config, conversationKey, profile, target, options, {
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
          await runPermissionCase(database, runtime, config, conversationKey, profile, target, options, {
            name: "Always allow",
            prompt: "Use bash to run: printf 'permission smoke always'",
            instruction: "Click Always allow, or type the fallback command shown below.",
            expectedStatus: "approved",
            fallbackDecision: "always",
          });
        }
      }
    } catch (error) {
      printPermissionSmokeDiagnostics(database, conversationKey);
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
    async () => latestPermissionCard(database, conversationKey, startedAt),
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
  );
  await waitForCondition(
    `${input.name} run finished`,
    options.permissionTimeoutMs,
    async () => runStatus(database, permission.run_id) !== "active",
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

function printPermissionSmokeDiagnostics(database: GatewayDatabase, conversationKey: string): void {
  const binding = database.db
    .query(
      `SELECT id, profile_id, opencode_session_id
      FROM conversation_bindings
      WHERE conversation_key = ?`,
    )
    .get(conversationKey) as { id: string; profile_id: string; opencode_session_id: string } | null;
  const run = database.db
    .query(
      `SELECT r.id, r.status, r.error, r.opencode_message_id
      FROM runs r
      JOIN conversation_bindings b ON b.id = r.binding_id
      WHERE b.conversation_key = ?
      ORDER BY r.started_at DESC
      LIMIT 1`,
    )
    .get(conversationKey) as { id: string; status: string; error: string | null; opencode_message_id: string | null } | null;
  const permission = database.db
    .query(
      `SELECT p.id, p.status, p.action_message_receipt_id, p.created_at
      FROM pending_permissions p
      JOIN runs r ON r.id = p.run_id
      JOIN conversation_bindings b ON b.id = r.binding_id
      WHERE b.conversation_key = ?
      ORDER BY p.created_at DESC
      LIMIT 1`,
    )
    .get(conversationKey) as { id: string; status: string; action_message_receipt_id: string | null; created_at: string } | null;

  console.error("Permission smoke diagnostics:");
  console.error(`- Binding: ${binding ? `${binding.id} profile=${binding.profile_id} session=${binding.opencode_session_id}` : "none"}`);
  console.error(`- Latest run: ${run ? `${run.id} status=${run.status} message=${run.opencode_message_id ?? "none"} error=${run.error ?? "none"}` : "none"}`);
  console.error(`- Latest permission: ${permission ? `${permission.id} status=${permission.status} receipt=${permission.action_message_receipt_id ?? "none"}` : "none"}`);
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
  onStillWaiting?: () => void,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let nextStillWaitingLogAt = Date.now() + 10_000;

  do {
    const result = await fn();
    if (result) return result;
    if (onStillWaiting && Date.now() >= nextStillWaitingLogAt) {
      onStillWaiting();
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
