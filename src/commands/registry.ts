import type { InboundMessage } from "../channels/types.ts";
import type { GatewayConfig } from "../config/schema.ts";
import type { DispatchResolver, DispatchResolverRepositories } from "../dispatch/resolver.ts";
import type { ConversationBindingRecord, ProfileRecord, RunRecord, TargetRecord } from "../db/types.ts";
import type { TurnRunner } from "../gateway/turn-runner.ts";
import type { OutboundMessage } from "../messages/types.ts";
import type { AgentRuntime, RuntimeSession } from "../opencode/types.ts";

export type GatewayHealthStatus = "healthy" | "unhealthy" | "unknown" | "configured" | (string & {});

export interface CommandHealthSnapshot {
  gateway?: GatewayHealthStatus;
  targets?: Record<string, GatewayHealthStatus>;
}

export interface CommandRouterOptions {
  config: GatewayConfig;
  repositories: DispatchResolverRepositories;
  resolver: DispatchResolver;
  runtime: AgentRuntime;
  turnRunner: TurnRunner;
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

export function createCommandRouter(options: CommandRouterOptions): CommandRouter {
  const { config, repositories, resolver, runtime, turnRunner } = options;

  return {
    async handle(message): Promise<CommandRouterResult> {
      const parsed = parseCommand(message);
      if (!parsed) return { handled: false };

      const denied = accessDeniedText(message);
      if (denied) return { handled: true, command: parsed.name, messages: [markdown(denied)] };

      const response = await executeCommand(parsed, message);
      return { handled: true, command: parsed.name, messages: [markdown(response)] };
    },
  };

  async function executeCommand(command: ParsedCommand, message: InboundMessage): Promise<string> {
    switch (command.name) {
      case "help":
        return helpText();
      case "status":
        return statusText(message);
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
      "OpenCode Gateway commands:",
      "",
      "`/help` - Show this help.",
      "`/status` - Show current routing and run status.",
      "`/new` or `/reset` - Create a fresh OpenCode session for this conversation.",
      "`/stop` - Abort the active run for this conversation.",
      "`/sessions` - List recent OpenCode sessions for the active target.",
      "`/use-session <id>` - Rebind this conversation to an existing session.",
      "`/profiles` - List available gateway profiles.",
      "`/profile [id]` - Show or switch the active profile.",
    ].join("\n");
  }

  function statusText(message: InboundMessage): string {
    const decision = resolver.authorizeSender(message);
    if (!decision.allowed) return deniedDecisionText(decision.reason);

    const binding = repositories.bindings.getByConversationKey(message.conversation.key);
    const profile = binding ? repositories.profiles.getById(binding.profileId) : getDefaultProfile();
    const target = binding ? repositories.targets.getById(binding.targetId) : getTarget(profile?.defaultTargetId);
    const activeRun = binding ? repositories.runs.getActiveByBindingId(binding.id) : undefined;
    const health = options.getHealth?.();
    const targetHealth = target ? (health?.targets?.[target.id] ?? "configured") : "unknown";

    return [
      "Gateway status:",
      `Channel: ${message.channel}:${message.accountId}`,
      `Conversation: ${message.conversation.key}`,
      `Role: ${decision.role}`,
      `Profile: ${formatProfile(profile)}`,
      `Target: ${formatTarget(target)} (${targetHealth})`,
      `Session: ${binding?.opencodeSessionId ?? "none"}${binding?.sessionName ? ` (${binding.sessionName})` : ""}`,
      `Active run: ${formatRun(activeRun)}`,
      `Gateway health: ${health?.gateway ?? "unknown"}`,
    ].join("\n");
  }

  async function resetText(message: InboundMessage, commandName: string): Promise<string> {
    const stopped = await stopActiveRunForRebind(message);

    if (stopped?.status === "error") return stopped.message;

    const result = await resolver.resetSession(message);

    if (result.status === "denied") return deniedDecisionText(result.decision.reason);
    if (result.status === "not_found") return `${titleCase(result.resource)} not found: ${result.id}`;
    if (result.status === "error") return `Unable to create a new session: ${result.error}`;

    return [
      stopped?.message,
      commandName === "new" ? "Created a new OpenCode session." : "Reset this conversation to a new OpenCode session.",
      result.previousSessionId ? `Previous session: ${result.previousSessionId}` : undefined,
      `Current session: ${result.session.id}`,
      `Profile: ${result.resolution.profile.displayName} (${result.resolution.profile.id})`,
      `Target: ${result.resolution.target.name} (${result.resolution.target.id})`,
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

    const target = repositories.targets.getById(binding.targetId);
    if (!target) return `OpenCode target not found: ${binding.targetId}`;

    try {
      const result = await turnRunner.abortActive({
        binding,
        target,
        reason: "Stopped by gateway /stop command",
      });

      if (result.status === "no_active_run") return "No active run for this conversation.";
      if (result.status === "error") return `Unable to stop active run ${result.run.id}: ${result.error}`;

      return `Stopped active run ${result.run.id} for session ${result.run.opencodeSessionId}.`;
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

    const target = repositories.targets.getById(binding.targetId);
    if (!target) return { status: "error", message: `OpenCode target not found: ${binding.targetId}` };

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
        message: `Stopped active run ${result.run.id} for session ${result.run.opencodeSessionId}.`,
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

      return sessions.map((session) => formatSessionLine(session, context.binding?.opencodeSessionId)).join("\n");
    } catch (error) {
      return `Unable to list sessions: ${formatError(error)}`;
    }
  }

  async function useSessionText(message: InboundMessage, sessionId: string | undefined): Promise<string> {
    if (!sessionId) return "Usage: `/use-session <id>`";

    const result = await resolver.useSession(message, sessionId);

    if (result.status === "denied") return deniedDecisionText(result.decision.reason);
    if (result.status === "not_found") return `${titleCase(result.resource)} not found: ${result.id}`;
    if (result.status === "error") return `Unable to use session ${sessionId}: ${result.error}`;

    return [
      `Conversation rebound to session ${result.session.id}.`,
      result.previousSessionId ? `Previous session: ${result.previousSessionId}` : undefined,
      `Profile: ${result.resolution.profile.displayName} (${result.resolution.profile.id})`,
      `Target: ${result.resolution.target.name} (${result.resolution.target.id})`,
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

    return ["Gateway profiles:", ...profiles.map((profile) => formatProfileLine(profile, currentProfileId))].join("\n");
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
      `Session: ${context.binding?.opencodeSessionId ?? "none"}`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  async function switchProfileText(message: InboundMessage, profileId: string | undefined): Promise<string> {
    if (!profileId) return "Usage: `/profile <id>`";

    const result = await resolver.switchProfile(message, profileId);

    if (result.status === "denied") return deniedDecisionText(result.decision.reason);
    if (result.status === "not_found") return `${titleCase(result.resource)} not found: ${result.id}`;
    if (result.status === "error") return `Unable to switch profile: ${result.error}`;

    return [
      `Switched profile to ${result.resolution.profile.displayName} (${result.resolution.profile.id}).`,
      result.previousSessionId && result.previousSessionId !== result.session.id
        ? `Previous session: ${result.previousSessionId}`
        : undefined,
      `Current session: ${result.session.id}`,
      `Target: ${result.resolution.target.name} (${result.resolution.target.id})`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function getConversationRuntimeContext(message: InboundMessage): {
    binding?: ConversationBindingRecord;
    profile?: ProfileRecord;
    target?: TargetRecord;
  } {
    const binding = repositories.bindings.getByConversationKey(message.conversation.key);
    const profile = binding ? repositories.profiles.getById(binding.profileId) : getDefaultProfile();
    const target = binding ? repositories.targets.getById(binding.targetId) : getTarget(profile?.defaultTargetId);

    return { binding, profile, target };
  }

  function getCurrentProfileId(message: InboundMessage): string {
    return repositories.bindings.getByConversationKey(message.conversation.key)?.profileId ?? config.defaults.profile;
  }

  function getDefaultProfile(): ProfileRecord | undefined {
    return repositories.profiles.getById(config.defaults.profile);
  }

  function getTarget(targetId: string | undefined): TargetRecord | undefined {
    return targetId ? repositories.targets.getById(targetId) : undefined;
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

function formatRun(run: RunRecord | undefined): string {
  if (!run) return "none";
  return `${run.id} (${run.status})`;
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

  return `${marker} ${profile.id}: ${profile.displayName}${description}`;
}

function titleCase(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
