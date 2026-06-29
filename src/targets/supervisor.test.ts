import { expect, test } from "bun:test";

import type { GatewayTargetConfig } from "../config/schema.ts";
import type { TargetRecord } from "../db/types.ts";
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
  RuntimeModel,
  RuntimeSession,
  RuntimeStartedTurn,
  RuntimeTarget,
  RuntimeTurn,
  RuntimeTurnHandle,
  SendRuntimeMessageInput,
  StartRuntimeTurnInput,
} from "../opencode/types.ts";
import { TargetUnavailableError } from "./errors.ts";
import { createTargetSupervisor } from "./supervisor.ts";
import type { ManagedTargetController } from "./types.ts";

test("attach target probe records healthy state", async () => {
  const runtime = new FakeRuntime();
  const supervisor = createTargetSupervisor({ targets: [attachConfig], runtime, now: fixedNow });

  await supervisor.start();

  expect(runtime.calls.listAgents).toEqual([expect.objectContaining({ target: expect.objectContaining({ id: "default" }) })]);
  expect(supervisor.health().default).toMatchObject({
    id: "default",
    status: "healthy",
    serverUrl: "http://127.0.0.1:4096",
    startedAt: "2026-01-01T00:00:00.000Z",
    lastProbeAt: "2026-01-01T00:00:00.000Z",
  });
});

test("attach target probe records unhealthy state without throwing", async () => {
  const runtime = new FakeRuntime();
  runtime.listAgentsError = new Error("connection refused");
  const supervisor = createTargetSupervisor({ targets: [attachConfig], runtime, now: fixedNow });

  await supervisor.start();

  expect(supervisor.health().default).toMatchObject({
    status: "unhealthy",
    lastError: "connection refused",
  });
});

test("resolve returns attach target even when health is stale or unhealthy", async () => {
  const runtime = new FakeRuntime();
  runtime.listAgentsError = new Error("connection refused");
  const supervisor = createTargetSupervisor({ targets: [attachConfig], runtime, now: fixedNow });

  await supervisor.start();

  await expect(supervisor.resolve(attachRecord)).resolves.toMatchObject({
    id: "default",
    serverUrl: "http://127.0.0.1:4096",
  });
});

test("resolve rejects targets without an effective server URL", async () => {
  const supervisor = createTargetSupervisor({
    targets: [{ ...attachConfig, serverUrl: undefined }],
    runtime: new FakeRuntime(),
    now: fixedNow,
  });

  await expect(supervisor.resolve({ ...attachRecord, serverUrl: undefined })).rejects.toThrow(TargetUnavailableError);
  expect(supervisor.health().default).toMatchObject({ status: "error" });
});

test("managed controller can resolve a managed target", async () => {
  const controller = new FakeManagedController();
  const supervisor = createTargetSupervisor({
    targets: [managedConfig],
    runtime: new FakeRuntime(),
    managedController: controller,
    now: fixedNow,
  });

  const target = await supervisor.resolve(managedRecord);

  expect(target).toMatchObject({
    id: "managed",
    mode: "managed",
    serverUrl: "http://127.0.0.1:4100",
  });
  expect(controller.startedTargets).toEqual(["managed"]);
  expect(supervisor.health().managed).toMatchObject({ status: "healthy" });
});

test("managed controller failure updates health", async () => {
  const controller = new FakeManagedController();
  controller.error = new Error("startup timed out");
  const supervisor = createTargetSupervisor({
    targets: [managedConfig],
    runtime: new FakeRuntime(),
    managedController: controller,
    now: fixedNow,
  });

  await expect(supervisor.resolve(managedRecord)).rejects.toThrow("startup timed out");
  expect(supervisor.health().managed).toMatchObject({
    status: "unhealthy",
    lastError: "startup timed out",
  });
});

test("runtime failure marks target unhealthy", () => {
  const supervisor = createTargetSupervisor({ targets: [attachConfig], runtime: new FakeRuntime(), now: fixedNow });

  supervisor.recordRuntimeFailure("default", new Error("prompt failed"));

  expect(supervisor.health().default).toMatchObject({
    status: "unhealthy",
    lastError: "prompt failed",
  });
});

const attachConfig: GatewayTargetConfig = {
  id: "default",
  name: "Default workspace",
  mode: "attach",
  serverUrl: "http://127.0.0.1:4096",
  workdir: "/work/repo",
};

const attachRecord: TargetRecord = {
  ...attachConfig,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const managedConfig: GatewayTargetConfig = {
  id: "managed",
  name: "Managed workspace",
  mode: "managed",
  workdir: "/work/managed",
};

const managedRecord: TargetRecord = {
  ...managedConfig,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function fixedNow(): Date {
  return new Date("2026-01-01T00:00:00.000Z");
}

class FakeManagedController implements ManagedTargetController {
  readonly startedTargets: string[] = [];
  error: Error | undefined;

  async ensureStarted(target: RuntimeTarget): Promise<RuntimeTarget> {
    this.startedTargets.push(target.id);
    if (this.error) throw this.error;

    return {
      ...target,
      serverUrl: "http://127.0.0.1:4100",
    };
  }

  async stopAll(): Promise<void> {}
}

class FakeRuntime implements AgentRuntime {
  readonly calls = { listAgents: [] as ListRuntimeAgentsInput[] };
  listAgentsError: Error | undefined;

  async ensureSession(_input: EnsureSessionInput): Promise<RuntimeSession> {
    throw new Error("not implemented");
  }

  async send(_input: SendRuntimeMessageInput): Promise<RuntimeTurn> {
    throw new Error("not implemented");
  }

  async startTurn(_input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    throw new Error("not implemented");
  }

  async sendAsync(_input: SendRuntimeMessageInput): Promise<RuntimeTurnHandle> {
    throw new Error("not implemented");
  }

  async *observe(_input: ObserveRuntimeTurnInput): AsyncIterable<never> {}

  async abort(_input: AbortRuntimeTurnInput): Promise<void> {
    throw new Error("not implemented");
  }

  async respondToPermission(_input: PermissionResponseInput): Promise<void> {
    throw new Error("not implemented");
  }

  async listSessions(_input: ListRuntimeSessionsInput): Promise<RuntimeSession[]> {
    throw new Error("not implemented");
  }

  async listAgents(input: ListRuntimeAgentsInput): Promise<RuntimeAgent[]> {
    this.calls.listAgents.push(input);
    if (this.listAgentsError) throw this.listAgentsError;
    return [{ id: "build" }];
  }

  async listModels(_input: ListRuntimeModelsInput): Promise<RuntimeModel[]> {
    throw new Error("not implemented");
  }
}
