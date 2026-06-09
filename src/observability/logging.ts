import type { LogLevel } from "../config/schema.ts";

export type GatewayLogLevel = LogLevel;

export interface GatewayLogEntry {
  timestamp: string;
  level: GatewayLogLevel;
  component: string;
  message: string;
  source?: "channel" | "gateway" | "runtime" | "webhook" | "cron" | "tool" | (string & {});
  channel?: string;
  accountId?: string;
  conversationKey?: string;
  profileId?: string;
  targetId?: string;
  sessionId?: string;
  runId?: string;
  error?: string;
  [key: string]: unknown;
}

export type GatewayLogSink = (entry: GatewayLogEntry) => void;

export type GatewayLogContext = Omit<GatewayLogEntry, "timestamp" | "level" | "component" | "message">;

export interface JsonLogSinkOptions {
  level?: GatewayLogLevel;
}

const levelPriority: Record<GatewayLogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export function shouldLog(entryLevel: GatewayLogLevel, configuredLevel: GatewayLogLevel): boolean {
  return levelPriority[entryLevel] >= levelPriority[configuredLevel];
}

export function createJsonLogSink(options: JsonLogSinkOptions = {}): GatewayLogSink {
  const configuredLevel = options.level ?? "info";

  return (entry): void => {
    if (!shouldLog(entry.level, configuredLevel)) return;

    console.log(JSON.stringify(redactLogEntry(entry)));
  };
}

export function redactLogEntry(entry: GatewayLogEntry): GatewayLogEntry {
  return Object.fromEntries(
    Object.entries(entry).map(([key, value]) => [key, isSensitiveKey(key) ? "[redacted]" : value]),
  ) as GatewayLogEntry;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();

  return normalized.includes("token") || normalized.includes("secret") || normalized.includes("password");
}
