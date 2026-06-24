import type { ChannelAction, InboundMessage, SendReceipt } from "../channels/types.ts";
import type { AccessRole, InteractivePermissionsConfig } from "../config/schema.ts";
import type { AccessRuleRepository } from "../db/repositories/access-rules.ts";
import type { ConversationBindingRepository } from "../db/repositories/conversation-bindings.ts";
import type { PendingPermissionRepository } from "../db/repositories/pending-permissions.ts";
import type { RunRepository } from "../db/repositories/runs.ts";
import type { TargetRepository } from "../db/repositories/targets.ts";
import type { PendingPermissionRecord, RunRecord } from "../db/types.ts";
import type { ProgressDelivery } from "../delivery/renderer.ts";
import type { ResolvedDispatch } from "../dispatch/resolver.ts";
import type { OutboundAction, OutboundMessage } from "../messages/types.ts";
import type { GatewayLogContext, GatewayLogLevel } from "../observability/logging.ts";
import type { AgentRuntime, PermissionResponseInput, RuntimeEvent } from "../opencode/types.ts";

export const PERMISSION_APPROVE_ACTION = "permission.approve";
export const PERMISSION_ALWAYS_ACTION = "permission.always";
export const PERMISSION_DENY_ACTION = "permission.deny";

export type PermissionDecision = PermissionResponseInput["decision"];

export interface PermissionInteractionRepositories {
  accessRules: AccessRuleRepository;
  bindings: ConversationBindingRepository;
  pendingPermissions: PendingPermissionRepository;
  runs: RunRepository;
  targets: TargetRepository;
}

export interface PermissionInteractionOptions {
  config: InteractivePermissionsConfig;
  repositories: PermissionInteractionRepositories;
  runtime: AgentRuntime;
  now?: () => Date;
  log?: (level: GatewayLogLevel, message: string, context?: GatewayLogContext) => void;
}

export interface SendPermissionRequestInput {
  permission: PendingPermissionRecord;
  event: Extract<RuntimeEvent, { type: "permission_request" }>;
  run: RunRecord;
  resolution: ResolvedDispatch;
  delivery: ProgressDelivery;
}

export interface PermissionInteractionService {
  sendPermissionRequest(input: SendPermissionRequestInput): Promise<void>;
  handleAction(action: ChannelAction, delivery: ProgressDelivery): Promise<boolean>;
  handleFallbackCommand(message: InboundMessage, decision: PermissionDecision, permissionId: string | undefined): Promise<OutboundMessage>;
}

interface PermissionActor {
  channel: string;
  accountId: string;
  senderId: string;
  displayName?: string;
}

interface ResolvePermissionInput {
  permissionId: string | undefined;
  decision: PermissionDecision;
  actor: PermissionActor;
}

