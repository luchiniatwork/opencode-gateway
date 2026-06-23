import { expect, test } from "bun:test";

import type { SendReceipt, TypingState } from "../channels/types.ts";
import type { OutboundMessage } from "../messages/types.ts";
import { createProgressRenderer } from "./renderer.ts";

test("progress renderer sends no progress in off verbosity", async () => {
  const harness = createHarness({ typing: true });
  const renderer = createProgressRenderer({ verbosity: "off", delayMs: 1, ...harness.delivery });

  await renderer.handle({ type: "tool_start", id: "tool-1", name: "bash", summary: "Run tests" });
  await Bun.sleep(5);
  await renderer.finalize();

  expect(harness.sent).toEqual([]);
  expect(harness.edited).toEqual([]);
  expect(harness.typing).toEqual([]);
});

test("progress renderer sends no progress in compact verbosity", async () => {
  const harness = createHarness({ typing: true });
  const renderer = createProgressRenderer({ verbosity: "compact", delayMs: 1, ...harness.delivery });

  await waitFor(() => harness.typing.length === 1);
  await renderer.handle({ type: "text_delta", text: "ignored" });
  await Bun.sleep(5);
  await renderer.finalize();

  expect(harness.sent).toEqual([]);
  expect(harness.edited).toEqual([]);
  expect(harness.typing.map((entry) => entry.state)).toEqual(["typing", "idle"]);
});

test("progress renderer does not send compact chat acknowledgement before final", async () => {
  const harness = createHarness({ typing: true });
  const renderer = createProgressRenderer({ verbosity: "compact", delayMs: 20, ...harness.delivery });

  await renderer.finalize();
  await Bun.sleep(30);

  expect(harness.sent).toEqual([]);
  expect(harness.edited).toEqual([]);
  expect(harness.typing.map((entry) => entry.state)).toEqual(["typing", "idle"]);
});

for (const verbosity of ["tools", "verbose"] as const) {
  test(`progress renderer uses typing indicator in ${verbosity} verbosity`, async () => {
    const harness = createHarness({ typing: true });
    const renderer = createProgressRenderer({ verbosity, delayMs: 1, ...harness.delivery });

    await waitFor(() => harness.typing.length === 1);
    await renderer.finalize();

    expect(harness.typing.map((entry) => entry.state)).toEqual(["typing", "idle"]);
  });
}

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

