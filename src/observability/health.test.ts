import { expect, test } from "bun:test";

import type { GatewayConfig } from "../config/schema.ts";
import { createHealthSnapshot } from "./health.ts";

test("health snapshot reports configured targets and active profiles", () => {
  const snapshot = createHealthSnapshot({
    config: testConfig(),
    started: true,
    channelStatuses: { "telegram:default": "running" },
  });

  expect(snapshot).toEqual({
    ok: true,
    version: "0.1.0",
    gateway: "healthy",
    channels: { "telegram:default": "running" },
    opencodeTargets: { default: "configured" },
    profiles: { default: "cto", active: ["cto"] },
  });
});

test("health snapshot is not ok when a channel is in error", () => {
  const snapshot = createHealthSnapshot({
    config: testConfig(),
    started: true,
    channelStatuses: { "telegram:default": "error" },
  });

  expect(snapshot.ok).toBe(false);
});

test("health snapshot includes runtime diagnostics when provided", () => {
  const snapshot = createHealthSnapshot({
    config: testConfig(),
    started: true,
    runtime: {
      activeRunCount: 1,
      queuedTurnCount: 2,
      queuedBindingCount: 1,
      pendingPermissionCount: 1,
      activeRuns: [
        {
          id: "run-1",
          bindingId: "binding-1",
          sessionId: "session-1",
          opencodeMessageId: "message-1",
          startedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      queuedTurns: [
        {
          bindingId: "binding-1",
          size: 2,
          oldestEnqueuedAt: "2026-01-01T00:00:01.000Z",
          oldestAgeMs: 1000,
        },
      ],
      pendingPermissions: [
        {
          id: "permission-1",
          runId: "run-1",
          opencodePermissionId: "opencode-permission-1",
          hasActionMessageReceipt: true,
          expiresAt: "2026-01-01T00:15:00.000Z",
        },
      ],
    },
  });

  expect(snapshot.runtime).toEqual({
    activeRunCount: 1,
    queuedTurnCount: 2,
    queuedBindingCount: 1,
    pendingPermissionCount: 1,
    activeRuns: [
      {
        id: "run-1",
        bindingId: "binding-1",
        sessionId: "session-1",
        opencodeMessageId: "message-1",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    ],
    queuedTurns: [
      {
        bindingId: "binding-1",
        size: 2,
        oldestEnqueuedAt: "2026-01-01T00:00:01.000Z",
        oldestAgeMs: 1000,
      },
    ],
    pendingPermissions: [
      {
        id: "permission-1",
        runId: "run-1",
        opencodePermissionId: "opencode-permission-1",
        hasActionMessageReceipt: true,
        expiresAt: "2026-01-01T00:15:00.000Z",
      },
    ],
  });
});

function testConfig(): GatewayConfig {
  return {
    gateway: {
      host: "127.0.0.1",
      port: 8765,
      databasePath: ":memory:",
      logLevel: "info",
    },
    opencode: {
      targets: [
        {
          id: "default",
          name: "Default workspace",
          mode: "attach",
          serverUrl: "http://127.0.0.1:4096",
        },
      ],
    },
    profiles: {
      default: "cto",
      entries: [
        {
          id: "cto",
          displayName: "CTO",
          defaultTargetId: "default",
          defaults: { busyMode: "queue", verbosity: "compact" },
        },
      ],
    },
    channels: {
      telegram: {
        enabled: true,
        allowFrom: ["123"],
        groups: {},
      },
    },
    interactive: {
      permissions: {
        mode: "buttons",
        fallbackCommands: true,
        allowAlways: false,
      },
    },
    defaults: {
      profile: "cto",
      target: "default",
      busyMode: "queue",
      verbosity: "compact",
      inboundDebounceMs: 1500,
    },
  };
}