export function createPermissionInteractionService(options: PermissionInteractionOptions): PermissionInteractionService {
  const { config, repositories, runtime } = options;
  const now = options.now ?? (() => new Date());

  function log(level: GatewayLogLevel, message: string, context: GatewayLogContext = {}): void {
    options.log?.(level, message, context);
  }

  return {
    async sendPermissionRequest(input): Promise<void> {
      if (config.mode === "off") return;

      const message = permissionRequestMessage(input, config);

      try {
        const receipt = await input.delivery.send(message);

        if (receipt) {
          repositories.pendingPermissions.setActionMessageReceiptId({
            id: input.permission.id,
            actionMessageReceiptId: receipt.platformMessageId,
          });
        }

        log("info", "permission request card sent", {
          source: "channel",
          profileId: input.resolution.profile.id,
          targetId: input.resolution.target.id,
          sessionId: input.run.opencodeSessionId,
          runId: input.run.id,
          permissionId: input.permission.id,
          opencodePermissionId: input.permission.opencodePermissionId,
        });
      } catch (error) {
        log("error", "permission request card failed", {
          source: "channel",
          profileId: input.resolution.profile.id,
          targetId: input.resolution.target.id,
          sessionId: input.run.opencodeSessionId,
          runId: input.run.id,
          permissionId: input.permission.id,
          error: formatError(error),
        });
      }
    },

    async handleAction(action, delivery): Promise<boolean> {
      const decision = actionDecision(action.actionId);
      if (!decision) return false;

      const result = await resolvePermission({
        permissionId: action.value,
        decision,
        actor: {
          channel: action.channel,
          accountId: action.accountId,
          senderId: action.sender.id,
          displayName: action.sender.displayName ?? action.sender.username,
        },
      });

      await deliverActionResolution(action, delivery, result);
      return true;
    },

    async handleFallbackCommand(message, decision, permissionId): Promise<OutboundMessage> {
      if (!config.fallbackCommands) {
        return statusMessage("Permission fallback commands are disabled by configuration.");
      }

      const result = await resolvePermission({
        permissionId,
        decision,
        actor: {
          channel: message.channel,
          accountId: message.accountId,
          senderId: message.sender.id,
          displayName: message.sender.displayName ?? message.sender.username,
        },
      });

      return result.message;
    },
  };

  async function resolvePermission(input: ResolvePermissionInput): Promise<{ message: OutboundMessage; editOriginal: boolean }> {
    if (!input.permissionId) {
      return { message: statusMessage("Usage: `/permission approve <id>`, `/permission deny <id>`, or `/permission always <id>`"), editOriginal: false };
    }

    if (input.decision === "always" && !config.allowAlways) {
      return { message: statusMessage("Always allow is disabled by configuration."), editOriginal: false };
    }

    const role = repositories.accessRules.getRole({
      channel: input.actor.channel,
      accountId: input.actor.accountId,
      senderId: input.actor.senderId,
    });

    if (!isPermissionApprover(role)) {
      return { message: errorMessage("Permission responses require owner/admin access."), editOriginal: false };
    }

    const permission = repositories.pendingPermissions.getById(input.permissionId);
    if (!permission) return { message: errorMessage(`Permission request not found: ${input.permissionId}`), editOriginal: false };

    if (permission.status !== "pending") {
      return { message: statusMessage(`Permission request ${permission.id} is already ${permission.status}.`), editOriginal: true };
    }

    if (Date.parse(permission.expiresAt) <= now().getTime()) {
      repositories.pendingPermissions.resolve({ id: permission.id, status: "expired" });
      return { message: statusMessage(`Permission request ${permission.id} expired.`), editOriginal: true };
    }

    const context = permissionRuntimeContext(permission);
    if (!context.ok) return { message: errorMessage(context.error), editOriginal: false };

    if (context.run.status !== "active") {
      repositories.pendingPermissions.resolve({ id: permission.id, status: "expired" });
      return {
        message: statusMessage(`Permission request ${permission.id} expired because run ${context.run.id} is ${context.run.status}.`),
        editOriginal: true,
      };
    }

    try {
      await runtime.respondToPermission({
        target: context.target,
        sessionId: context.run.opencodeSessionId,
        permissionId: permission.opencodePermissionId,
        decision: input.decision,
      });

      repositories.pendingPermissions.resolve({
        id: permission.id,
        status: input.decision === "deny" ? "denied" : "approved",
      });

      log("info", "permission resolved", {
        source: "channel",
        targetId: context.target.id,
        sessionId: context.run.opencodeSessionId,
        runId: context.run.id,
        permissionId: permission.id,
        opencodePermissionId: permission.opencodePermissionId,
        permissionDecision: input.decision,
      });

      return {
        message: statusMessage(permissionResolvedText(permission, input.decision, input.actor.displayName)),
        editOriginal: true,
      };
    } catch (error) {
      const message = `Unable to respond to permission ${permission.id}: ${formatError(error)}`;

      log("error", "permission response failed", {
        source: "channel",
        targetId: context.target.id,
        sessionId: context.run.opencodeSessionId,
        runId: context.run.id,
        permissionId: permission.id,
        opencodePermissionId: permission.opencodePermissionId,
        permissionDecision: input.decision,
        error: formatError(error),
      });

      return { message: errorMessage(message), editOriginal: false };
    }
  }

  function permissionRuntimeContext(
    permission: PendingPermissionRecord,
  ):
    | { ok: true; run: RunRecord; target: NonNullable<ReturnType<TargetRepository["getById"]>> }
    | { ok: false; error: string } {
    const run = repositories.runs.getById(permission.runId);
    if (!run) return { ok: false, error: `Run not found for permission ${permission.id}: ${permission.runId}` };

    const binding = run.targetId ? undefined : repositories.bindings.getById(run.bindingId);
    if (!run.targetId && !binding) return { ok: false, error: `Binding not found for permission ${permission.id}: ${run.bindingId}` };

    const targetId = run.targetId ?? binding?.targetId;
    if (!targetId) return { ok: false, error: `OpenCode target not found for permission ${permission.id}` };

    const target = repositories.targets.getById(targetId);
    if (!target) return { ok: false, error: `OpenCode target not found for permission ${permission.id}: ${targetId}` };

    return { ok: true, run, target };
  }
}

