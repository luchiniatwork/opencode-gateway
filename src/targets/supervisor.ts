import type { GatewayTargetConfig } from "../config/schema.ts";
import type { GatewayLogContext, GatewayLogLevel } from "../observability/logging.ts";
import { sanitizeDiagnosticUrl } from "../observability/sanitize.ts";
import type { AgentRuntime, RuntimeTarget } from "../opencode/types.ts";
import { TargetUnavailableError } from "./errors.ts";
import type { ManagedTargetController, TargetHealthSnapshot, TargetSupervisor } from "./types.ts";

export interface TargetSupervisorOptions {
  targets: GatewayTargetConfig[];
  runtime: AgentRuntime;
  managedController?: ManagedTargetController;
  now?: () => Date;
  log?: (level: GatewayLogLevel, message: string, context?: GatewayLogContext) => void;
}

export function createTargetSupervisor(options: TargetSupervisorOptions): TargetSupervisor {
  const now = options.now ?? (() => new Date());
  const configuredTargets = new Map(options.targets.map((target) => [target.id, target]));
  const snapshots = new Map<string, TargetHealthSnapshot>();
  let started = false;

  for (const target of options.targets) {
    snapshots.set(target.id, initialSnapshot(target));
  }

  function log(level: GatewayLogLevel, message: string, context: GatewayLogContext = {}): void {
    options.log?.(level, message, { component: "targets", ...context });
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      started = true;

      for (const target of options.targets) {
        if (target.mode === "attach") {
          await this.probe(target.id).catch((error) => {
            mark(target.id, { status: "unhealthy", lastProbeAt: timestamp(), lastError: summarizeError(error) });
          });
          continue;
        }

        mark(target.id, { status: target.serverUrl ? "configured" : "stopped" });
      }
    },

    async stop(): Promise<void> {
      started = false;
      await options.managedController?.stopAll();

      for (const target of options.targets) {
        if (target.mode === "managed") mark(target.id, { status: "stopped" });
      }
    },

    async resolve(target): Promise<RuntimeTarget> {
      const configTarget = configuredTargets.get(target.id);
      const effectiveTarget = toRuntimeTarget(target, configTarget);

      if (target.mode === "attach") {
        if (!effectiveTarget.serverUrl) {
          const message = `OpenCode target ${target.id} is missing serverUrl`;
          mark(target.id, { status: "error", lastError: message });
          throw new TargetUnavailableError(target.id, message);
        }

        return effectiveTarget;
      }

      if (target.mode === "managed") {
        if (options.managedController && configTarget) {
          try {
            mark(target.id, { status: "starting", lastError: undefined });
            const resolved = await options.managedController.ensureStarted(target, configTarget);
            mark(target.id, {
              status: "healthy",
              serverUrl: resolved.serverUrl,
              startedAt: existing(target.id)?.startedAt ?? timestamp(),
              lastProbeAt: timestamp(),
              lastError: undefined,
            });
            return resolved;
          } catch (error) {
            const message = `OpenCode target ${target.id} is unavailable: ${summarizeError(error)}`;
            mark(target.id, { status: "unhealthy", lastProbeAt: timestamp(), lastError: summarizeError(error) });
            throw new TargetUnavailableError(target.id, message, { cause: error });
          }
        }

        if (effectiveTarget.serverUrl) return effectiveTarget;

        const message = `OpenCode target ${target.id} is managed but has not been started`;
        mark(target.id, { status: "stopped", lastError: message });
        throw new TargetUnavailableError(target.id, message);
      }

      const message = `OpenCode target ${target.id} uses unsupported mode ${target.mode}`;
      mark(target.id, { status: "error", lastError: message });
      throw new TargetUnavailableError(target.id, message);
    },

    async probe(targetId): Promise<TargetHealthSnapshot> {
      const configTarget = configuredTargets.get(targetId);
      if (!configTarget) throw new TargetUnavailableError(targetId, `OpenCode target not found: ${targetId}`);

      const target = toRuntimeTarget(configTarget);

      if (!target.serverUrl) {
        const status = target.mode === "managed" ? "stopped" : "error";
        const message = target.mode === "managed"
          ? `OpenCode target ${target.id} is managed but has not been started`
          : `OpenCode target ${target.id} is missing serverUrl`;
        const snapshot = mark(target.id, { status, lastProbeAt: timestamp(), lastError: message });
        return snapshot;
      }

      mark(target.id, { status: "starting", lastError: undefined });

      try {
        await options.runtime.listAgents({ target });
        const snapshot = mark(target.id, {
          status: "healthy",
          serverUrl: target.serverUrl,
          startedAt: existing(target.id)?.startedAt ?? timestamp(),
          lastProbeAt: timestamp(),
          lastError: undefined,
        });
        log("info", "OpenCode target probe succeeded", { targetId: target.id });
        return snapshot;
      } catch (error) {
        const snapshot = mark(target.id, {
          status: "unhealthy",
          serverUrl: target.serverUrl,
          lastProbeAt: timestamp(),
          lastError: summarizeError(error),
        });
        log("warn", "OpenCode target probe failed", { targetId: target.id, error: snapshot.lastError });
        return snapshot;
      }
    },

    health(): Record<string, TargetHealthSnapshot> {
      return Object.fromEntries([...snapshots.entries()].map(([id, snapshot]) => [id, { ...snapshot }]));
    },

    recordRuntimeSuccess(targetId): void {
      const snapshot = existing(targetId);
      if (!snapshot) return;

      mark(targetId, {
        status: "healthy",
        startedAt: snapshot.startedAt ?? timestamp(),
        lastProbeAt: timestamp(),
        lastError: undefined,
      });
    },

    recordRuntimeFailure(targetId, error): void {
      if (!existing(targetId)) return;

      mark(targetId, {
        status: "unhealthy",
        lastProbeAt: timestamp(),
        lastError: summarizeError(error),
      });
    },
  };

  function mark(targetId: string, patch: Partial<TargetHealthSnapshot>): TargetHealthSnapshot {
    const current = existing(targetId) ?? initialSnapshot(configuredTargets.get(targetId) ?? { id: targetId, name: targetId, mode: "attach" });
    const next = { ...current, ...patch };

    snapshots.set(targetId, next);
    logHealthTransition(current, next);
    return { ...next };
  }

  function logHealthTransition(previous: TargetHealthSnapshot, next: TargetHealthSnapshot): void {
    if (previous.status === next.status) return;

    const level: GatewayLogLevel = next.status === "unhealthy" || next.status === "error" ? "warn" : "info";

    log(level, "OpenCode target health changed", {
      source: "runtime",
      targetId: next.id,
      targetMode: next.mode,
      previousStatus: previous.status,
      status: next.status,
      serverUrl: sanitizeDiagnosticUrl(next.serverUrl),
      pid: next.pid,
      restartCount: next.restartCount,
      error: next.lastError,
    });
  }

  function existing(targetId: string): TargetHealthSnapshot | undefined {
    return snapshots.get(targetId);
  }

  function timestamp(): string {
    return now().toISOString();
  }
}

function initialSnapshot(target: Pick<GatewayTargetConfig, "id" | "name" | "mode" | "serverUrl">): TargetHealthSnapshot {
  return {
    id: target.id,
    name: target.name,
    mode: target.mode,
    status: "configured",
    serverUrl: target.serverUrl,
  };
}

function toRuntimeTarget(target: GatewayTargetConfig | RuntimeTarget, configTarget?: GatewayTargetConfig): RuntimeTarget {
  return {
    id: target.id,
    name: target.name,
    mode: target.mode,
    serverUrl: target.serverUrl ?? configTarget?.serverUrl,
    workdir: target.workdir ?? configTarget?.workdir,
    configDir: target.configDir ?? configTarget?.configDir,
    defaultAgent: target.defaultAgent ?? configTarget?.defaultAgent,
    defaultModel: target.defaultModel ?? configTarget?.defaultModel,
  };
}

function summarizeError(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  return message.split("\n")[0]?.slice(0, 500) || "unknown error";
}
