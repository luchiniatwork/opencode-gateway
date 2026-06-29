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
import type { TargetSupervisor } from "./types.ts";

type RuntimeInputWithTarget = { target: RuntimeTarget };

export class TargetResolvingRuntime implements AgentRuntime {
  constructor(
    private readonly supervisor: TargetSupervisor,
    private readonly delegate: AgentRuntime,
  ) {}

  async ensureSession(input: EnsureSessionInput): Promise<RuntimeSession> {
    return this.withResolvedTarget(input, (resolved) => this.delegate.ensureSession({ ...input, target: resolved }));
  }

  async send(input: SendRuntimeMessageInput): Promise<RuntimeTurn> {
    return this.withResolvedTarget(input, (resolved) => this.delegate.send({ ...input, target: resolved }));
  }

  async startTurn(input: StartRuntimeTurnInput): Promise<RuntimeStartedTurn> {
    return this.withResolvedTarget(input, async (resolved) => {
      const started = await this.delegate.startTurn({ ...input, target: resolved });

      return {
        ...started,
        events: this.observeResolvedEvents(resolved.id, started.events),
      };
    });
  }

  async sendAsync(input: SendRuntimeMessageInput): Promise<RuntimeTurnHandle> {
    return this.withResolvedTarget(input, (resolved) => this.delegate.sendAsync({ ...input, target: resolved }));
  }

  async *observe(input: ObserveRuntimeTurnInput): AsyncIterable<RuntimeEvent> {
    const target = await this.supervisor.resolve(input.target);

    try {
      for await (const event of this.delegate.observe({ ...input, target })) {
        yield event;
      }

      this.supervisor.recordRuntimeSuccess(target.id);
    } catch (error) {
      this.supervisor.recordRuntimeFailure(target.id, error);
      throw error;
    }
  }

  async abort(input: AbortRuntimeTurnInput): Promise<void> {
    return this.withResolvedTarget(input, (resolved) => this.delegate.abort({ ...input, target: resolved }));
  }

  async respondToPermission(input: PermissionResponseInput): Promise<void> {
    return this.withResolvedTarget(input, (resolved) => this.delegate.respondToPermission({ ...input, target: resolved }));
  }

  async listSessions(input: ListRuntimeSessionsInput): Promise<RuntimeSession[]> {
    return this.withResolvedTarget(input, (resolved) => this.delegate.listSessions({ ...input, target: resolved }));
  }

  async listAgents(input: ListRuntimeAgentsInput): Promise<RuntimeAgent[]> {
    return this.withResolvedTarget(input, (resolved) => this.delegate.listAgents({ ...input, target: resolved }));
  }

  async listModels(input: ListRuntimeModelsInput): Promise<RuntimeModel[]> {
    return this.withResolvedTarget(input, (resolved) => this.delegate.listModels({ ...input, target: resolved }));
  }

  private async withResolvedTarget<T>(
    input: RuntimeInputWithTarget,
    operation: (target: RuntimeTarget) => Promise<T>,
  ): Promise<T> {
    const target = await this.supervisor.resolve(input.target);

    try {
      const result = await operation(target);
      this.supervisor.recordRuntimeSuccess(target.id);
      return result;
    } catch (error) {
      this.supervisor.recordRuntimeFailure(target.id, error);
      throw error;
    }
  }

  private async *observeResolvedEvents(targetId: string, events: AsyncIterable<RuntimeEvent>): AsyncIterable<RuntimeEvent> {
    try {
      for await (const event of events) {
        yield event;
      }

      this.supervisor.recordRuntimeSuccess(targetId);
    } catch (error) {
      this.supervisor.recordRuntimeFailure(targetId, error);
      throw error;
    }
  }
}
