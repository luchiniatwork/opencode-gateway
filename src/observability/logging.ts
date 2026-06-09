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
  return redactValue(entry, undefined, new WeakSet()) as GatewayLogEntry;
}

function redactValue(value: unknown, key: string | undefined, seen: WeakSet<object>): unknown {
  if (key && isSensitiveKey(key)) return "[redacted]";
  if (!value || typeof value !== "object") return value;

  if (seen.has(value)) return "[circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const redacted = value.map((entry) => redactValue(entry, undefined, seen));
    seen.delete(value);
    return redacted;
  }

  const redacted = Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactValue(entryValue, entryKey, seen),
    ]),
  );
  seen.delete(value);
  return redacted;
}

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");

  return (
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("password") ||
    normalized.includes("authorization") ||
    normalized.includes("credential") ||
    normalized.includes("cookie") ||
    normalized.includes("apikey") ||
    normalized.includes("privatekey")
  );
}
