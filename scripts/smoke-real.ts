import { createApp } from "../src/app.ts";
import { ConfigError, loadConfig } from "../src/config/load.ts";
import type { GatewayConfig } from "../src/config/schema.ts";
import { OpenCodeRuntime } from "../src/opencode/client.ts";

interface SmokeOptions {
  configPath: string;
  prompt: string;
  openCodeTimeoutMs: number;
  runtimeProbe: boolean;
  serveGateway: boolean;
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

  if (options.serveGateway) {
    validateTelegramSmokeConfig(config);
    await probeTelegram(config);
  }

  if (options.runtimeProbe) {
    await probeOpenCode(config, options.prompt, options.openCodeTimeoutMs);
  }

  if (options.serveGateway) {
    await serveGatewayForTelegramSmoke(config);
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

async function serveGatewayForTelegramSmoke(config: GatewayConfig): Promise<void> {
  const app = createApp({ config });

  await app.start();

  console.log(`Gateway smoke server running. Health: ${app.healthUrl ?? "unavailable"}`);
  console.log("Manual Telegram acceptance:");
  console.log("1. From an allowlisted Telegram account, send: /status");
  console.log("2. Send: Reply with exactly: gateway smoke ok");
  console.log("3. Stop this script with Ctrl+C, start it again, then send another normal message.");
  console.log("4. Confirm the second message reuses the existing conversation session in /status.");

  await waitForShutdownSignal();
  await app.stop();
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

    if (arg === "--help" || arg === "-h") {
      usage();
    }

    usage(`Unexpected argument: ${arg ?? ""}`);
  }

  if (!configPath) usage("--config is required");

  return { configPath, prompt, openCodeTimeoutMs, runtimeProbe, serveGateway };
}

function usage(error?: string): never {
  if (error) console.error(error);
  console.error(`Usage:
  bun run smoke:real -- --config <path> [--prompt <text>] [--opencode-timeout-ms <ms>] [--no-runtime-probe] [--no-serve]

Checks a real config, validates Telegram getMe, optionally sends a real OpenCode
prompt through the SDK wrapper, then starts the gateway for a manual Telegram DM
acceptance test.`);
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
