import type { GatewayTargetConfig } from "../config/schema.ts";
import type { RuntimeTarget } from "../opencode/types.ts";

export type TargetHealthStatus =
  | "configured"
  | "starting"
  | "healthy"
  | "unhealthy"
  | "restarting"
  | "stopped"
  | "error";

export interface TargetHealthSnapshot {
  id: string;
  name: string;
  mode: GatewayTargetConfig["mode"];
  status: TargetHealthStatus;
  serverUrl?: string;
  startedAt?: string;
  lastProbeAt?: string;
  lastError?: string;
  restartCount?: number;
  pid?: number;
}

export interface ManagedTargetController {
  ensureStarted(target: RuntimeTarget, config: GatewayTargetConfig): Promise<RuntimeTarget>;
  stopAll(): Promise<void>;
}

export interface TargetSupervisor {
  start(): Promise<void>;
  stop(): Promise<void>;
  resolve(target: RuntimeTarget): Promise<RuntimeTarget>;
  probe(targetId: string): Promise<TargetHealthSnapshot>;
  health(): Record<string, TargetHealthSnapshot>;
  recordRuntimeSuccess(targetId: string): void;
  recordRuntimeFailure(targetId: string, error: unknown): void;
}
