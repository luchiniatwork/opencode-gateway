import type { InboundAttachment, InboundMessage } from "../channels/types.ts";
import type { AccessRole, BusyMode, GatewayConfig, Verbosity } from "../config/schema.ts";
import type { ConversationBindingRepository } from "../db/repositories/conversation-bindings.ts";
import type { AccessRuleRepository } from "../db/repositories/access-rules.ts";
import type { ProfileRepository } from "../db/repositories/profiles.ts";
import type { RunRepository } from "../db/repositories/runs.ts";
import type { TargetRepository } from "../db/repositories/targets.ts";
import type { ConversationBindingRecord, ProfileRecord, RunRecord, TargetRecord } from "../db/types.ts";
import type {
  AgentRuntime,
  RuntimeAttachment,
  RuntimeSession,
  RuntimeSessionId,
  RuntimeTurn,
} from "../opencode/types.ts";

export type AccessDecision =
  | { allowed: true; role: Exclude<AccessRole, "blocked"> }
  | { allowed: false; reason: "unknown_sender" | "blocked"; role?: AccessRole };

export interface ResolvedDispatch {
  role: Exclude<AccessRole, "blocked">;
  binding: ConversationBindingRecord;
  profile: ProfileRecord;
  target: TargetRecord;
  agent?: string;
  model?: string;
}

export type ResolveBindingResult =
  | { status: "resolved"; resolution: ResolvedDispatch }
  | { status: "denied"; decision: Extract<AccessDecision, { allowed: false }> };

export type DispatchMessageResult =
  | { status: "sent"; resolution: ResolvedDispatch; run: RunRecord; turn: RuntimeTurn }
  | { status: "busy"; resolution: ResolvedDispatch; run: RunRecord }
  | { status: "denied"; decision: Extract<AccessDecision, { allowed: false }> }
  | { status: "error"; resolution: ResolvedDispatch; run: RunRecord; error: string };

export type BindingOperationResult =
  | {
      status: "rebound";
      resolution: ResolvedDispatch;
      session: RuntimeSession;
      previousSessionId?: RuntimeSessionId;
    }
  | { status: "denied"; decision: Extract<AccessDecision, { allowed: false }> }
  | { status: "not_found"; resource: "profile" | "target"; id: string }
  | { status: "error"; error: string };

export interface DispatchResolverRepositories {
  accessRules: AccessRuleRepository;
  bindings: ConversationBindingRepository;
  profiles: ProfileRepository;
  targets: TargetRepository;
  runs: RunRepository;
}

export interface DispatchResolverOptions {
  config: GatewayConfig;
  repositories: DispatchResolverRepositories;
  runtime: AgentRuntime;
}

export interface DispatchResolver {
  authorizeSender(message: InboundMessage): AccessDecision;
  ensureBindingForMessage(message: InboundMessage): Promise<ResolveBindingResult>;
  dispatchMessage(message: InboundMessage): Promise<DispatchMessageResult>;
  resetSession(message: InboundMessage): Promise<BindingOperationResult>;
  useSession(message: InboundMessage, sessionId: RuntimeSessionId): Promise<BindingOperationResult>;
  switchProfile(message: InboundMessage, profileId: string): Promise<BindingOperationResult>;
}

export class DispatchResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DispatchResolverError";
  }
}

