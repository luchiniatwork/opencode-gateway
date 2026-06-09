import { expect, test } from "bun:test";

import { createJsonLogSink, redactLogEntry } from "./logging.ts";

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

test("redacts nested secrets from objects and arrays", () => {
  const redacted = redactLogEntry({
    timestamp: "2026-01-01T00:00:00.000Z",
    level: "error",
    component: "test",
    message: "written",
    raw: {
      headers: {
        authorization: "Bearer secret-token",
        cookie: "session=secret",
      },
      attempts: [
        {
          api_key: "secret-key",
          status: "failed",
        },
      ],
    },
  });

  expect(redacted.raw).toEqual({
    headers: {
      authorization: "[redacted]",
      cookie: "[redacted]",
    },
    attempts: [
      {
        api_key: "[redacted]",
        status: "failed",
      },
    ],
  });
});
