import { expect, test } from "bun:test";

import type {
  AbortRuntimeTurnInput,
  AgentRuntime,
  EnsureSessionInput,
  ListRuntimeAgentsInput,
  ListRuntimeModelsInput,
  ListRuntimeSessionsInput,
  ObserveRuntimeTurnInput,
  PermissionResponseInput,
  RuntimeAgent,
  RuntimeEvent,
  RuntimeModel,
  RuntimeSession,
  RuntimeStartedTurn,
  RuntimeTarget,
  RuntimeTurn,
  RuntimeTurnHandle,
  SendRuntimeMessageInput,
  StartRuntimeTurnInput,
} from "../opencode/types.ts";
import { TargetResolvingRuntime } from "./resolving-runtime.ts";
import type { TargetHealthSnapshot, TargetSupervisor } from "./types.ts";

test("resolves target before runtime calls", async () => {
  const supervisor = new FakeSupervisor();
  const delegate = new FakeRuntime();
  const runtime = new TargetResolvingRuntime(supervisor, delegate);

  const session = await runtime.ensureSession({ target: unresolvedTarget });

  expect(session.targetId).toBe("default");
  expect(supervisor.resolvedTargets).toEqual(["default"]);
  expect(supervisor.successes).toEqual(["default"]);
  expect(delegate.calls.ensureSession[0]?.target.serverUrl).toBe("http://127.0.0.1:4096");
});

test("records runtime failure after target resolution", async () => {
  const supervisor = new FakeSupervisor();
  const delegate = new FakeRuntime();
  delegate.error = new Error("OpenCode unavailable");
  const runtime = new TargetResolvingRuntime(supervisor, delegate);

  await expect(runtime.listAgents({ target: unresolvedTarget })).rejects.toThrow("OpenCode unavailable");

  expect(supervisor.resolvedTargets).toEqual(["default"]);
  expect(supervisor.failures).toEqual([{ targetId: "default", message: "OpenCode unavailable" }]);
});

test("wraps startTurn events so stream failures update target health", async () => {
  const supervisor = new FakeSupervisor();
  const delegate = new FakeRuntime();
  delegate.eventsError = new Error("event stream failed");
  const runtime = new TargetResolvingRuntime(supervisor, delegate);
  const started = await runtime.startTurn({ target: unresolvedTarget, sessionId: "session-1", text: "hello" });

  await expect(consumeEvents(started.events)).rejects.toThrow("event stream failed");

  expect(supervisor.failures).toEqual([{ targetId: "default", message: "event stream failed" }]);
});

test("resolves targets for permission responses", async () => {
  const supervisor = new FakeSupervisor();
  const delegate = new FakeRuntime();
  const runtime = new TargetResolvingRuntime(supervisor, delegate);

  await runtime.respondToPermission({
    target: unresolvedTarget,
    sessionId: "session-1",
    permissionId: "permission-1",
    decision: "approve",
  });

  expect(delegate.calls.respondToPermission[0]?.target.serverUrl).toBe("http://127.0.0.1:4096");
});

async function consumeEvents(events: AsyncIterable<RuntimeEvent>): Promise<RuntimeEvent[]> {
  const collected: RuntimeEvent[] = [];

  for await (const event of events) collected.push(event);

  return collected;
}

const unresolvedTarget: RuntimeTarget = {
  id: "default",
  name: "Default",
  mode: "attach",
};

const resolvedTarget: RuntimeTarget = {
  ...unresolvedTarget,
  serverUrl: "http://127.0.0.1:4096",
};

class FakeSupervisor implements TargetSupervisor {
  readonly resolvedTargets: string[] = [];
  readonly successes: string[] = [];
  readonly failures: Array<{ targetId: string; message: string }> = [];

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async resolve(target: RuntimeTarget): Promise<RuntimeTarget> {
    this.resolvedTargets.push(target.id);
    return { ...resolvedTarget, id: target.id, name: target.name, mode: target.mode };
  }

  async probe(targetId: string): Promise<TargetHealthSnapshot> {
    return {
      id: targetId,
      name: targetId,
      mode: "attach",
      status: "healthy",
      serverUrl: "http://127.0.0.1:4096",
    };
  }

  health(): Record<string, TargetHealthSnapshot> {
    return {};
  }

  recordRuntimeSuccess(targetId: string): void {
    this.successes.push(targetId);
  }

  recordRuntimeFailure(targetId: string, error: unknown): void {
    this.failures.push({ targetId, message: error instanceof Error ? error.message : String(error) });
  }
}

class FakeRuntime implements AgentRuntime {
  readonly calls = {
    ensureSession: [] as EnsureSessionInput[],
    startTurn: [] as StartRuntimeTurnInput[],
    listAgents: [] as ListRuntimeAgentsInput[],
    respondToPermission: [] as PermissionResponseInput[],
  };
  error: Error | undefined;
  eventsError: Error | undefined;

  async ensureSession(input: EnsureSessionInput): Promise<RuntimeSession> {
    this.calls.ensureSession.push(input);
    if (this.error) throw this.error;
    return { id: input.sessionId ?? "session-1", targetId: input.target.id };
  }

  async send(_input: SendRuntimeMessageInput): Promise<RuntimeTurn> {
    if (this.error) throw this.error;
    return { sessionId: "session-1", status: "completed", text: "answer" };
  }

  async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    this.calls.startTurn.push(input);
    if (this.error) throw this.error;

    return {
      handle: { id: "message-1", sessionId: input.sessionId, targetId: input.target.id, status: "running" },
      events: this.events(),
    };
  }

  async sendAsync(_input: SendRuntimeMessageInput): Promise<RuntimeTurnHandle> {
    if (this.error) throw this.error;
    return { id: "message-1", sessionId: "session-1", targetId: "default", status: "running" };
  }

  async *observe(_input: ObserveRuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    yield* this.events();
  }

  async abort(_input: AbortRuntimeTurnInput): Promise<void> {
    if (this.error) throw this.error;
  }

  async respondToPermission(input: PermissionResponseInput): Promise<void> {
    this.calls.respondToPermission.push(input);
    if (this.error) throw this.error;
  }

  async listSessions(_input: ListRuntimeSessionsInput): Promise<RuntimeSession[]> {
    if (this.error) throw this.error;
    return [];
  }

  async listAgents(input: ListRuntimeAgentsInput): Promise<RuntimeAgent[]> {
    this.calls.listAgents.push(input);
    if (this.error) throw this.error;
    return [{ id: "build" }];
  }

  async listModels(_input: ListRuntimeModelsInput): Promise<RuntimeModel[]> {
    if (this.error) throw this.error;
    return [];
  }

  private async *events(): AsyncIterable<RuntimeEvent> {
    if (this.eventsError) throw this.eventsError;
    yield { type: "final", text: "answer" };
  }
}
