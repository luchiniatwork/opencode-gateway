import { expect, test } from "bun:test";

import type { SendReceipt } from "../channels/types.ts";
import type { OutboundMessage } from "../messages/types.ts";
import { createProgressRenderer } from "./renderer.ts";

test("progress renderer sends no progress in off verbosity", async () => {
  const harness = createHarness();
  const renderer = createProgressRenderer({ verbosity: "off", delayMs: 1, ...harness.delivery });

  await renderer.handle({ type: "tool_start", id: "tool-1", name: "bash", summary: "Run tests" });
  await Bun.sleep(5);
  await renderer.finalize();

  expect(harness.sent).toEqual([]);
  expect(harness.edited).toEqual([]);
});

test("progress renderer sends no generic acknowledgement in compact verbosity", async () => {
  const harness = createHarness();
  const renderer = createProgressRenderer({ verbosity: "compact", delayMs: 1, ...harness.delivery });

  await renderer.handle({ type: "text_delta", text: "ignored" });
  await Bun.sleep(5);
  await renderer.finalize();

  expect(harness.sent).toEqual([]);
  expect(harness.edited).toEqual([]);
});

test("progress renderer cancels delayed acknowledgement before final", async () => {
  const harness = createHarness();
  const renderer = createProgressRenderer({ verbosity: "compact", delayMs: 20, ...harness.delivery });

  await renderer.finalize();
  await Bun.sleep(30);

  expect(harness.sent).toEqual([]);
  expect(harness.edited).toEqual([]);
});

test("progress renderer edits one progress message when editing is available", async () => {
  const harness = createHarness({ edit: true });
  const renderer = createProgressRenderer({ verbosity: "tools", delayMs: 1, ...harness.delivery });

  await renderer.handle({ type: "tool_start", id: "tool-1", name: "bash", summary: "Run tests" });
  await waitFor(() => harness.sent.length === 1);
  await renderer.handle({ type: "tool_end", id: "tool-1", name: "bash", ok: true, summary: "Passed" });
  await renderer.finalize();

  expect(harness.sent.map((entry) => entry.message.text)).toEqual(["Tool bash started: Run tests"]);
  expect(harness.edited.map((entry) => entry.message.text)).toEqual([
    "Tool bash started: Run tests\nTool bash completed: Passed",
  ]);
});

test("progress renderer falls back to sparse progress sends without editing", async () => {
  const harness = createHarness();
  const renderer = createProgressRenderer({ verbosity: "tools", delayMs: 1, ...harness.delivery });

  await renderer.handle({ type: "tool_start", id: "tool-1", name: "bash", summary: "Run tests" });
  await waitFor(() => harness.sent.length === 1);
  await renderer.handle({ type: "tool_end", id: "tool-1", name: "bash", ok: false });
  await renderer.finalize();

  expect(harness.sent.map((entry) => entry.message.text)).toEqual([
    "Tool bash started: Run tests",
    "Tool bash failed",
  ]);
});

test("progress renderer includes verbose status and tool updates", async () => {
  const harness = createHarness({ edit: true });
  const renderer = createProgressRenderer({ verbosity: "verbose", delayMs: 1, ...harness.delivery });

  await renderer.handle({ type: "status", status: "running" });
  await waitFor(() => harness.sent.length === 1);
  await renderer.handle({ type: "tool_update", id: "tool-1", name: "bash", summary: "Still running" });
  await renderer.finalize();

  expect(harness.edited.at(-1)?.message.text).toBe(
    "Status: running\nTool bash updated: Still running",
  );
});

interface Harness {
  sent: Array<{ receipt: SendReceipt; message: OutboundMessage }>;
  edited: Array<{ receipt: SendReceipt; message: OutboundMessage }>;
  delivery: {
    send(message: OutboundMessage): Promise<SendReceipt>;
    edit?: (receipt: SendReceipt, message: OutboundMessage) => Promise<SendReceipt>;
  };
}

function createHarness(options: { edit?: boolean } = {}): Harness {
  const sent: Harness["sent"] = [];
  const edited: Harness["edited"] = [];
  const delivery: Harness["delivery"] = {
    async send(message) {
      const receipt = receiptFor(`sent-${sent.length + 1}`);
      sent.push({ receipt, message });
      return receipt;
    },
  };

  if (options.edit) {
    delivery.edit = async (receipt, message) => {
      edited.push({ receipt, message });
      return receipt;
    };
  }

  return { sent, edited, delivery };
}

function receiptFor(platformMessageId: string): SendReceipt {
  return {
    channel: "telegram",
    accountId: "default",
    conversationKey: "telegram:default:dm:123",
    platformMessageId,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;

  while (!predicate() && Date.now() < deadline) {
    await Bun.sleep(5);
  }

  expect(predicate()).toBe(true);
}
