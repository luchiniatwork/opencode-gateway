import type { GatewayConfig } from "../config/schema.ts";
import type { TargetHealthSnapshot } from "../targets/types.ts";
import { sanitizeDiagnosticUrl } from "./sanitize.ts";

export type GatewayHealthStatus = "healthy" | "unhealthy" | "unknown" | "configured" | (string & {});

export type ChannelHealthStatus = "configured" | "running" | "stopped" | "error" | (string & {});

export type OpenCodeTargetHealth = TargetHealthSnapshot;

export interface GatewayHealthSnapshot {
  ok: boolean;
  degraded: boolean;
  degradedReasons: string[];
  version: string;
  gateway: GatewayHealthStatus;
  channels: Record<string, ChannelHealthStatus>;
  opencodeTargets: Record<string, OpenCodeTargetHealth>;
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
    targetId?: string;
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
  targetHealth?: Record<string, TargetHealthSnapshot>;
  runtime?: GatewayRuntimeHealthSnapshot;
  version?: string;
}

export const gatewayVersion = "0.1.0";

export function createHealthSnapshot(input: CreateHealthSnapshotInput): GatewayHealthSnapshot {
  const channelStatuses = input.channelStatuses ?? {};
  const gateway: GatewayHealthStatus = input.started ? "healthy" : input.config ? "configured" : "unknown";
  const opencodeTargets = targetHealth(input.config, input.targetHealth, input.runtime);
  const ok = gateway !== "unhealthy" && Object.values(channelStatuses).every((status) => status !== "error");
  const degradedReasons = healthDegradedReasons({
    ok,
    channelStatuses,
    opencodeTargets,
    config: input.config,
  });

  return {
    ok,
    degraded: degradedReasons.length > 0,
    degradedReasons,
    version: input.version ?? gatewayVersion,
    gateway,
    channels: channelStatuses,
    opencodeTargets,
    profiles: profileHealth(input.config),
    runtime: input.runtime,
  };
}

function targetHealth(
  config: GatewayConfig | undefined,
  health: Record<string, TargetHealthSnapshot> | undefined,
  runtime: GatewayRuntimeHealthSnapshot | undefined,
): Record<string, OpenCodeTargetHealth> {
  if (!config) return {};

  const activeRunCounts = activeRunCountsByTarget(runtime);

  return Object.fromEntries(config.opencode.targets.map((target) => {
    const snapshot = health?.[target.id] ?? {
      id: target.id,
      name: target.name,
      mode: target.mode,
      status: "configured" as const,
      serverUrl: target.serverUrl,
    };

    return [
      target.id,
      {
        ...snapshot,
        serverUrl: sanitizeDiagnosticUrl(snapshot.serverUrl),
        activeRunCount: activeRunCounts[target.id] ?? 0,
      },
    ];
  }));
}

function profileHealth(config: GatewayConfig | undefined): GatewayHealthSnapshot["profiles"] {
  if (!config) return { default: "", active: [] };

  return {
    default: config.profiles.default,
    active: config.profiles.entries.map((profile) => profile.id),
  };
}

function activeRunCountsByTarget(runtime: GatewayRuntimeHealthSnapshot | undefined): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const run of runtime?.activeRuns ?? []) {
    if (!run.targetId) continue;
    counts[run.targetId] = (counts[run.targetId] ?? 0) + 1;
  }

  return counts;
}

function healthDegradedReasons(input: {
  ok: boolean;
  channelStatuses: Record<string, ChannelHealthStatus>;
  opencodeTargets: Record<string, TargetHealthSnapshot>;
  config?: GatewayConfig;
}): string[] {
  const reasons: string[] = [];

  if (!input.ok) reasons.push("gateway liveness check failed");

  for (const [channel, status] of Object.entries(input.channelStatuses)) {
    if (status === "error") reasons.push(`channel ${channel} is in error`);
  }

  const defaultProfile = input.config?.profiles.entries.find((profile) => profile.id === input.config?.profiles.default);
  const defaultTargetId = defaultProfile?.defaultTargetId;
  const defaultTarget = defaultTargetId ? input.opencodeTargets[defaultTargetId] : undefined;

  if (defaultTarget && isDegradedTargetStatus(defaultTarget.status)) {
    reasons.push(`default profile target ${defaultTarget.id} is ${targetStatusReason(defaultTarget)}`);
  }

  for (const target of Object.values(input.opencodeTargets)) {
    if (target.id === defaultTargetId) continue;
    if (target.status === "unhealthy" || target.status === "error" || target.status === "restarting") {
      reasons.push(`target ${target.id} is ${targetStatusReason(target)}`);
    }
  }

  return reasons;
}

function isDegradedTargetStatus(status: TargetHealthSnapshot["status"]): boolean {
  return status === "unhealthy" || status === "error" || status === "restarting" || status === "stopped";
}

function targetStatusReason(target: TargetHealthSnapshot): string {
  return target.lastError ? `${target.status}: ${target.lastError}` : target.status;
}
