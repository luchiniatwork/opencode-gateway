import { createApp } from "./src/app.ts";

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

  if (rest.length > 0) {
    console.error(`Unexpected arguments for serve: ${rest.join(" ")}`);
    console.error("Run `opencode-gateway help` for usage.");
    return 1;
  }

  const app = createApp();

  await app.start();
  await waitForShutdownSignal();
  await app.stop();

  return 0;
}

function printHelp(): void {
  console.log(`opencode-gateway

Usage:
  opencode-gateway serve   Start the gateway service
  opencode-gateway help    Show this help

Phase 1 slice #1 provides the process bootstrap only. Config, database,
channels, and OpenCode runtime wiring are added in later slices.`);
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
