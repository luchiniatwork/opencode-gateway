import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigError, getConfigSeeds, loadConfig, parseGatewayConfig } from "./load.ts";

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
  expect(config.interactive.permissions).toEqual({
    mode: "buttons",
    fallbackCommands: true,
    allowAlways: false,
  });
  expect(config.channels.telegram?.token).toBe("secret-token");
});

test("can enable always-allow permission responses explicitly", () => {
  const config = parseGatewayConfig(
    minimalConfig(`
      "interactive": {
        "permissions": {
          "allowAlways": true,
        },
      },
    `),
    {
      env,
      homeDir: "/home/alice",
    },
  );

  expect(config.interactive.permissions).toEqual({
    mode: "buttons",
    fallbackCommands: true,
    allowAlways: true,
  });
});

test("loads file-backed config paths relative to the config file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-config-"));
  const configPath = join(dir, "config.jsonc");

  await writeFile(
    configPath,
    `{
      "gateway": { "databasePath": "./state.db" },
      "opencode": {
        "targets": [{
          "id": "default",
          "mode": "attach",
          "serverUrl": "http://127.0.0.1:4096",
          "workdir": "./workspace",
          "configDir": "./opencode-config"
        }]
      },
      "profiles": {
        "entries": [{
          "id": "cto",
          "displayName": "Tiago CTO",
          "defaultTarget": "default",
          "defaultConfigDir": "./profile-config"
        }]
      }
    }`,
    "utf8",
  );

  try {
    const config = await loadConfig(configPath, { env, homeDir: "/home/alice" });

    expect(config.gateway.databasePath).toBe(join(dir, "state.db"));
    expect(config.opencode.targets[0]?.workdir).toBe(join(dir, "workspace"));
    expect(config.opencode.targets[0]?.configDir).toBe(join(dir, "opencode-config"));
    expect(config.profiles.entries[0]?.defaultConfigDir).toBe(join(dir, "profile-config"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loads managed target defaults without serverUrl", () => {
  const config = parseGatewayConfig(
    `{
      "opencode": {
        "targets": [{
          "id": "managed",
          "name": "Managed workspace",
          "mode": "managed",
          "workdir": "/work/repo"
        }]
      },
      "profiles": {
        "entries": [{ "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "managed" }]
      }
    }`,
    { env, homeDir: "/home/alice" },
  );

  expect(config.opencode.targets[0]).toEqual({
    id: "managed",
    name: "Managed workspace",
    mode: "managed",
    serverUrl: undefined,
    workdir: "/work/repo",
    configDir: undefined,
    defaultAgent: undefined,
    defaultModel: undefined,
    managed: {
      command: "opencode",
      host: "127.0.0.1",
      port: 0,
      startupTimeoutMs: 15000,
      stopTimeoutMs: 5000,
      healthCheckIntervalMs: 10000,
      healthCheckTimeoutMs: 2000,
      restart: "on-failure",
    },
  });
});

test("loads managed target lifecycle overrides", () => {
  const config = parseGatewayConfig(
    `{
      "opencode": {
        "targets": [{
          "id": "managed",
          "mode": "managed",
          "workdir": "/work/repo",
          "managed": {
            "command": "/usr/local/bin/opencode",
            "host": "0.0.0.0",
            "port": 4097,
            "startupTimeoutMs": 30000,
            "stopTimeoutMs": 10000,
            "healthCheckIntervalMs": 15000,
            "healthCheckTimeoutMs": 3000,
            "restart": "never"
          }
        }]
      },
      "profiles": {
        "entries": [{ "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "managed" }]
      }
    }`,
    { env, homeDir: "/home/alice" },
  );

  expect(config.opencode.targets[0]?.managed).toEqual({
    command: "/usr/local/bin/opencode",
    host: "0.0.0.0",
    port: 4097,
    startupTimeoutMs: 30000,
    stopTimeoutMs: 10000,
    healthCheckIntervalMs: 15000,
    healthCheckTimeoutMs: 3000,
    restart: "never",
  });
});

test("loads managed target paths relative to the config file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opencode-gateway-managed-config-"));
  const configPath = join(dir, "config.jsonc");

  await writeFile(
    configPath,
    `{
      "opencode": {
        "targets": [{
          "id": "managed",
          "mode": "managed",
          "workdir": "./workspace",
          "configDir": "./opencode-config",
          "managed": {}
        }]
      },
      "profiles": {
        "entries": [{ "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "managed" }]
      }
    }`,
    "utf8",
  );

  try {
    const config = await loadConfig(configPath, { env, homeDir: "/home/alice" });

    expect(config.opencode.targets[0]?.workdir).toBe(join(dir, "workspace"));
    expect(config.opencode.targets[0]?.configDir).toBe(join(dir, "opencode-config"));
    expect(config.opencode.targets[0]?.managed?.command).toBe("opencode");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("requires managed targets to declare workdir", () => {
  expect(() =>
    parseGatewayConfig(
      `{
        "opencode": {
          "targets": [{ "id": "managed", "mode": "managed" }]
        },
        "profiles": {
          "entries": [{ "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "managed" }]
        }
      }`,
      { env, homeDir: "/home/alice" },
    ),
  ).toThrow("opencode.targets.managed.workdir is required for managed mode");
});

test("rejects managed lifecycle config on attach targets", () => {
  expect(() =>
    parseGatewayConfig(
      `{
        "opencode": {
          "targets": [{
            "id": "default",
            "mode": "attach",
            "serverUrl": "http://127.0.0.1:4096",
            "managed": {}
          }]
        },
        "profiles": {
          "entries": [{ "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "default" }]
        }
      }`,
      { env, homeDir: "/home/alice" },
    ),
  ).toThrow("opencode.targets.default.managed is only valid for managed mode");
});

test("rejects invalid managed target port", () => {
  expect(() =>
    parseGatewayConfig(
      `{
        "opencode": {
          "targets": [{
            "id": "managed",
            "mode": "managed",
            "workdir": "/work/repo",
            "managed": { "port": 70000 }
          }]
        },
        "profiles": {
          "entries": [{ "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "managed" }]
        }
      }`,
      { env, homeDir: "/home/alice" },
    ),
  ).toThrow("opencode.targets.0.managed.port");
});

test("rejects invalid managed target timeout", () => {
  expect(() =>
    parseGatewayConfig(
      `{
        "opencode": {
          "targets": [{
            "id": "managed",
            "mode": "managed",
            "workdir": "/work/repo",
            "managed": { "startupTimeoutMs": -1 }
          }]
        },
        "profiles": {
          "entries": [{ "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "managed" }]
        }
      }`,
      { env, homeDir: "/home/alice" },
    ),
  ).toThrow("opencode.targets.0.managed.startupTimeoutMs");
});

test("rejects unknown managed lifecycle keys", () => {
  expect(() =>
    parseGatewayConfig(
      `{
        "opencode": {
          "targets": [{
            "id": "managed",
            "mode": "managed",
            "workdir": "/work/repo",
            "managed": { "startupTimeout": 15000 }
          }]
        },
        "profiles": {
          "entries": [{ "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "managed" }]
        }
      }`,
      { env, homeDir: "/home/alice" },
    ),
  ).toThrow("startupTimeout");
});

test("does not leak managed command env values in validation errors", () => {
  try {
    parseGatewayConfig(
      `{
        "opencode": {
          "targets": [{
            "id": "managed",
            "mode": "managed",
            "workdir": "/work/repo",
            "managed": {
              "command": "{env:OPENCODE_BIN}",
              "port": 70000
            }
          }]
        },
        "profiles": {
          "entries": [{ "id": "cto", "displayName": "Tiago CTO", "defaultTarget": "managed" }]
        }
      }`,
      {
        env: { ...env, OPENCODE_BIN: "secret-opencode-bin" },
        homeDir: "/home/alice",
      },
    );

    throw new Error("expected config validation to fail");
  } catch (error) {
    expect(String(error)).toContain("opencode.targets.0.managed.port");
    expect(String(error)).not.toContain("secret-opencode-bin");
  }
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
