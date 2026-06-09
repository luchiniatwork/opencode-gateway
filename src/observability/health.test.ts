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
    defaults: {
      profile: "cto",
      target: "default",
      busyMode: "queue",
      verbosity: "compact",
      inboundDebounceMs: 1500,
    },
  };
}
