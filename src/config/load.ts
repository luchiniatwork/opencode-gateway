import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ZodError } from "zod";

import {
  rawGatewayConfigSchema,
  type AccessRuleSeed,
  type ConfigSeeds,
  type GatewayConfig,
  type GatewayProfileConfig,
  type GatewayTargetConfig,
  type RawGatewayConfig,
  type TelegramChannelConfig,
} from "./schema.ts";

export interface ConfigLoadOptions {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  baseDir?: string;
}

export class ConfigError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(formatConfigError(message, issues));
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export async function loadConfig(
  filePath: string,
  options: ConfigLoadOptions = {},
): Promise<GatewayConfig> {
  const resolvedPath = resolve(expandPath(filePath, getHomeDir(options), undefined));

  let content: string;

  try {
    content = await Bun.file(resolvedPath).text();
  } catch (error) {
    throw new ConfigError(`Unable to read config file: ${resolvedPath}`, [
      error instanceof Error ? error.message : String(error),
    ]);
  }

  return parseGatewayConfig(content, { ...options, baseDir: dirname(resolvedPath) });
}

export function parseGatewayConfig(
  content: string,
  options: ConfigLoadOptions = {},
): GatewayConfig {
  const parseErrors: ParseError[] = [];
  const parsed = parse(content, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  if (parseErrors.length > 0) {
    throw new ConfigError(
      "Invalid config JSONC",
      parseErrors.map((error) => formatParseError(content, error)),
    );
  }

  const expansion = expandEnvRefs(parsed, {
    env: options.env ?? process.env,
    path: [],
  });

  if (expansion.issues.length > 0) {
    throw new ConfigError("Invalid config environment references", expansion.issues);
  }

  let rawConfig: RawGatewayConfig;

  try {
    rawConfig = rawGatewayConfigSchema.parse(expansion.value);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new ConfigError("Invalid config", formatZodIssues(error));
    }

    throw error;
  }

  const issues = validateRawConfig(rawConfig);

  if (issues.length > 0) {
    throw new ConfigError("Invalid config", issues);
  }

  return normalizeConfig(rawConfig, getHomeDir(options), options.baseDir);
}

export function getConfigSeeds(config: GatewayConfig): ConfigSeeds {
  return {
    targets: config.opencode.targets,
    profiles: config.profiles.entries,
    accessRules: getAccessRuleSeeds(config),
  };
}

function getAccessRuleSeeds(config: GatewayConfig): AccessRuleSeed[] {
  const telegram = config.channels.telegram;

  if (!telegram) return [];

  return telegram.allowFrom.map((senderId) => ({
    channel: "telegram",
    accountId: "default",
    senderId,
    role: "owner",
  }));
}

function normalizeConfig(rawConfig: RawGatewayConfig, homeDir: string, baseDir: string | undefined): GatewayConfig {
  const targets = rawConfig.opencode.targets.map(
    (target): GatewayTargetConfig => ({
      id: target.id,
      name: target.name ?? target.id,
      mode: target.mode,
      serverUrl: target.serverUrl,
      workdir: expandOptionalPath(target.workdir, homeDir, baseDir),
      configDir: expandOptionalPath(target.configDir, homeDir, baseDir),
      defaultAgent: target.defaultAgent,
      defaultModel: target.defaultModel,
    }),
  );

  const explicitDefaultProfile = rawConfig.profiles.default ?? rawConfig.defaults.profile;
  const defaultProfile = explicitDefaultProfile ?? rawConfig.profiles.entries[0]?.id;

  if (!defaultProfile) {
    throw new ConfigError("Invalid config", ["profiles.entries must contain at least one profile"]);
  }

  const defaultProfileEntry = rawConfig.profiles.entries.find(
    (profile) => profile.id === defaultProfile,
  );

  if (!defaultProfileEntry) {
    throw new ConfigError("Invalid config", [
      `profiles.default must reference an existing profile: ${defaultProfile}`,
    ]);
  }

  const defaultTarget = rawConfig.defaults.target ?? defaultProfileEntry.defaultTarget;
  const profiles = rawConfig.profiles.entries.map(
    (profile): GatewayProfileConfig => ({
      id: profile.id,
      displayName: profile.displayName,
      description: profile.description,
      avatar: profile.avatar,
      defaultTargetId: profile.defaultTarget,
      defaultAgent: profile.defaultAgent,
      defaultModel: profile.defaultModel,
      defaultConfigDir: expandOptionalPath(profile.defaultConfigDir, homeDir, baseDir),
      accessPolicyId: profile.accessPolicyId,
      commandPolicyId: profile.commandPolicyId,
      defaults: {
        verbosity: profile.defaults?.verbosity,
        busyMode: profile.defaults?.busyMode,
      },
    }),
  );

  const telegram = normalizeTelegramConfig(rawConfig.channels.telegram);

  return {
    gateway: {
      host: rawConfig.gateway.host,
      port: rawConfig.gateway.port,
      databasePath: expandPath(rawConfig.gateway.databasePath, homeDir, baseDir),
      logLevel: rawConfig.gateway.logLevel,
    },
    opencode: { targets },
    profiles: {
      default: defaultProfile,
      entries: profiles,
    },
    channels: telegram ? { telegram } : {},
    defaults: {
      profile: defaultProfile,
      target: defaultTarget,
      busyMode: rawConfig.defaults.busyMode,
      verbosity: rawConfig.defaults.verbosity,
      inboundDebounceMs: rawConfig.defaults.inboundDebounceMs,
    },
  };
}

