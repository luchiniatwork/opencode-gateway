import { expect, test } from "bun:test";

import { createJsonLogSink } from "./logging.ts";

test("json log sink filters by level and redacts sensitive fields", () => {
  const lines: string[] = [];
  const originalLog = console.log;

  console.log = (value?: unknown): void => {
    lines.push(String(value));
  };

  try {
    const logger = createJsonLogSink({ level: "warn" });

    logger({
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "info",
      component: "test",
      message: "ignored",
    });
    logger({
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "error",
      component: "test",
      message: "written",
      telegramToken: "secret-token",
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "{}")).toEqual({
      timestamp: "2026-01-01T00:00:00.000Z",
      level: "error",
      component: "test",
      message: "written",
      telegramToken: "[redacted]",
    });
  } finally {
    console.log = originalLog;
  }
});