export function createDispatchResolver(options: DispatchResolverOptions): DispatchResolver {
  const { config, repositories, runtime } = options;

  return {
    authorizeSender(message): AccessDecision {
      const role = repositories.accessRules.getRole({
        channel: message.channel,
        accountId: message.accountId,
        senderId: message.sender.id,
      });

      if (!role) return { allowed: false, reason: "unknown_sender" };
      if (role === "blocked") return { allowed: false, reason: "blocked", role };

      return { allowed: true, role };
    },

    async ensureBindingForMessage(message): Promise<ResolveBindingResult> {
      const access = this.authorizeSender(message);
      if (!access.allowed) return { status: "denied", decision: access };

      const existing = repositories.bindings.getByConversationKey(message.conversation.key);
      const binding = existing ?? (await createDefaultBinding(message));
      const resolution = resolveBinding(binding, access.role);

      return { status: "resolved", resolution };
    },

    async dispatchMessage(message): Promise<DispatchMessageResult> {
      const bindingResult = await this.ensureBindingForMessage(message);

      if (bindingResult.status === "denied") return bindingResult;

      const { resolution } = bindingResult;
      const activeRun = repositories.runs.getActiveByBindingId(resolution.binding.id);

      if (activeRun) return { status: "busy", resolution, run: activeRun };

      const run = repositories.runs.create({
        bindingId: resolution.binding.id,
        opencodeSessionId: resolution.binding.opencodeSessionId,
      });

      try {
        const turn = await runtime.send({
          target: resolution.target,
          sessionId: resolution.binding.opencodeSessionId,
          text: message.text,
          attachments: mapAttachments(message.attachments),
          agent: resolution.agent,
          model: resolution.model,
          metadata: messageMetadata(message),
        });
        const status = turn.status === "completed" ? "completed" : turn.status === "aborted" ? "aborted" : "error";
        const finishedRun = repositories.runs.finish({
          id: run.id,
          status,
          opencodeMessageId: turn.id,
          error: status === "error" ? turn.text : undefined,
        });

        return { status: "sent", resolution, run: finishedRun ?? run, turn };
      } catch (error) {
        const messageText = formatError(error);
        const finishedRun = repositories.runs.finish({ id: run.id, status: "error", error: messageText });

        return { status: "error", resolution, run: finishedRun ?? run, error: messageText };
      }
    },

    async resetSession(message): Promise<BindingOperationResult> {
      const access = this.authorizeSender(message);
      if (!access.allowed) return { status: "denied", decision: access };

      const existing = repositories.bindings.getByConversationKey(message.conversation.key);
      const profile = existing ? requireProfile(existing.profileId) : requireDefaultProfile();
      const target = requireTarget(existing?.targetId ?? profile.defaultTargetId);
      const session = await createRuntimeSession(message, profile, target);
      const previousSessionId = existing?.opencodeSessionId;
      const binding = existing
        ? requireUpdatedBinding(
            repositories.bindings.updateSession({
              conversationKey: message.conversation.key,
              targetId: target.id,
              opencodeSessionId: session.id,
              sessionName: session.title,
            }),
            message.conversation.key,
          )
        : repositories.bindings.upsert({
            conversationKey: message.conversation.key,
            channel: message.channel,
            accountId: message.accountId,
            profileId: profile.id,
            targetId: target.id,
            opencodeSessionId: session.id,
            sessionName: session.title,
            busyMode: effectiveBusyMode(profile),
            verbosity: effectiveVerbosity(profile),
          });

      return {
        status: "rebound",
        resolution: resolveBinding(binding, access.role),
        session,
        previousSessionId,
      };
    },

    async useSession(message, sessionId): Promise<BindingOperationResult> {
      const access = this.authorizeSender(message);
      if (!access.allowed) return { status: "denied", decision: access };

      const existing = repositories.bindings.getByConversationKey(message.conversation.key);
      const profile = existing ? requireProfile(existing.profileId) : requireDefaultProfile();
      const target = requireTarget(existing?.targetId ?? profile.defaultTargetId);

      try {
        const session = await runtime.ensureSession({
          target,
          sessionId,
          profileId: profile.id,
          agent: effectiveAgent(undefined, profile, target),
          model: effectiveModel(undefined, profile, target),
          metadata: messageMetadata(message),
        });
        const previousSessionId = existing?.opencodeSessionId;
        const binding = existing
          ? requireUpdatedBinding(
              repositories.bindings.updateSession({
                conversationKey: message.conversation.key,
                targetId: target.id,
                opencodeSessionId: session.id,
                sessionName: session.title,
              }),
              message.conversation.key,
            )
          : repositories.bindings.upsert({
              conversationKey: message.conversation.key,
              channel: message.channel,
              accountId: message.accountId,
              profileId: profile.id,
              targetId: target.id,
              opencodeSessionId: session.id,
              sessionName: session.title,
              busyMode: effectiveBusyMode(profile),
              verbosity: effectiveVerbosity(profile),
            });

        return {
          status: "rebound",
          resolution: resolveBinding(binding, access.role),
          session,
          previousSessionId,
        };
      } catch (error) {
        return { status: "error", error: formatError(error) };
      }
    },

    async switchProfile(message, profileId): Promise<BindingOperationResult> {
      const access = this.authorizeSender(message);
      if (!access.allowed) return { status: "denied", decision: access };

      const profile = repositories.profiles.getById(profileId);
      if (!profile) return { status: "not_found", resource: "profile", id: profileId };

      const target = repositories.targets.getById(profile.defaultTargetId);
      if (!target) return { status: "not_found", resource: "target", id: profile.defaultTargetId };

      const existing = repositories.bindings.getByConversationKey(message.conversation.key);
      const shouldCreateSession = !existing || existing.targetId !== target.id;
      const session = shouldCreateSession
        ? await createRuntimeSession(message, profile, target)
        : { id: existing.opencodeSessionId, targetId: target.id, title: existing.sessionName };
      const previousSessionId = existing?.opencodeSessionId;
      const binding = existing
        ? requireUpdatedBinding(
            repositories.bindings.updateProfile({
              conversationKey: message.conversation.key,
              profileId: profile.id,
              targetId: target.id,
              opencodeSessionId: session.id,
              sessionName: session.title,
              busyMode: effectiveBusyMode(profile),
              verbosity: effectiveVerbosity(profile),
            }),
            message.conversation.key,
          )
        : repositories.bindings.upsert({
            conversationKey: message.conversation.key,
            channel: message.channel,
            accountId: message.accountId,
            profileId: profile.id,
            targetId: target.id,
            opencodeSessionId: session.id,
            sessionName: session.title,
            busyMode: effectiveBusyMode(profile),
            verbosity: effectiveVerbosity(profile),
          });

      return {
        status: "rebound",
        resolution: resolveBinding(binding, access.role),
        session,
        previousSessionId,
      };
    },
  };

  async function createDefaultBinding(message: InboundMessage): Promise<ConversationBindingRecord> {
    const profile = requireDefaultProfile();
    const target = requireTarget(profile.defaultTargetId);
    const session = await createRuntimeSession(message, profile, target);

    return repositories.bindings.upsert({
      conversationKey: message.conversation.key,
      channel: message.channel,
      accountId: message.accountId,
      profileId: profile.id,
      targetId: target.id,
      opencodeSessionId: session.id,
      sessionName: session.title,
      busyMode: effectiveBusyMode(profile),
      verbosity: effectiveVerbosity(profile),
    });
  }

  async function createRuntimeSession(
    message: InboundMessage,
    profile: ProfileRecord,
    target: TargetRecord,
  ): Promise<RuntimeSession> {
    return runtime.ensureSession({
      target,
      profileId: profile.id,
      agent: effectiveAgent(undefined, profile, target),
      model: effectiveModel(undefined, profile, target),
      metadata: messageMetadata(message),
    });
  }

  function resolveBinding(
    binding: ConversationBindingRecord,
    role: Exclude<AccessRole, "blocked">,
  ): ResolvedDispatch {
    const profile = requireProfile(binding.profileId);
    const target = requireTarget(binding.targetId);

    return {
      role,
      binding,
      profile,
      target,
      agent: effectiveAgent(binding, profile, target),
      model: effectiveModel(binding, profile, target),
    };
  }

  function requireDefaultProfile(): ProfileRecord {
    return requireProfile(config.defaults.profile);
  }

  function requireProfile(profileId: string): ProfileRecord {
    const profile = repositories.profiles.getById(profileId);
    if (!profile) throw new DispatchResolverError(`Profile not found: ${profileId}`);
    return profile;
  }

  function requireTarget(targetId: string): TargetRecord {
    const target = repositories.targets.getById(targetId);
    if (!target) throw new DispatchResolverError(`OpenCode target not found: ${targetId}`);
    return target;
  }

  function effectiveBusyMode(profile: ProfileRecord): BusyMode {
    return profile.defaultBusyMode ?? config.defaults.busyMode;
  }

  function effectiveVerbosity(profile: ProfileRecord): Verbosity {
    return profile.defaultVerbosity ?? config.defaults.verbosity;
  }
}

function effectiveAgent(
  binding: ConversationBindingRecord | undefined,
  profile: ProfileRecord,
  target: TargetRecord,
): string | undefined {
  return binding?.agent ?? profile.defaultAgent ?? target.defaultAgent;
}

function effectiveModel(
  binding: ConversationBindingRecord | undefined,
  profile: ProfileRecord,
  target: TargetRecord,
): string | undefined {
  return binding?.model ?? profile.defaultModel ?? target.defaultModel;
}

function requireUpdatedBinding(
  binding: ConversationBindingRecord | undefined,
  conversationKey: string,
): ConversationBindingRecord {
  if (!binding) throw new DispatchResolverError(`Conversation binding not found after update: ${conversationKey}`);
  return binding;
}

function mapAttachments(attachments: InboundAttachment[]): RuntimeAttachment[] | undefined {
  if (attachments.length === 0) return undefined;

  return attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    url: attachment.url,
  }));
}

function messageMetadata(message: InboundMessage): Record<string, unknown> {
  return {
    channel: message.channel,
    accountId: message.accountId,
    conversationKey: message.conversation.key,
    senderId: message.sender.id,
  };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
