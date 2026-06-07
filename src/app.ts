import { getConfigSeeds } from "./config/load.ts";
import type { GatewayConfig } from "./config/schema.ts";
import { openGatewayDatabase, type GatewayDatabase } from "./db/client.ts";
import { runMigrations } from "./db/migrations.ts";
import { seedDatabaseFromConfig } from "./db/repositories/seeds.ts";

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
  databaseConnected: boolean;
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
  let database: GatewayDatabase | undefined;

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
      return {
        started,
        configLoaded: Boolean(options.config),
        databaseConnected: Boolean(database),
      };
    },

    async start(): Promise<void> {
      if (started) return;

      if (options.config) {
        const openedDatabase = await openGatewayDatabase(options.config.gateway.databasePath);

        try {
          runMigrations(openedDatabase.db, now);
          seedDatabaseFromConfig(openedDatabase.db, getConfigSeeds(options.config), now);
          database = openedDatabase;
        } catch (error) {
          openedDatabase.close();
          throw error;
        }
      }

      started = true;
      log("info", "opencode-gateway starting");
    },

    async stop(): Promise<void> {
      if (!started) return;

      started = false;
      database?.close();
      database = undefined;
      log("info", "opencode-gateway stopped");
    },
  };
}

function defaultLogger(entry: GatewayLogEntry): void {
  console.log(JSON.stringify(entry));
}
