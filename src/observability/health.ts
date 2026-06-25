import type { GatewayConfig } from "../config/schema.ts";

export type GatewayHealthStatus = "healthy" | "unhealthy" | "unknown" | "configured" | (string & {});

export type ChannelHealthStatus = "configured" | "running" | "stopped" | "error" | (string & {});

export interface GatewayHealthSnapshot {
  ok: boolean;
  version: string;
  gateway: GatewayHealthStatus;
  channels: Record<string, ChannelHealthStatus>;
  opencodeTargets: Record<string, GatewayHealthStatus>;
  profiles: {
    default: string;
    active: string[];
  };
  runtime?: GatewayRuntimeHealthSnapshot;
}

export interface GatewayRuntimeHealthSnapshot {
  activeRunCount: number;
  queuedTurnCount: number;
  queuedBindingCount: number;
  pendingPermissionCount: number;
  activeRuns: Array<{
    id: string;
    bindingId: string;
    sessionId: string;
    opencodeMessageId?: string;
    startedAt: string;
  }>;
  queuedTurns: Array<{
    bindingId: string;
    size: number;
    oldestEnqueuedAt?: string;
    oldestAgeMs?: number;
  }>;
  pendingPermissions: Array<{
    id: string;
    runId: string;
    opencodePermissionId: string;
    hasActionMessageReceipt: boolean;
    expiresAt: string;
  }>;
}

export interface CreateHealthSnapshotInput {
  config?: GatewayConfig;
  started: boolean;
  channelStatuses?: Record<string, ChannelHealthStatus>;
  runtime?: GatewayRuntimeHealthSnapshot;
  version?: string;
}

export const gatewayVersion = "0.1.0";

export function createHealthSnapshot(input: CreateHealthSnapshotInput): GatewayHealthSnapshot {
  const channelStatuses = input.channelStatuses ?? {};
  const gateway: GatewayHealthStatus = input.started ? "healthy" : input.config ? "configured" : "unknown";

  return {
    ok: gateway !== "unhealthy" && Object.values(channelStatuses).every((status) => status !== "error"),
    version: input.version ?? gatewayVersion,
    gateway,
    channels: channelStatuses,
    opencodeTargets: targetHealth(input.config),
    profiles: profileHealth(input.config),
    runtime: input.runtime,
  };
}

function targetHealth(config: GatewayConfig | undefined): Record<string, GatewayHealthStatus> {
  if (!config) return {};

  return Object.fromEntries(config.opencode.targets.map((target) => [target.id, "configured"]));
}

function profileHealth(config: GatewayConfig | undefined): GatewayHealthSnapshot["profiles"] {
  if (!config) return { default: "", active: [] };

  return {
    default: config.profiles.default,
    active: config.profiles.entries.map((profile) => profile.id),
  };
}
