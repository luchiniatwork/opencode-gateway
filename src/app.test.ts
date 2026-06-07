import { expect, test } from "bun:test";

import { createApp, type GatewayLogEntry } from "./app.ts";

test("gateway app starts and stops idempotently", async () => {
  const entries: GatewayLogEntry[] = [];
  const app = createApp({
    logger: (entry) => entries.push(entry),
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });

  expect(app.status.started).toBe(false);

  await app.start();
  await app.start();

  expect(app.status.started).toBe(true);
  expect(entries).toEqual([
    {
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "info",
      component: "app",
      message: "opencode-gateway starting",
    },
  ]);

  await app.stop();
  await app.stop();

  expect(app.status.started).toBe(false);
  expect(entries).toHaveLength(2);
  expect(entries[1]).toEqual({
    timestamp: "2026-01-01T00:00:00.000Z",
    level: "info",
    component: "app",
    message: "opencode-gateway stopped",
  });
});
