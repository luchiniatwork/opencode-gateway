import type { GatewayConfig } from "./config/schema.ts";

export type GatewayLogLevel = "info" | "warn" | "error";

export interface GatewayLogEntry {
  timestamp: string;
  level: GatewayLogLevel;
  component: string;
  message: string;
}

export interface GatewayAppStatus {
  started: boolean;
  configLoaded: boolean;
}

export interface GatewayApp {
  readonly status: GatewayAppStatus;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface GatewayAppOptions {
  config?: GatewayConfig;
  logger?: (entry: GatewayLogEntry) => void;
  now?: () => Date;
}

export function createApp(options: GatewayAppOptions = {}): GatewayApp {
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => new Date());
  let started = false;

  function log(level: GatewayLogLevel, message: string): void {
    logger({
      timestamp: now().toISOString(),
      level,
      component: "app",
      message,
    });
  }

  return {
    get status(): GatewayAppStatus {
      return { started, configLoaded: Boolean(options.config) };
    },

    async start(): Promise<void> {
      if (started) return;

      started = true;
      log("info", "opencode-gateway starting");
    },

    async stop(): Promise<void> {
      if (!started) return;

      started = false;
      log("info", "opencode-gateway stopped");
    },
  };
}

function defaultLogger(entry: GatewayLogEntry): void {
  console.log(JSON.stringify(entry));
}