function permissionRequestMessage(input: SendPermissionRequestInput, config: InteractivePermissionsConfig): OutboundMessage {
  const actions = config.mode === "buttons" ? permissionActions(input.permission.id, config.allowAlways) : undefined;
  const commandHints = config.fallbackCommands ? fallbackCommandHints(input.permission.id, config.allowAlways) : [];
  const details = permissionCardDetails(input.permission);
  const lines = [
    "OpenCode permission required",
    details.action ? `Action: ${details.action}` : `Summary: ${input.permission.summary}`,
    details.command ? `Command:\n${details.command}` : undefined,
    !details.command && details.resource ? `Resource: ${details.resource}` : undefined,
    details.action && details.action !== input.permission.summary ? `Summary: ${input.permission.summary}` : undefined,
    `Target: ${input.resolution.target.name} (${input.resolution.target.id})`,
    `Session: ${input.run.opencodeSessionId}`,
    `Permission: ${input.permission.id}`,
    `Expires: ${input.permission.expiresAt}`,
    ...commandHints,
  ].filter(isNonEmptyString);

  return {
    kind: "status",
    format: "markdown",
    text: lines.join("\n"),
    actions,
  };
}

interface PermissionCardDetails {
  action?: string;
  command?: string;
  resource?: string;
}

function permissionCardDetails(permission: PendingPermissionRecord): PermissionCardDetails {
  const details = asRecord(permission.details);
  const metadata = asRecord(details?.metadata);
  const action = firstString(
    details?.action,
    details?.permission,
    details?.tool,
    details?.type,
  );
  const explicitCommand = firstString(details?.command, metadata?.command);
  const resource = firstResource(details?.resources, details?.resource, details?.pattern, details?.patterns);
  const command = explicitCommand ?? (isBashAction(action) ? resource : undefined);

  return {
    action,
    command,
    resource,
  };
}

function isBashAction(action: string | undefined): boolean {
  return action === "bash" || action === "shell" || action === "terminal";
}

function firstResource(...values: unknown[]): string | undefined {
  for (const value of values) {
    const formatted = formatResource(value);
    if (formatted) return formatted;
  }

  return undefined;
}

function formatResource(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();

  if (Array.isArray(value)) {
    const formatted = value.map(formatResource).filter(isNonEmptyString);
    if (formatted.length > 0) return formatted.join("\n");
  }

  const record = asRecord(value);
  if (record) {
    return firstString(record.command, record.resource, record.pattern, record.path, record.name);
  }

  return undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function permissionActions(permissionId: string, allowAlways: boolean): OutboundAction[] {
  const actions: OutboundAction[] = [
    { id: PERMISSION_APPROVE_ACTION, label: "Approve once", style: "primary", value: permissionId },
  ];

  if (allowAlways) {
    actions.push({ id: PERMISSION_ALWAYS_ACTION, label: "Always allow", style: "primary", value: permissionId });
  }

  actions.push({ id: PERMISSION_DENY_ACTION, label: "Deny", style: "danger", value: permissionId });

  return actions;
}

function fallbackCommandHints(permissionId: string, allowAlways: boolean): string[] {
  const commands = [`/permission approve ${permissionId}`];

  if (allowAlways) commands.push(`/permission always ${permissionId}`);
  commands.push(`/permission deny ${permissionId}`);

  return ["Fallback commands:", ...commands.map((command) => `\`${command}\``)];
}

function actionDecision(actionId: string): PermissionDecision | undefined {
  if (actionId === PERMISSION_APPROVE_ACTION) return "approve";
  if (actionId === PERMISSION_ALWAYS_ACTION) return "always";
  if (actionId === PERMISSION_DENY_ACTION) return "deny";
  return undefined;
}

async function deliverActionResolution(
  action: ChannelAction,
  delivery: ProgressDelivery,
  result: { message: OutboundMessage; editOriginal: boolean },
): Promise<void> {
  if (result.editOriginal && action.message && delivery.edit) {
    try {
      await delivery.edit(actionReceipt(action), result.message);
      return;
    } catch {
      // Fall through to sending a reply when editing is unavailable or rejected.
    }
  }

  await delivery.send(result.message);
}

function actionReceipt(action: ChannelAction): SendReceipt {
  return {
    channel: action.channel,
    accountId: action.accountId,
    conversationKey: action.conversation.key,
    platformMessageId: action.message?.id ?? "",
    timestamp: action.message?.timestamp ?? action.timestamp,
    raw: { chatId: action.conversation.id },
  };
}

function permissionResolvedText(permission: PendingPermissionRecord, decision: PermissionDecision, actorName: string | undefined): string {
  const actor = actorName ? ` by ${actorName}` : "";
  if (decision === "deny") return `Permission ${permission.id} denied${actor}.`;
  if (decision === "always") return `Permission ${permission.id} approved always${actor}.`;
  return `Permission ${permission.id} approved once${actor}.`;
}

function isPermissionApprover(role: AccessRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

function statusMessage(text: string): OutboundMessage {
  return { kind: "status", format: "markdown", text };
}

function errorMessage(text: string): OutboundMessage {
  return { kind: "error", format: "plain", text };
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}
