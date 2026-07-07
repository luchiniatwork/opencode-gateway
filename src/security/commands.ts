import type { AccessRole } from "../config/schema.ts";

export type CommandPolicyAction =
  | "normal_chat"
  | "unknown_command"
  | "inspect_status"
  | "inspect_targets"
  | "inspect_profiles"
  | "inspect_runtime_options"
  | "reset_session"
  | "stop_run"
  | "list_sessions"
  | "use_session"
  | "switch_profile"
  | "bind_target"
  | "set_agent"
  | "set_model"
  | "respond_permission";

export type AuthorizedCommandRole = Exclude<AccessRole, "blocked">;

export type CommandAuthorizationDecision =
  | { allowed: true; role: AuthorizedCommandRole; policyId: string }
  | {
      allowed: false;
      reason: "unknown_sender" | "blocked" | "insufficient_role";
      role?: AccessRole;
      policyId: string;
      allowedRoles: AuthorizedCommandRole[];
    };

export interface CommandAuthorizationInput {
  role?: AccessRole;
  action: CommandPolicyAction;
  profile?: { commandPolicyId?: string };
}

const DEFAULT_ALLOWED_ROLES: Record<CommandPolicyAction, AuthorizedCommandRole[]> = {
  normal_chat: ["owner", "admin", "user"],
  unknown_command: ["owner", "admin", "user"],
  inspect_status: ["owner", "admin", "user"],
  inspect_targets: ["owner", "admin", "user"],
  inspect_profiles: ["owner", "admin", "user"],
  inspect_runtime_options: ["owner", "admin", "user"],
  reset_session: ["owner", "admin", "user"],
  stop_run: ["owner", "admin", "user"],
  list_sessions: ["owner", "admin", "user"],
  use_session: ["owner", "admin"],
  switch_profile: ["owner", "admin"],
  bind_target: ["owner", "admin"],
  set_agent: ["owner", "admin"],
  set_model: ["owner", "admin"],
  respond_permission: ["owner", "admin"],
};

const DEFAULT_DENIED_MESSAGES: Record<CommandPolicyAction, string> = {
  normal_chat: "Chat access requires owner/admin/user access.",
  unknown_command: "Command access requires owner/admin/user access.",
  inspect_status: "Status inspection requires owner/admin/user access.",
  inspect_targets: "Target inspection requires owner/admin/user access.",
  inspect_profiles: "Profile inspection requires owner/admin/user access.",
  inspect_runtime_options: "Runtime option inspection requires owner/admin/user access.",
  reset_session: "Session reset requires owner/admin/user access.",
  stop_run: "Stopping runs requires owner/admin/user access.",
  list_sessions: "Session listing requires owner/admin/user access.",
  use_session: "Session rebinding requires owner/admin access.",
  switch_profile: "Profile switching requires owner/admin access.",
  bind_target: "Target binding changes require owner/admin access.",
  set_agent: "Agent changes require owner/admin access.",
  set_model: "Model changes require owner/admin access.",
  respond_permission: "Permission responses require owner/admin access.",
};

export function authorizeCommandAction(input: CommandAuthorizationInput): CommandAuthorizationDecision {
  const policyId = input.profile?.commandPolicyId ?? "default";
  const allowedRoles = DEFAULT_ALLOWED_ROLES[input.action];

  if (!input.role) return { allowed: false, reason: "unknown_sender", policyId, allowedRoles };
  if (input.role === "blocked") return { allowed: false, reason: "blocked", role: input.role, policyId, allowedRoles };
  if (allowedRoles.includes(input.role)) return { allowed: true, role: input.role, policyId };

  return {
    allowed: false,
    reason: "insufficient_role",
    role: input.role,
    policyId,
    allowedRoles,
  };
}

export function gatewayCommandAction(commandName: string, args: readonly string[]): CommandPolicyAction {
  switch (commandName) {
    case "help":
    case "status":
      return "inspect_status";
    case "targets":
      return "inspect_targets";
    case "profiles":
      return "inspect_profiles";
    case "profile":
      return args.length === 0 ? "inspect_profiles" : "switch_profile";
    case "agents":
    case "models":
      return "inspect_runtime_options";
    case "agent":
      return args.length === 0 ? "inspect_runtime_options" : "set_agent";
    case "model":
      return args.length === 0 ? "inspect_runtime_options" : "set_model";
    case "new":
    case "reset":
      return "reset_session";
    case "stop":
      return "stop_run";
    case "sessions":
      return "list_sessions";
    case "use-session":
      return "use_session";
    case "bind":
    case "unbind":
      return "bind_target";
    case "permission":
      return "respond_permission";
    default:
      return "unknown_command";
  }
}

export function commandAuthorizationDeniedText(action: CommandPolicyAction): string {
  return DEFAULT_DENIED_MESSAGES[action];
}
