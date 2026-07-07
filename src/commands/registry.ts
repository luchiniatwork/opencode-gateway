import type { InboundMessage } from "../channels/types.ts";
import type { GatewayConfig } from "../config/schema.ts";
import type { BindingOperationResult, DispatchResolver, DispatchResolverRepositories } from "../dispatch/resolver.ts";
import type { PendingPermissionRepository } from "../db/repositories/pending-permissions.ts";
import type { ConversationBindingRecord, ProfileRecord, RunRecord, TargetRecord } from "../db/types.ts";
import type { ActiveTurnDiagnostics, TurnRunner } from "../gateway/turn-runner.ts";
import type { PermissionDecision, PermissionInteractionService } from "../interactive/permissions.ts";
import type { OutboundMessage } from "../messages/types.ts";
import type { AgentRuntime, RuntimeAgent, RuntimeModel, RuntimeSession } from "../opencode/types.ts";
import {
  authorizeCommandAction,
  commandAuthorizationDeniedText,
  gatewayCommandAction,
} from "../security/commands.ts";
import type { TargetHealthSnapshot } from "../targets/types.ts";

export type GatewayHealthStatus = "healthy" | "unhealthy" | "unknown" | "configured" | (string & {});
export type CommandTargetHealth = GatewayHealthStatus | TargetHealthSnapshot;

export interface CommandHealthSnapshot {
  gateway?: GatewayHealthStatus;
  degraded?: boolean;
  degradedReasons?: string[];
  targets?: Record<string, CommandTargetHealth>;
}

export interface CommandRouterOptions {
  config: GatewayConfig;
  repositories: DispatchResolverRepositories;
  resolver: DispatchResolver;
  runtime: AgentRuntime;
  turnRunner: TurnRunner;
  permissionService?: PermissionInteractionService;
  pendingPermissions?: PendingPermissionRepository;
  getHealth?: () => CommandHealthSnapshot;
}

export type CommandRouterResult =
  | { handled: false }
  | { handled: true; command: string; messages: OutboundMessage[] };

export interface CommandRouter {
  handle(message: InboundMessage): Promise<CommandRouterResult>;
}

interface ParsedCommand {
  name: string;
  args: string[];
}

type BindingOverrideKind = "agent" | "model";

type EffectiveValueSource = "binding override" | "profile default" | "target default" | "none";

interface EffectiveRuntimeValue {
  value?: string;
  source: EffectiveValueSource;
}

