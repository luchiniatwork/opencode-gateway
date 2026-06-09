import { createApp } from "./src/app.ts";
import { ConfigError, loadConfig } from "./src/config/load.ts";

const shutdownSignals = ["SIGINT", "SIGTERM"] as const;

type ShutdownSignal = (typeof shutdownSignals)[number];

export async function main(args: string[] = Bun.argv.slice(2)): Promise<number> {
  const [command = "serve", ...rest] = args;

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command !== "serve") {
    console.error(`Unknown command: ${command}`);
    console.error("Run `opencode-gateway help` for usage.");
    return 1;
  }

  const serveOptions = parseServeOptions(rest);

  if (!serveOptions.ok) {
    console.error(serveOptions.error);
    console.error("Run `opencode-gateway help` for usage.");
    return 1;
  }

  let config;

  if (serveOptions.configPath) {
    try {
      config = await loadConfig(serveOptions.configPath);
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(error.message);
        return 1;
      }

      throw error;
    }
  }

  const app = createApp({ config });

  await app.start();
  await waitForShutdownSignal();
  await app.stop();

  return 0;
}

function printHelp(): void {
  console.log(`opencode-gateway

Usage:
  opencode-gateway serve [--config <path>]   Start the gateway service
  opencode-gateway help                      Show this help

Phase 1 MVP starts the configured gateway, channels, OpenCode runtime,
SQLite state, structured logs, and health endpoint.`);
}

type ServeOptionsResult =
  | { ok: true; configPath?: string }
  | { ok: false; error: string };

function parseServeOptions(args: string[]): ServeOptionsResult {
  let configPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg === "--config" || arg === "-c") {
      const next = args[index + 1];

      if (!next || next.startsWith("-")) {
        return { ok: false, error: `${arg} requires a path` };
      }

      if (configPath) {
        return { ok: false, error: "Config path was provided more than once" };
      }

      configPath = next;
      index += 1;
      continue;
    }

    return { ok: false, error: `Unexpected argument for serve: ${arg ?? ""}` };
  }

  return configPath ? { ok: true, configPath } : { ok: true };
}

function waitForShutdownSignal(): Promise<ShutdownSignal> {
  const keepAlive = setInterval(() => undefined, 60_000);

  return new Promise((resolve) => {
    const handlers = new Map<ShutdownSignal, () => void>();

    function cleanup(): void {
      clearInterval(keepAlive);

      for (const [signal, handler] of handlers) {
        process.off(signal, handler);
      }
    }

    for (const signal of shutdownSignals) {
      const handler = (): void => {
        cleanup();
        resolve(signal);
      };

      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  });
}

if (import.meta.main) {
  const exitCode = await main();

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