function normalizeTelegramConfig(
  telegram: RawGatewayConfig["channels"]["telegram"],
): TelegramChannelConfig | undefined {
  if (!telegram) return undefined;

  return {
    enabled: telegram.enabled,
    token: telegram.token,
    allowFrom: telegram.allowFrom,
    groups: telegram.groups,
  };
}

function validateRawConfig(config: RawGatewayConfig): string[] {
  const issues: string[] = [];
  const targetIds = new Set<string>();
  const targetNames = new Set<string>();
  const profileIds = new Set<string>();

  for (const target of config.opencode.targets) {
    if (targetIds.has(target.id)) {
      issues.push(`opencode.targets contains duplicate id: ${target.id}`);
    }

    targetIds.add(target.id);

    const targetName = target.name ?? target.id;

    if (targetNames.has(targetName)) {
      issues.push(`opencode.targets contains duplicate name: ${targetName}`);
    }

    targetNames.add(targetName);

    if (target.mode === "attach" && !target.serverUrl) {
      issues.push(`opencode.targets.${target.id}.serverUrl is required for attach mode`);
    }

    if (target.mode === "managed" && !target.workdir) {
      issues.push(`opencode.targets.${target.id}.workdir is required for managed mode`);
    }
  }

  for (const profile of config.profiles.entries) {
    if (profileIds.has(profile.id)) {
      issues.push(`profiles.entries contains duplicate id: ${profile.id}`);
    }

    profileIds.add(profile.id);

    if (!targetIds.has(profile.defaultTarget)) {
      issues.push(
        `profiles.entries.${profile.id}.defaultTarget references unknown target: ${profile.defaultTarget}`,
      );
    }
  }

  const defaultProfile = config.profiles.default ?? config.defaults.profile;

  if (defaultProfile && !profileIds.has(defaultProfile)) {
    issues.push(`profiles.default references unknown profile: ${defaultProfile}`);
  }

  if (!defaultProfile && config.profiles.entries.length > 1) {
    issues.push("profiles.default or defaults.profile is required when multiple profiles are configured");
  }

  if (config.defaults.target && !targetIds.has(config.defaults.target)) {
    issues.push(`defaults.target references unknown target: ${config.defaults.target}`);
  }

  if (config.defaults.profile && !profileIds.has(config.defaults.profile)) {
    issues.push(`defaults.profile references unknown profile: ${config.defaults.profile}`);
  }

  if (config.channels.telegram?.enabled && !config.channels.telegram.token) {
    issues.push("channels.telegram.token is required when Telegram is enabled");
  }

  return issues;
}

function expandEnvRefs(
  value: unknown,
  options: { env: Record<string, string | undefined>; path: string[] },
): { value: unknown; issues: string[] } {
  if (typeof value === "string") {
    return expandStringEnvRef(value, options);
  }

  if (Array.isArray(value)) {
    const issues: string[] = [];
    const expanded = value.map((entry, index) => {
      const result = expandEnvRefs(entry, {
        ...options,
        path: [...options.path, String(index)],
      });

      issues.push(...result.issues);
      return result.value;
    });

    return { value: expanded, issues };
  }

  if (value && typeof value === "object") {
    const issues: string[] = [];
    const expanded: Record<string, unknown> = {};

    for (const [key, entry] of Object.entries(value)) {
      const result = expandEnvRefs(entry, {
        ...options,
        path: [...options.path, key],
      });

      issues.push(...result.issues);
      expanded[key] = result.value;
    }

    return { value: expanded, issues };
  }

  return { value, issues: [] };
}

function expandStringEnvRef(
  value: string,
  options: { env: Record<string, string | undefined>; path: string[] },
): { value: unknown; issues: string[] } {
  const match = /^\{env:([A-Za-z_][A-Za-z0-9_]*)(\?)?\}$/.exec(value);

  if (!match) return { value, issues: [] };

  const name = match[1];
  const optional = Boolean(match[2]);

  if (!name) return { value, issues: [] };

  const envValue = options.env[name];

  if (envValue !== undefined) {
    return { value: envValue, issues: [] };
  }

  if (optional) {
    return { value: undefined, issues: [] };
  }

  const path = options.path.length > 0 ? options.path.join(".") : "<root>";

  return {
    value: undefined,
    issues: [`${path} references missing environment variable: ${name}`],
  };
}

function expandOptionalPath(value: string | undefined, homeDir: string, baseDir: string | undefined): string | undefined {
  if (!value) return undefined;
  return expandPath(value, homeDir, baseDir);
}

function expandPath(value: string, homeDir: string, baseDir: string | undefined): string {
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return `${homeDir}${value.slice(1)}`;
  if (baseDir && !isAbsolute(value) && value !== ":memory:") return join(baseDir, value);
  return value;
}

function getHomeDir(options: ConfigLoadOptions): string {
  return options.homeDir ?? homedir();
}

function formatParseError(content: string, error: ParseError): string {
  const position = getLineColumn(content, error.offset);
  return `${position.line}:${position.column} ${printParseErrorCode(error.error)}`;
}

function getLineColumn(content: string, offset: number): { line: number; column: number } {
  const prefix = content.slice(0, offset);
  const lines = prefix.split("\n");
  const lastLine = lines[lines.length - 1] ?? "";

  return {
    line: lines.length,
    column: lastLine.length + 1,
  };
}

function formatZodIssues(error: ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
    return `${path}: ${issue.message}`;
  });
}

function formatConfigError(message: string, issues: string[]): string {
  if (issues.length === 0) return message;

  return `${message}:\n${issues.map((issue) => `- ${issue}`).join("\n")}`;
}
