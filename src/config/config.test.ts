import { expect, test } from "bun:test";

import { ConfigError, getConfigSeeds, parseGatewayConfig } from "./load.ts";

const env = { TELEGRAM_BOT_TOKEN: "secret-token" };

function minimalConfig(overrides = ""): string {
  return `{
    // JSONC comments and trailing commas are supported.
    "gateway": {
      "databasePath": "~/.opencode-gateway/state.db",
    },
    "opencode": {
      "targets": [
        {
          "id": "default",
          "mode": "attach",
          "serverUrl": "http://127.0.0.1:4096",
        },
      ],
    },
    "profiles": {
      "entries": [
        {
          "id": "cto",
          "displayName": "Tiago CTO",
          "defaultTarget": "default",
        },
      ],
    },
    "channels": {
      "telegram": {
        "enabled": true,
        "token": "{env:TELEGRAM_BOT_TOKEN}",
        "allowFrom": ["123456789"],
      },
    },
    ${overrides}
  }`;
}

test("loads JSONC config with defaults, env expansion, and home expansion", () => {
  const config = parseGatewayConfig(minimalConfig(), {
    env,
    homeDir: "/home/alice",
  });

  expect(config.gateway).toEqual({
    host: "127.0.0.1",
    port: 8765,
    databasePath: "/home/alice/.opencode-gateway/state.db",
    logLevel: "info",
  });
  expect(config.opencode.targets).toEqual([
    {
      id: "default",
      name: "default",
      mode: "attach",
      serverUrl: "http://127.0.0.1:4096",
      workdir: undefined,
      configDir: undefined,
      defaultAgent: undefined,
      defaultModel: undefined,
    },
  ]);
  expect(config.profiles.default).toBe("cto");
  expect(config.defaults).toEqual({
    profile: "cto",
    target: "default",
    busyMode: "queue",
    verbosity: "compact",
    inboundDebounceMs: 1500,
  });
  expect(config.channels.telegram?.token).toBe("secret-token");
});

test("derives access rule seeds from Telegram allowlist", () => {
  const config = parseGatewayConfig(minimalConfig(), {
    env,
    homeDir: "/home/alice",
  });

  expect(getConfigSeeds(config).accessRules).toEqual([
    {
      channel: "telegram",
      accountId: "default",
      senderId: "123456789",
      role: "owner",
    },
  ]);
});

test("fails when required env reference is missing", () => {
  expect(() =>
    parseGatewayConfig(minimalConfig(), {
      env: {},
      homeDir: "/home/alice",
    }),
  ).toThrow(ConfigError);

  try {
    parseGatewayConfig(minimalConfig(), { env: {}, homeDir: "/home/alice" });
  } catch (error) {
    expect(String(error)).toContain("TELEGRAM_BOT_TOKEN");
    expect(String(error)).not.toContain("secret-token");
  }
});

test("allows optional env references to be missing", () => {
  const config = parseGatewayConfig(
    `{
      "opencode": {
        "targets": [{ "id": "default", "mode": "attach", "serverUrl": "http://127.0.0.1:4096" }],
      },
      "profiles": {
        "entries": [{ "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "default" }],
      },
      "channels": {
        "telegram": {
          "enabled": false,
          "token": "{env:OPTIONAL_TOKEN?}",
        },
      },
    }`,
    { env: {}, homeDir: "/home/alice" },
  );

  expect(config.channels.telegram?.token).toBeUndefined();
});

test("rejects unknown profile target references", () => {
  expect(() =>
    parseGatewayConfig(
      `{
        "opencode": {
          "targets": [{ "id": "default", "mode": "attach", "serverUrl": "http://127.0.0.1:4096" }],
        },
        "profiles": {
          "entries": [{ "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "missing" }],
        },
      }`,
      { env, homeDir: "/home/alice" },
    ),
  ).toThrow("profiles.entries.cto.defaultTarget references unknown target: missing");
});

test("requires default profile when multiple profiles are configured", () => {
  expect(() =>
    parseGatewayConfig(
      `{
        "opencode": {
          "targets": [{ "id": "default", "mode": "attach", "serverUrl": "http://127.0.0.1:4096" }],
        },
        "profiles": {
          "entries": [
            { "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "default" },
            { "id": "ops", "displayName": "Ops", "defaultTarget": "default" },
          ],
        },
      }`,
      { env, homeDir: "/home/alice" },
    ),
  ).toThrow("profiles.default or defaults.profile is required");
});

test("requires Telegram token when Telegram is enabled", () => {
  expect(() =>
    parseGatewayConfig(
      `{
        "opencode": {
          "targets": [{ "id": "default", "mode": "attach", "serverUrl": "http://127.0.0.1:4096" }],
        },
        "profiles": {
          "entries": [{ "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "default" }],
        },
        "channels": {
          "telegram": { "enabled": true },
        },
      }`,
      { env, homeDir: "/home/alice" },
    ),
  ).toThrow("channels.telegram.token is required when Telegram is enabled");
});

test("does not leak secret values in validation errors", () => {
  try {
    parseGatewayConfig(
      `{
        "opencode": {
          "targets": [{ "id": "default", "mode": "attach", "serverUrl": "http://127.0.0.1:4096" }],
        },
        "profiles": {
          "entries": [{ "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "missing" }],
        },
        "channels": {
          "telegram": {
            "enabled": true,
            "token": "{env:TELEGRAM_BOT_TOKEN}",
          },
        },
      }`,
      { env, homeDir: "/home/alice" },
    );
  } catch (error) {
    expect(String(error)).not.toContain("secret-token");
  }
});

test("reports JSONC parse errors with location", () => {
  expect(() => parseGatewayConfig("{", { env, homeDir: "/home/alice" })).toThrow(
    "Invalid config JSONC",
  );
});