export function createCommandRouter(options: CommandRouterOptions): CommandRouter {
  const { config, repositories, resolver, runtime, turnRunner } = options;

  return {
    async handle(message): Promise<CommandRouterResult> {
      const parsed = parseCommand(message);
      if (!parsed) return { handled: false };

      const senderDecision = resolver.authorizeSender(message);
      if (!senderDecision.allowed) {
        return { handled: true, command: parsed.name, messages: [markdown(deniedDecisionText(senderDecision.reason))] };
      }

      const action = gatewayCommandAction(parsed.name, parsed.args);
      const commandDecision = authorizeCommandAction({
        role: senderDecision.role,
        action,
        profile: getCurrentProfileForPolicy(message),
      });

      if (!commandDecision.allowed) {
        return { handled: true, command: parsed.name, messages: [markdown(commandAuthorizationDeniedText(action))] };
      }

      const response = await executeCommand(parsed, message);
      return { handled: true, command: parsed.name, messages: [typeof response === "string" ? markdown(response) : response] };
    },
  };

  async function executeCommand(command: ParsedCommand, message: InboundMessage): Promise<string | OutboundMessage> {
    switch (command.name) {
      case "help":
        return helpText();
      case "status":
        return statusText(message);
      case "targets":
        return targetsText(message, command.args[0]);
      case "new":
      case "reset":
        return resetText(message, command.name);
      case "stop":
        return stopText(message);
      case "sessions":
        return sessionsText(message);
      case "use-session":
        return useSessionText(message, command.args[0]);
      case "profiles":
        return profilesText(message);
      case "profile":
        return command.args.length === 0 ? currentProfileText(message) : switchProfileText(message, command.args[0]);
      case "bind":
        return bindTargetText(message, command.args[0]);
      case "unbind":
        return unbindTargetText(message);
      case "agents":
        return agentsText(message);
      case "agent":
        return bindingOverrideText("agent", message, command.args);
      case "models":
        return modelsText(message);
      case "model":
        return bindingOverrideText("model", message, command.args);
      case "permission":
        return permissionText(message, command.args);
      default:
        return unknownCommandText(command.name);
    }
  }

  function accessDeniedText(message: InboundMessage): string | undefined {
    const decision = resolver.authorizeSender(message);

    if (decision.allowed) return undefined;
    if (decision.reason === "blocked") return "Access denied: this sender is blocked.";
    return "Access denied: this sender is not allowlisted.";
  }

  function helpText(): string {
    return [
      "🤖 OpenCode Gateway commands:",
      "",
      "`/help` - Show this help.",
      "`/status` - Show current routing and run status.",
      "`/new` or `/reset` - Create a fresh OpenCode session for this conversation.",
      "`/stop` - Abort the active run for this conversation.",
      "`/sessions` - List recent OpenCode sessions for the active target.",
      "`/use-session <id>` - Rebind this conversation to an existing session.",
      "`/targets` - List configured OpenCode targets.",
      "`/profiles` - List available gateway profiles.",
      "`/profile [id]` - Show or switch the active profile.",
      "`/bind <target-id>` - Explicitly bind this conversation to a target.",
      "`/unbind` - Return target routing to the active profile default.",
      "`/agents` - List available OpenCode agents for the active target.",
      "`/agent [name|default|clear]` - Show, set, or clear the per-binding agent override.",
      "`/models` - List available OpenCode models for the active target.",
      "`/model [id|default|clear]` - Show, set, or clear the per-binding model override.",
      "`/permission approve|deny|always <id>` - Respond to an OpenCode permission request.",
    ].join("\n");
  }

  function statusText(message: InboundMessage): string {
    const decision = resolver.authorizeSender(message);
    if (!decision.allowed) return deniedDecisionText(decision.reason);

    const binding = repositories.bindings.getByConversationKey(message.conversation.key);
    const profile = binding ? repositories.profiles.getById(binding.profileId) : getDefaultProfile();
    const target = getEffectiveTarget(binding, profile);
    const profileDefaultTarget = getTarget(profile?.defaultTargetId);
    const activeRun = binding ? repositories.runs.getActiveByBindingId(binding.id) : undefined;
    const activeDiagnostics = binding ? turnRunner.getActiveDiagnostics(binding.id) : undefined;
    const queueDiagnostics = binding ? turnRunner.getQueueDiagnostics(binding.id) : undefined;
    const pendingPermissions = activeRun ? options.pendingPermissions?.listPendingByRunId(activeRun.id) ?? [] : [];
    const health = options.getHealth?.();
    const targetHealth = target ? formatTargetHealth(health?.targets?.[target.id] ?? "configured") : "unknown";
    const profileDefaultTargetHealth = profileDefaultTarget
      ? formatTargetHealth(health?.targets?.[profileDefaultTarget.id] ?? "configured")
      : undefined;
    const activeRunTarget = activeRun ? getTarget(activeRun.targetId ?? binding?.targetId) : undefined;

    return [
      "🟢 Gateway status:",
      `Channel: ${message.channel}:${message.accountId}`,
      `Conversation: ${message.conversation.key}`,
      `Role: ${decision.role}`,
      `Profile: ${formatProfile(profile)}`,
      `Target: ${formatTarget(target)} (${targetHealth})`,
      `Target source: ${formatTargetSource(binding)}`,
      `Profile default target: ${formatTarget(profileDefaultTarget)}${profileDefaultTargetHealth ? ` (${profileDefaultTargetHealth})` : ""}`,
      `Session: ${binding?.opencodeSessionId ?? "none"}${binding?.sessionName ? ` (${binding.sessionName})` : ""}`,
      `Agent: ${formatEffectiveValue(resolveEffectiveAgentValue(binding, profile, target))}`,
      `Model: ${formatEffectiveValue(resolveEffectiveModelValue(binding, profile, target))}`,
      `Verbosity: ${formatEffectiveVerbosity(binding, profile, config.defaults.verbosity)}`,
      `Active run: ${formatRun(activeRun, activeDiagnostics)}`,
      activeRunTarget && target && activeRunTarget.id !== target.id
        ? `Active run target: ${formatTarget(activeRunTarget)}`
        : undefined,
      `Queue: ${formatQueue(queueDiagnostics)}`,
      `Pending permissions: ${formatPendingPermissions(pendingPermissions)}`,
      `Command policy: ${formatCommandPolicy(profile)}`,
      `Gateway health: ${health?.gateway ?? "unknown"}`,
      `Gateway degraded: ${formatGatewayDegraded(health)}`,
    ].filter(isNonEmptyString).join("\n");
  }

  function targetsText(message: InboundMessage, targetId: string | undefined): string {
    const context = getConversationRuntimeContext(message);
    const targets = repositories.targets.list();
    const health = options.getHealth?.();

    if (targetId) {
      const target = repositories.targets.getById(targetId);

      if (!target) return `OpenCode target not found: ${targetId}`;

      return [
        `🎯 OpenCode target: ${target.name} (${target.id})`,
        `Mode: ${target.mode}`,
        `Health: ${formatTargetHealth(health?.targets?.[target.id] ?? "configured")}`,
        `Markers: ${formatTargetMarkers(target, context).join(", ") || "none"}`,
        `Default agent: ${target.defaultAgent ?? "none"}`,
        `Default model: ${target.defaultModel ?? "none"}`,
      ].filter(isNonEmptyString).join("\n");
    }

    if (targets.length === 0) return "No OpenCode targets are configured.";

    return [
      "🎯 OpenCode targets:",
      ...targets.map((target) => formatTargetLine(target, context, health)),
      "",
      "Use /bind <target-id> to bind this conversation to a target.",
    ].join("\n");
  }

  async function resetText(message: InboundMessage, commandName: string): Promise<string> {
    const stopped = await stopActiveRunForRebind(message);

    if (stopped?.status === "error") return stopped.message;

    const result = await resolver.resetSession(message);

    if (result.status === "denied") return deniedDecisionText(result.decision.reason);
    if (result.status === "not_found") return `${titleCase(result.resource)} not found: ${result.id}`;
    if (result.status === "noop") return bindingNoopText(result);
    if (result.status === "blocked") return bindingBlockedText(result);
    if (result.status === "error") return `Unable to create a new session: ${result.error}`;

    return [
      stopped?.message,
      commandName === "new" ? "Created a new OpenCode session." : "Reset this conversation to a new OpenCode session.",
      result.previousSessionId ? `Previous session: ${result.previousSessionId}` : undefined,
      `Current session: ${result.session.id}`,
      `Profile: ${result.resolution.profile.displayName} (${result.resolution.profile.id})`,
      `Target: ${result.resolution.target.name} (${result.resolution.target.id})`,
      `Target source: ${formatTargetSource(result.resolution.binding)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  async function stopText(message: InboundMessage): Promise<string> {
    const denied = accessDeniedText(message);
    if (denied) return denied;

    const binding = repositories.bindings.getByConversationKey(message.conversation.key);
    if (!binding) return "No active run for this conversation.";

    const run = repositories.runs.getActiveByBindingId(binding.id);
    if (!run) return "No active run for this conversation.";

    const targetId = run.targetId ?? binding.targetId;
    const target = repositories.targets.getById(targetId);
    if (!target) return `OpenCode target not found: ${targetId}`;

    try {
      const result = await turnRunner.abortActive({
        binding,
        target,
        reason: "Stopped by gateway /stop command",
      });

      if (result.status === "no_active_run") return "No active run for this conversation.";
      if (result.status === "error") return `Unable to stop active run ${result.run.id}: ${result.error}`;

      return stopResultText(result.run, result.remoteAbortError);
    } catch (error) {
      return `Unable to stop active run ${run.id}: ${formatError(error)}`;
    }
  }

  async function stopActiveRunForRebind(
    message: InboundMessage,
  ): Promise<{ status: "stopped"; message: string } | { status: "error"; message: string } | undefined> {
    const binding = repositories.bindings.getByConversationKey(message.conversation.key);
    if (!binding) return undefined;

    const run = repositories.runs.getActiveByBindingId(binding.id);
    if (!run) return undefined;

    const targetId = run.targetId ?? binding.targetId;
    const target = repositories.targets.getById(targetId);
    if (!target) return { status: "error", message: `OpenCode target not found: ${targetId}` };

    try {
      const result = await turnRunner.abortActive({
        binding,
        target,
        reason: "Stopped by gateway session reset command",
      });

      if (result.status === "no_active_run") return undefined;
      if (result.status === "error") {
        return { status: "error", message: `Unable to stop active run ${result.run.id}: ${result.error}` };
      }

      return {
        status: "stopped",
        message: stopResultText(result.run, result.remoteAbortError),
      };
    } catch (error) {
      return { status: "error", message: `Unable to stop active run ${run.id}: ${formatError(error)}` };
    }
  }

  async function sessionsText(message: InboundMessage): Promise<string> {
    const denied = accessDeniedText(message);
    if (denied) return denied;

    const context = getConversationRuntimeContext(message);
    if (!context.profile) return `Profile not found: ${config.defaults.profile}`;
    if (!context.target) return `OpenCode target not found: ${context.profile.defaultTargetId}`;

    try {
      const sessions = await runtime.listSessions({ target: context.target, limit: 10 });
      if (sessions.length === 0) return `No recent sessions found for target ${context.target.id}.`;

      return [`🧵 Recent sessions for ${formatTarget(context.target)}:`, ...sessions.map((session) => formatSessionLine(session, context.binding?.opencodeSessionId))].join("\n");
    } catch (error) {
      return `Unable to list sessions: ${formatError(error)}`;
    }
  }

  async function useSessionText(message: InboundMessage, sessionId: string | undefined): Promise<string> {
    if (!sessionId) return "Usage: `/use-session <id>`";

    const result = await resolver.useSession(message, sessionId);

    if (result.status === "denied") return deniedDecisionText(result.decision.reason);
    if (result.status === "not_found") return `${titleCase(result.resource)} not found: ${result.id}`;
    if (result.status === "noop") return bindingNoopText(result);
    if (result.status === "blocked") return bindingBlockedText(result);
    if (result.status === "error") return `Unable to use session ${sessionId}: ${result.error}`;

    return [
      `Conversation rebound to session ${result.session.id}.`,
      result.previousSessionId ? `Previous session: ${result.previousSessionId}` : undefined,
      `Profile: ${result.resolution.profile.displayName} (${result.resolution.profile.id})`,
      `Target: ${result.resolution.target.name} (${result.resolution.target.id})`,
      `Target source: ${formatTargetSource(result.resolution.binding)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function profilesText(message: InboundMessage): string {
    const denied = accessDeniedText(message);
    if (denied) return denied;

    const currentProfileId = getCurrentProfileId(message);
    const profiles = repositories.profiles.list();

    if (profiles.length === 0) return "No profiles are configured.";

    return ["👤 Gateway profiles:", ...profiles.map((profile) => formatProfileLine(profile, currentProfileId))].join("\n");
  }

  function currentProfileText(message: InboundMessage): string {
    const denied = accessDeniedText(message);
    if (denied) return denied;

    const context = getConversationRuntimeContext(message);

    if (!context.profile) return `Profile not found: ${config.defaults.profile}`;

    return [
      `Current profile: ${context.profile.displayName} (${context.profile.id})`,
      context.profile.description ? `Description: ${context.profile.description}` : undefined,
      `Target: ${formatTarget(context.target)}`,
      `Target source: ${formatTargetSource(context.binding)}`,
      `Profile default target: ${formatTarget(getTarget(context.profile.defaultTargetId))}`,
      `Session: ${context.binding?.opencodeSessionId ?? "none"}`,
      `Verbosity: ${formatEffectiveVerbosity(context.binding, context.profile, config.defaults.verbosity)}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  async function switchProfileText(message: InboundMessage, profileId: string | undefined): Promise<string> {
    if (!profileId) return "Usage: `/profile <id>`";

    const result = await resolver.switchProfile(message, profileId);

    if (result.status === "denied") return deniedDecisionText(result.decision.reason);
    if (result.status === "not_found") return `${titleCase(result.resource)} not found: ${result.id}`;
    if (result.status === "noop") return bindingNoopText(result);
    if (result.status === "blocked") return bindingBlockedText(result);
    if (result.status === "error") return `Unable to switch profile: ${result.error}`;

    return [
      `Switched profile to ${result.resolution.profile.displayName} (${result.resolution.profile.id}).`,
      result.previousSessionId && result.previousSessionId !== result.session.id
        ? `Previous session: ${result.previousSessionId}`
        : undefined,
      `Current session: ${result.session.id}`,
      `Target: ${result.resolution.target.name} (${result.resolution.target.id})`,
      `Target source: ${formatTargetSource(result.resolution.binding)}`,
      `Verbosity: ${result.resolution.binding.verbosity}`,
      ...formatClearedOverrideLines(
        result.clearedOverrides,
        result.resolution.binding,
        result.resolution.profile,
        result.resolution.target,
      ),
    ]
      .filter(Boolean)
      .join("\n");
  }

  async function bindTargetText(message: InboundMessage, targetId: string | undefined): Promise<string> {
    if (!targetId) return "Usage: `/bind <target-id>`";

    const result = await resolver.bindTarget(message, targetId);

    if (result.status === "denied") return deniedDecisionText(result.decision.reason);
    if (result.status === "not_found") return `${titleCase(result.resource)} not found: ${result.id}`;
    if (result.status === "noop") return bindingNoopText(result);
    if (result.status === "blocked") return bindingBlockedText(result);
    if (result.status === "error") return `Unable to bind target ${targetId}: ${result.error}`;

    const activeRun = repositories.runs.getActiveByBindingId(result.resolution.binding.id);
    const activeTargetId = activeRun?.targetId;

    return [
      `Bound conversation to ${result.resolution.target.name} (${result.resolution.target.id}).`,
      result.previousTargetId && result.previousTargetId !== result.resolution.target.id
        ? `Previous target: ${formatTarget(getTarget(result.previousTargetId))}`
        : undefined,
      `Current session: ${result.session.id}`,
      `Profile: ${result.resolution.profile.displayName} (${result.resolution.profile.id})`,
      `Target source: ${formatTargetSource(result.resolution.binding)}`,
      activeRun && activeTargetId && activeTargetId !== result.resolution.target.id
        ? `Active run ${activeRun.id} continues on previous target ${activeTargetId}. Future turns use ${result.resolution.target.id}.`
        : undefined,
      ...formatClearedOverrideLines(
        result.clearedOverrides,
        result.resolution.binding,
        result.resolution.profile,
        result.resolution.target,
      ),
    ]
      .filter(Boolean)
      .join("\n");
  }

  async function unbindTargetText(message: InboundMessage): Promise<string> {
    const result = await resolver.unbindTarget(message);

    if (result.status === "denied") return deniedDecisionText(result.decision.reason);
    if (result.status === "not_found") return `${titleCase(result.resource)} not found: ${result.id}`;
    if (result.status === "noop") return bindingNoopText(result);
    if (result.status === "blocked") return bindingBlockedText(result);
    if (result.status === "error") return `Unable to clear target binding: ${result.error}`;

    return [
      "Cleared explicit target bind.",
      `Target now follows profile ${result.resolution.profile.displayName} (${result.resolution.profile.id}): ${result.resolution.target.name} (${result.resolution.target.id}).`,
      result.previousTargetId && result.previousTargetId !== result.resolution.target.id
        ? `Previous target: ${formatTarget(getTarget(result.previousTargetId))}`
        : undefined,
      `Current session: ${result.session.id}`,
      ...formatClearedOverrideLines(
        result.clearedOverrides,
        result.resolution.binding,
        result.resolution.profile,
        result.resolution.target,
      ),
    ]
      .filter(Boolean)
      .join("\n");
  }

  async function permissionText(message: InboundMessage, args: string[]): Promise<OutboundMessage> {
    if (!options.permissionService) return markdown("Permission responses are not enabled.");

    const decision = permissionDecisionArg(args[0]);
    if (!decision) {
      return markdown("Usage: `/permission approve <id>`, `/permission deny <id>`, or `/permission always <id>`");
    }

    return options.permissionService.handleFallbackCommand(message, decision, args[1]);
  }

  async function agentsText(message: InboundMessage): Promise<string> {
    const context = getConversationRuntimeContext(message);
    if (!context.profile) return `Profile not found: ${config.defaults.profile}`;
    if (!context.target) return `OpenCode target not found: ${context.profile.defaultTargetId}`;

    try {
      const agents = await runtime.listAgents({ target: context.target });
      if (agents.length === 0) return `No OpenCode agents found for target ${context.target.id}.`;

      const current = resolveEffectiveAgentValue(context.binding, context.profile, context.target).value;

      return [
        `🤖 OpenCode agents for ${formatTarget(context.target)}:`,
        ...agents.map((agent) => formatAgentLine(agent, current)),
      ].join("\n");
    } catch (error) {
      return `Unable to list agents: ${formatError(error)}`;
    }
  }

  async function modelsText(message: InboundMessage): Promise<string> {
    const context = getConversationRuntimeContext(message);
    if (!context.profile) return `Profile not found: ${config.defaults.profile}`;
    if (!context.target) return `OpenCode target not found: ${context.profile.defaultTargetId}`;

    try {
      const models = await runtime.listModels({ target: context.target });
      if (models.length === 0) return `No OpenCode models found for target ${context.target.id}.`;

      const current = resolveEffectiveModelValue(context.binding, context.profile, context.target).value;

      return [
        `🧠 OpenCode models for ${formatTarget(context.target)}:`,
        ...models.map((model) => formatModelLine(model, current)),
      ].join("\n");
    } catch (error) {
      return `Unable to list models: ${formatError(error)}`;
    }
  }

  async function bindingOverrideText(kind: BindingOverrideKind, message: InboundMessage, args: string[]): Promise<string> {
    if (args.length === 0) return currentBindingOverrideText(kind, message);
    if (args.length > 1) return overrideUsage(kind);

    const decision = resolver.authorizeSender(message);
    if (!decision.allowed) return deniedDecisionText(decision.reason);

    const value = args[0];
    if (!value) return overrideUsage(kind);

    if (isClearOverrideValue(value)) return clearBindingOverrideText(kind, message);

    const validation = await validateBindingOverride(kind, message, value);
    if (!validation.valid) return validation.message;

    const bindingResult = await resolver.ensureBindingForMessage(message);
    if (bindingResult.status === "denied") return deniedDecisionText(bindingResult.decision.reason);

    const updated = updateBindingOverride(kind, message.conversation.key, value);
    if (!updated) return `Unable to set ${kind} override: conversation binding not found.`;

    const context = getConversationRuntimeContext(message);

    return [
      `${overrideLabel(kind)} override set to ${value}.`,
      `Effective ${kind}: ${formatEffectiveValue(resolveEffectiveValue(kind, context.binding, context.profile, context.target))}`,
    ].join("\n");
  }

  function currentBindingOverrideText(kind: BindingOverrideKind, message: InboundMessage): string {
    const context = getConversationRuntimeContext(message);

    return [
      `Effective ${kind}: ${formatEffectiveValue(resolveEffectiveValue(kind, context.binding, context.profile, context.target))}`,
      `${overrideLabel(kind)} override: ${overrideValue(kind, context.binding) ?? "none"}`,
      `Profile default: ${profileDefaultValue(kind, context.profile) ?? "none"}`,
      `Target default: ${targetDefaultValue(kind, context.target) ?? "none"}`,
    ].join("\n");
  }

  function clearBindingOverrideText(kind: BindingOverrideKind, message: InboundMessage): string {
    const existing = repositories.bindings.getByConversationKey(message.conversation.key);

    if (!existing) {
      const context = getConversationRuntimeContext(message);

      return [
        `No ${kind} override is set.`,
        `Effective ${kind}: ${formatEffectiveValue(resolveEffectiveValue(kind, context.binding, context.profile, context.target))}`,
      ].join("\n");
    }

    const updated = updateBindingOverride(kind, message.conversation.key, null);
    if (!updated) return `Unable to clear ${kind} override: conversation binding not found.`;

    const context = getConversationRuntimeContext(message);

    return [
      `${overrideLabel(kind)} override cleared.`,
      `Effective ${kind}: ${formatEffectiveValue(resolveEffectiveValue(kind, context.binding, context.profile, context.target))}`,
    ].join("\n");
  }

  function updateBindingOverride(kind: BindingOverrideKind, conversationKey: string, value: string | null): ConversationBindingRecord | undefined {
    if (kind === "agent") return repositories.bindings.updateAgent({ conversationKey, agent: value });
    return repositories.bindings.updateModel({ conversationKey, model: value });
  }

  async function validateBindingOverride(
    kind: BindingOverrideKind,
    message: InboundMessage,
    value: string,
  ): Promise<{ valid: true } | { valid: false; message: string }> {
    const context = getConversationRuntimeContext(message);
    if (!context.profile) return { valid: false, message: `Profile not found: ${config.defaults.profile}` };
    if (!context.target) return { valid: false, message: `OpenCode target not found: ${context.profile.defaultTargetId}` };

    try {
      if (kind === "agent") {
        const agents = await runtime.listAgents({ target: context.target });
        if (agents.some((agent) => agent.id === value)) return { valid: true };

        return { valid: false, message: `Agent not found: ${value}. Run /agents to see available agents.` };
      }

      const models = await runtime.listModels({ target: context.target });
      if (models.some((model) => model.id === value)) return { valid: true };

      return { valid: false, message: `Model not found: ${value}. Run /models to see available models.` };
    } catch (error) {
      return { valid: false, message: `Unable to validate ${kind}: ${formatError(error)}` };
    }
  }

  function getConversationRuntimeContext(message: InboundMessage): {
    binding?: ConversationBindingRecord;
    profile?: ProfileRecord;
    target?: TargetRecord;
  } {
    const binding = repositories.bindings.getByConversationKey(message.conversation.key);
    const profile = binding ? repositories.profiles.getById(binding.profileId) : getDefaultProfile();
    const target = getEffectiveTarget(binding, profile);

    return { binding, profile, target };
  }

  function getCurrentProfileId(message: InboundMessage): string {
    return repositories.bindings.getByConversationKey(message.conversation.key)?.profileId ?? config.defaults.profile;
  }

  function getCurrentProfileForPolicy(message: InboundMessage): ProfileRecord | undefined {
    return repositories.profiles.getById(getCurrentProfileId(message));
  }

  function getDefaultProfile(): ProfileRecord | undefined {
    return repositories.profiles.getById(config.defaults.profile);
  }

  function getTarget(targetId: string | undefined): TargetRecord | undefined {
    return targetId ? repositories.targets.getById(targetId) : undefined;
  }

  function getEffectiveTarget(
    binding: ConversationBindingRecord | undefined,
    profile: ProfileRecord | undefined,
  ): TargetRecord | undefined {
    if (!profile) return undefined;
    const targetId = binding?.targetSource === "explicit_bind" ? binding.targetId : profile.defaultTargetId;

    return getTarget(targetId);
  }
}

function parseCommand(message: InboundMessage): ParsedCommand | undefined {
  const text = (message.commandText ?? message.text).trim();
  if (!text.startsWith("/")) return undefined;

  const [token = "", ...args] = text.slice(1).split(/\s+/).filter(Boolean);
  const commandName = token.split("@")[0]?.toLowerCase();

  if (!commandName) return undefined;

  return {
    name: commandName,
    args,
  };
}

function unknownCommandText(commandName: string): string {
  return `Unknown command: /${commandName}\nRun /help to see available commands.`;
}

function deniedDecisionText(reason: "unknown_sender" | "blocked"): string {
  return reason === "blocked" ? "Access denied: this sender is blocked." : "Access denied: this sender is not allowlisted.";
}

function markdown(text: string): OutboundMessage {
  return { kind: "status", format: "markdown", text };
}

function formatProfile(profile: ProfileRecord | undefined): string {
  if (!profile) return "unknown";
  return `${profile.displayName} (${profile.id})`;
}

function formatTarget(target: TargetRecord | undefined): string {
  if (!target) return "unknown";
  return `${target.name} (${target.id})`;
}

function formatTargetHealth(health: CommandTargetHealth): string {
  if (typeof health === "string") return health;

  return health.lastError ? `${health.status}: ${health.lastError}` : health.status;
}

function formatTargetSource(binding: ConversationBindingRecord | undefined): string {
  if (binding?.targetSource === "explicit_bind") return "explicit bind";
  return "profile default";
}

function formatCommandPolicy(profile: ProfileRecord | undefined): string {
  return profile?.commandPolicyId ? `profile:${profile.commandPolicyId}` : "default";
}

function formatGatewayDegraded(health: CommandHealthSnapshot | undefined): string {
  if (!health || health.degraded === undefined) return "unknown";
  if (!health.degraded) return "false";

  return health.degradedReasons && health.degradedReasons.length > 0
    ? `true (${health.degradedReasons.join("; ")})`
    : "true";
}

function bindingNoopText(result: Extract<BindingOperationResult, { status: "noop" }>): string {
  if (result.reason === "already_bound") {
    return `Conversation is already explicitly bound to ${formatTarget(result.resolution?.target)}.`;
  }

  if (result.reason === "already_profile_default") {
    return `Target already follows the active profile default: ${formatTarget(result.resolution?.target)}.`;
  }

  return "No conversation binding exists to unbind.";
}

function bindingBlockedText(result: Extract<BindingOperationResult, { status: "blocked" }>): string {
  if (result.reason === "active_run") {
    return `Cannot change target binding while active run ${result.run.id} is running. Use /stop first.`;
  }

  if (result.reason === "queued_turns") {
    const noun = result.queueSize === 1 ? "turn is" : "turns are";
    return `Cannot change target binding while ${result.queueSize} queued ${noun} pending. Wait for the queue to drain.`;
  }

  return "Cannot change target binding right now.";
}

function formatRun(run: RunRecord | undefined, diagnostics?: ActiveTurnDiagnostics): string {
  if (!run) return "none";

  const parts = [
    `${run.id} (${run.status})`,
    `session=${run.opencodeSessionId}`,
    run.opencodeMessageId ? `message=${run.opencodeMessageId}` : undefined,
    diagnostics ? `age=${formatDuration(diagnostics.ageMs)}` : undefined,
    diagnostics ? `plan=${formatTurnPlan(diagnostics)}` : undefined,
    diagnostics?.lastEventType ? `lastEvent=${diagnostics.lastEventType}@${diagnostics.lastEventAt ?? "unknown"}` : undefined,
  ];

  return parts.filter(isNonEmptyString).join(" ");
}

function formatTurnPlan(diagnostics: ActiveTurnDiagnostics): string {
  const { finalSource, progressSource, permissionSource } = diagnostics.plan;

  return `final:${finalSource},progress:${progressSource},permissions:${permissionSource}`;
}

function formatPendingPermissions(permissions: ReturnType<PendingPermissionRepository["listPendingByRunId"]>): string {
  if (permissions.length === 0) return "none";

  const missingCards = permissions.filter((permission) => !permission.actionMessageReceiptId).length;
  return `${permissions.length} pending, ${missingCards} without action card`;
}

function formatQueue(diagnostics: ReturnType<TurnRunner["getQueueDiagnostics"]>): string {
  if (!diagnostics) return "none";

  const age = diagnostics.oldestAgeMs === undefined ? undefined : `, oldest age=${formatDuration(diagnostics.oldestAgeMs)}`;
  return `${diagnostics.size} pending${age ?? ""}`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;

  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes}m${remainingSeconds}s` : `${minutes}m`;
}

function stopResultText(run: RunRecord, remoteAbortError: string | undefined): string {
  const text = `Stopped active run ${run.id} for session ${run.opencodeSessionId}.`;

  return remoteAbortError ? `${text}\nRemote OpenCode abort failed: ${remoteAbortError}` : text;
}

function formatSessionLine(session: RuntimeSession, currentSessionId: string | undefined): string {
  const current = session.id === currentSessionId ? " (current)" : "";

  return `- ${session.id} "${formatSessionShortName(session.title)}"${current}`;
}

function formatSessionShortName(title: string | undefined): string {
  return (title ?? "").replaceAll('"', '\\"');
}

function formatProfileLine(profile: ProfileRecord, currentProfileId: string): string {
  const marker = profile.id === currentProfileId ? "*" : "-";
  const description = profile.description ? ` - ${profile.description}` : "";
  const defaults = [
    profile.defaultVerbosity ? `verbosity=${profile.defaultVerbosity}` : undefined,
    profile.defaultBusyMode ? `busy=${profile.defaultBusyMode}` : undefined,
  ].filter(isNonEmptyString).join(", ");
  const suffix = defaults ? ` [${defaults}]` : "";

  return `${marker} ${profile.id}: ${profile.displayName}${suffix}${description}`;
}

function formatTargetLine(
  target: TargetRecord,
  context: { binding?: ConversationBindingRecord; profile?: ProfileRecord; target?: TargetRecord },
  health: CommandHealthSnapshot | undefined,
): string {
  const marker = context.target?.id === target.id ? "*" : "-";
  const status = formatTargetHealth(health?.targets?.[target.id] ?? "configured");
  const markers = formatTargetMarkers(target, context);
  const markerText = markers.length > 0 ? ` ${markers.join(", ")}` : "";
  const defaultText = formatTargetDefaults(target);

  return `${marker} ${target.id}: ${target.name} [${target.mode}, ${status}]${markerText}${defaultText}`;
}

function formatTargetMarkers(
  target: TargetRecord,
  context: { binding?: ConversationBindingRecord; profile?: ProfileRecord; target?: TargetRecord },
): string[] {
  return [
    context.target?.id === target.id ? "current" : undefined,
    context.profile?.defaultTargetId === target.id ? "profile default" : undefined,
    context.binding?.targetSource === "explicit_bind" && context.binding.targetId === target.id ? "explicit bind" : undefined,
  ].filter(isNonEmptyString);
}

function formatTargetDefaults(target: TargetRecord): string {
  const defaults = [
    target.defaultAgent ? `agent=${target.defaultAgent}` : undefined,
    target.defaultModel ? `model=${target.defaultModel}` : undefined,
  ].filter(isNonEmptyString);

  return defaults.length > 0 ? ` defaults: ${defaults.join(", ")}` : "";
}

function formatEffectiveVerbosity(
  binding: ConversationBindingRecord | undefined,
  profile: ProfileRecord | undefined,
  gatewayDefault: string,
): string {
  if (binding) return `${binding.verbosity} (binding)`;
  if (profile?.defaultVerbosity) return `${profile.defaultVerbosity} (profile default)`;
  return `${gatewayDefault} (gateway default)`;
}

function formatAgentLine(agent: RuntimeAgent, currentAgent: string | undefined): string {
  const marker = agent.id === currentAgent ? "*" : "-";
  const name = agent.name ? ` (${agent.name})` : "";
  const description = agent.description ? ` - ${agent.description}` : "";

  return `${marker} ${agent.id}${name}${description}`;
}

function formatModelLine(model: RuntimeModel, currentModel: string | undefined): string {
  const marker = model.id === currentModel ? "*" : "-";
  const name = model.name ? ` (${model.name})` : "";

  return `${marker} ${model.id}${name}`;
}

function formatClearedOverrideLines(
  clearedOverrides: Array<{ kind: BindingOverrideKind; value: string; targetId: string }> | undefined,
  binding: ConversationBindingRecord,
  profile: ProfileRecord,
  target: TargetRecord,
): string[] {
  if (!clearedOverrides || clearedOverrides.length === 0) return [];

  const lines = clearedOverrides.map((override) => (
    `Cleared ${override.kind} override: ${override.value} is not available on target ${override.targetId}.`
  ));

  if (clearedOverrides.some((override) => override.kind === "agent")) {
    lines.push(`Effective agent: ${formatEffectiveValue(resolveEffectiveAgentValue(binding, profile, target))}`);
  }

  if (clearedOverrides.some((override) => override.kind === "model")) {
    lines.push(`Effective model: ${formatEffectiveValue(resolveEffectiveModelValue(binding, profile, target))}`);
  }

  return lines;
}

function resolveEffectiveValue(
  kind: BindingOverrideKind,
  binding: ConversationBindingRecord | undefined,
  profile: ProfileRecord | undefined,
  target: TargetRecord | undefined,
): EffectiveRuntimeValue {
  if (kind === "agent") return resolveEffectiveAgentValue(binding, profile, target);
  return resolveEffectiveModelValue(binding, profile, target);
}

function resolveEffectiveAgentValue(
  binding: ConversationBindingRecord | undefined,
  profile: ProfileRecord | undefined,
  target: TargetRecord | undefined,
): EffectiveRuntimeValue {
  return resolveEffectiveRuntimeValue(binding?.agent, profile?.defaultAgent, target?.defaultAgent);
}

function resolveEffectiveModelValue(
  binding: ConversationBindingRecord | undefined,
  profile: ProfileRecord | undefined,
  target: TargetRecord | undefined,
): EffectiveRuntimeValue {
  return resolveEffectiveRuntimeValue(binding?.model, profile?.defaultModel, target?.defaultModel);
}

function resolveEffectiveRuntimeValue(
  bindingValue: string | undefined,
  profileValue: string | undefined,
  targetValue: string | undefined,
): EffectiveRuntimeValue {
  if (bindingValue) return { value: bindingValue, source: "binding override" };
  if (profileValue) return { value: profileValue, source: "profile default" };
  if (targetValue) return { value: targetValue, source: "target default" };
  return { source: "none" };
}

function formatEffectiveValue(value: EffectiveRuntimeValue): string {
  return value.value ? `${value.value} (${value.source})` : "none";
}

function overrideValue(kind: BindingOverrideKind, binding: ConversationBindingRecord | undefined): string | undefined {
  return kind === "agent" ? binding?.agent : binding?.model;
}

function profileDefaultValue(kind: BindingOverrideKind, profile: ProfileRecord | undefined): string | undefined {
  return kind === "agent" ? profile?.defaultAgent : profile?.defaultModel;
}

function targetDefaultValue(kind: BindingOverrideKind, target: TargetRecord | undefined): string | undefined {
  return kind === "agent" ? target?.defaultAgent : target?.defaultModel;
}

function overrideLabel(kind: BindingOverrideKind): string {
  return kind === "agent" ? "Agent" : "Model";
}

function overrideUsage(kind: BindingOverrideKind): string {
  if (kind === "agent") return "Usage: `/agent [name|default|clear]`";
  return "Usage: `/model [id|default|clear]`";
}

function isClearOverrideValue(value: string): boolean {
  const normalized = value.toLowerCase();

  return normalized === "default" || normalized === "clear";
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function permissionDecisionArg(value: string | undefined): PermissionDecision | undefined {
  if (value === "approve") return "approve";
  if (value === "always") return "always";
  if (value === "deny") return "deny";
  return undefined;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