test("progress renderer only shows tool lifecycle events in tools verbosity", async () => {
  const harness = createHarness();
  const renderer = createProgressRenderer({ verbosity: "tools", delayMs: 1, ...harness.delivery });

  await renderer.handle({ type: "status", status: "running" });
  await renderer.handle({ type: "tool_update", id: "tool-1", name: "bash", summary: "Still running" });
  await renderer.handle({ type: "permission_request", id: "permission-1", summary: "Run bash" });
  await renderer.handle({ type: "question_request", id: "question-1", prompt: "Which branch?" });
  await renderer.handle({ type: "text_delta", text: "streamed text" });
  await Bun.sleep(5);

  expect(harness.sent).toEqual([]);

  await renderer.handle({ type: "tool_start", id: "tool-1", name: "bash", summary: "Run tests" });
  await waitFor(() => harness.sent.length === 1);
  await renderer.handle({ type: "status", status: "idle" });
  await renderer.handle({ type: "tool_update", id: "tool-1", name: "bash", summary: "Almost done" });
  await renderer.handle({ type: "tool_end", id: "tool-1", name: "bash", ok: true, summary: "Passed" });
  await renderer.finalize();

  expect(harness.sent.map((entry) => entry.message.text)).toEqual([
    "Tool bash started: Run tests",
    "Tool bash completed: Passed",
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
    "Status: running\nTool bash (tool-1) updated: Still running",
  );
});

test("progress renderer shows verbose diagnostic events and suppresses deltas", async () => {
  const harness = createHarness({ edit: true });
  const renderer = createProgressRenderer({ verbosity: "verbose", delayMs: 1, ...harness.delivery });

  await renderer.handle({ type: "status", status: "running" });
  await waitFor(() => harness.sent.length === 1);
  await renderer.handle({ type: "tool_start", id: "tool-1", name: "bash", summary: "Run tests" });
  await renderer.handle({ type: "tool_update", id: "tool-1", name: "bash", summary: "Still running" });
  await renderer.handle({ type: "permission_request", id: "permission-1", summary: "Run bash" });
  await renderer.handle({ type: "question_request", id: "question-1", prompt: "Which branch?" });
  await renderer.handle({ type: "text_delta", text: "streamed text" });
  await renderer.handle({ type: "final", text: "final answer" });
  await renderer.handle({ type: "error", message: "runtime failed" });
  await renderer.handle({ type: "tool_end", id: "tool-1", name: "bash", ok: true, summary: "Passed" });
  await renderer.finalize();

  expect(harness.edited.at(-1)?.message.text).toBe([
    "Status: running",
    "Tool bash (tool-1) started: Run tests",
    "Tool bash (tool-1) updated: Still running",
    "Permission requested (permission-1): Run bash",
    "Question requested (question-1): Which branch?",
    "Tool bash (tool-1) completed: Passed",
  ].join("\n"));
});

test("progress renderer includes verbose permission and question diagnostics", async () => {
  const harness = createHarness({ edit: true });
  const renderer = createProgressRenderer({ verbosity: "verbose", delayMs: 1, ...harness.delivery });

  await renderer.handle({ type: "permission_request", id: "permission-1", summary: "Run bash" });
  await waitFor(() => harness.sent.length === 1);
  await renderer.handle({ type: "question_request", id: "question-1", prompt: "Which branch?" });
  await renderer.finalize();

  expect(harness.edited.at(-1)?.message.text).toBe(
    "Permission requested (permission-1): Run bash\nQuestion requested (question-1): Which branch?",
  );
});

test("progress renderer falls back to sending sparse progress when editing fails", async () => {
  const harness = createHarness({ edit: true, failEdits: true });
  const renderer = createProgressRenderer({
    verbosity: "tools",
    delayMs: 1,
    ...harness.delivery,
    onError: (error) => harness.errors.push(error),
  });

  await renderer.handle({ type: "tool_start", id: "tool-1", name: "bash", summary: "Run tests" });
  await waitFor(() => harness.sent.length === 1);
  await renderer.handle({ type: "tool_end", id: "tool-1", name: "bash", ok: true, summary: "Passed" });
  await renderer.handle({ type: "tool_start", id: "tool-2", name: "read", summary: "Inspect file" });
  await renderer.finalize();

  expect(harness.edited).toEqual([]);
  expect(harness.sent.map((entry) => entry.message.text)).toEqual([
    "Tool bash started: Run tests",
    "Tool bash completed: Passed",
    "Tool read started: Inspect file",
  ]);
  expect(harness.errors.map((error) => error instanceof Error ? error.message : String(error))).toEqual(["edit failed"]);
});

test("progress renderer does not cap accumulated edited progress lines", async () => {
  const harness = createHarness({ edit: true });
  const renderer = createProgressRenderer({ verbosity: "verbose", delayMs: 1, ...harness.delivery });

  await renderer.handle({ type: "status", status: "running" });
  await waitFor(() => harness.sent.length === 1);

  for (let index = 1; index <= 15; index += 1) {
    await renderer.handle({ type: "tool_update", id: `tool-${index}`, name: "bash", summary: `step ${index}` });
  }

  await renderer.finalize();

  const finalProgress = harness.edited.at(-1)?.message.text ?? "";
  expect(finalProgress.split("\n")).toHaveLength(16);
  expect(finalProgress).toContain("Status: running");
  expect(finalProgress).toContain("Tool bash (tool-15) updated: step 15");
});

interface Harness {
  sent: Array<{ receipt: SendReceipt; message: OutboundMessage }>;
  edited: Array<{ receipt: SendReceipt; message: OutboundMessage }>;
  typing: Array<{ state: TypingState }>;
  errors: unknown[];
  delivery: {
    send(message: OutboundMessage): Promise<SendReceipt>;
    edit?: (receipt: SendReceipt, message: OutboundMessage) => Promise<SendReceipt>;
    setTyping?: (state: TypingState) => Promise<void>;
  };
}

function createHarness(options: { edit?: boolean; failEdits?: boolean; typing?: boolean } = {}): Harness {
  const sent: Harness["sent"] = [];
  const edited: Harness["edited"] = [];
  const typing: Harness["typing"] = [];
  const errors: unknown[] = [];
  const delivery: Harness["delivery"] = {
    async send(message) {
      const receipt = receiptFor(`sent-${sent.length + 1}`);
      sent.push({ receipt, message });
      return receipt;
    },
  };

  if (options.edit) {
    delivery.edit = async (receipt, message) => {
      if (options.failEdits) throw new Error("edit failed");
      edited.push({ receipt, message });
      return receipt;
    };
  }

  if (options.typing) {
    delivery.setTyping = async (state) => {
      typing.push({ state });
    };
  }

  return { sent, edited, typing, errors, delivery };
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
