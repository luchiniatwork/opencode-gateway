import { expect, test } from "bun:test";

import type { AccessRole } from "../config/schema.ts";
import {
  authorizeCommandAction,
  commandAuthorizationDeniedText,
  gatewayCommandAction,
  type CommandPolicyAction,
} from "./commands.ts";

test("default command policy allows normal users to inspect but not mutate", () => {
  for (const action of [
    "normal_chat",
    "inspect_status",
    "inspect_targets",
    "inspect_profiles",
    "inspect_runtime_options",
    "reset_session",
    "stop_run",
    "list_sessions",
  ] satisfies CommandPolicyAction[]) {
    expect(authorizeCommandAction({ role: "user", action }).allowed).toBe(true);
  }

  for (const action of [
    "use_session",
    "switch_profile",
    "bind_target",
    "set_agent",
    "set_model",
    "respond_permission",
  ] satisfies CommandPolicyAction[]) {
    const decision = authorizeCommandAction({ role: "user", action });

    expect(decision).toMatchObject({ allowed: false, reason: "insufficient_role" });
  }
});

test("default command policy allows owners and admins to mutate", () => {
  for (const role of ["owner", "admin"] satisfies AccessRole[]) {
    for (const action of [
      "use_session",
      "switch_profile",
      "bind_target",
      "set_agent",
      "set_model",
      "respond_permission",
    ] satisfies CommandPolicyAction[]) {
      expect(authorizeCommandAction({ role, action }).allowed).toBe(true);
    }
  }
});

test("default command policy denies unknown and blocked senders", () => {
  expect(authorizeCommandAction({ action: "inspect_status" })).toMatchObject({
    allowed: false,
    reason: "unknown_sender",
  });
  expect(authorizeCommandAction({ role: "blocked", action: "inspect_status" })).toMatchObject({
    allowed: false,
    reason: "blocked",
  });
});

test("gateway command classifier distinguishes view and mutation commands", () => {
  expect(gatewayCommandAction("agent", [])).toBe("inspect_runtime_options");
  expect(gatewayCommandAction("agent", ["build"])).toBe("set_agent");
  expect(gatewayCommandAction("model", [])).toBe("inspect_runtime_options");
  expect(gatewayCommandAction("model", ["openai/gpt-5.5"])).toBe("set_model");
  expect(gatewayCommandAction("profile", [])).toBe("inspect_profiles");
  expect(gatewayCommandAction("profile", ["cto"])).toBe("switch_profile");
  expect(gatewayCommandAction("targets", [])).toBe("inspect_targets");
  expect(gatewayCommandAction("nope", [])).toBe("unknown_command");
});

test("denied text is specific for restricted commands", () => {
  expect(commandAuthorizationDeniedText("use_session")).toBe("Session rebinding requires owner/admin access.");
  expect(commandAuthorizationDeniedText("switch_profile")).toBe("Profile switching requires owner/admin access.");
  expect(commandAuthorizationDeniedText("bind_target")).toBe("Target binding changes require owner/admin access.");
  expect(commandAuthorizationDeniedText("set_agent")).toBe("Agent changes require owner/admin access.");
  expect(commandAuthorizationDeniedText("set_model")).toBe("Model changes require owner/admin access.");
  expect(commandAuthorizationDeniedText("respond_permission")).toBe("Permission responses require owner/admin access.");
});
