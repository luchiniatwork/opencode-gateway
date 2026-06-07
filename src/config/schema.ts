import { z } from "zod";

export const accessRoleSchema = z.enum(["owner", "admin", "user", "blocked"]);
export const busyModeSchema = z.enum(["queue", "interrupt", "reject", "steer"]);
export const logLevelSchema = z.enum(["debug", "info", "warn", "error"]);
export const targetModeSchema = z.enum(["attach", "managed"]);
export const verbositySchema = z.enum(["off", "compact", "tools", "verbose"]);

const targetSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    mode: targetModeSchema.default("attach"),
    serverUrl: z.string().url().optional(),
    workdir: z.string().min(1).optional(),
    configDir: z.string().min(1).optional(),
    defaultAgent: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
  })
  .strict();

const profileDefaultsSchema = z
  .object({
    verbosity: verbositySchema.optional(),
    busyMode: busyModeSchema.optional(),
  })
  .strict();

const profileSchema = z
  .object({
    id: z.string().min(1),
    displayName: z.string().min(1),
    description: z.string().min(1).optional(),
    avatar: z.string().min(1).optional(),
    defaultTarget: z.string().min(1),
    defaultAgent: z.string().min(1).optional(),
    defaultModel: z.string().min(1).optional(),
    defaultConfigDir: z.string().min(1).optional(),
    accessPolicyId: z.string().min(1).optional(),
    commandPolicyId: z.string().min(1).optional(),
    defaults: profileDefaultsSchema.optional(),
  })
  .strict();

const telegramGroupSchema = z
  .object({
    requireMention: z.boolean().default(true),
  })
  .strict();

export const rawGatewayConfigSchema = z
  .object({
    gateway: z
      .object({
        host: z.string().min(1).default("127.0.0.1"),
        port: z.number().int().min(1).max(65_535).default(8765),
        databasePath: z.string().min(1).default("~/.opencode-gateway/state.db"),
        logLevel: logLevelSchema.default("info"),
      })
      .strict()
      .default({
        host: "127.0.0.1",
        port: 8765,
        databasePath: "~/.opencode-gateway/state.db",
        logLevel: "info",
      }),
    opencode: z
      .object({
        targets: z.array(targetSchema).min(1),
      })
      .strict(),
    profiles: z
      .object({
        default: z.string().min(1).optional(),
        entries: z.array(profileSchema).min(1),
      })
      .strict(),
    channels: z
      .object({
        telegram: z
          .object({
            enabled: z.boolean().default(false),
            token: z.string().min(1).optional(),
            allowFrom: z.array(z.string().min(1)).default([]),
            groups: z.record(z.string(), telegramGroupSchema).default({}),
          })
          .strict()
          .optional(),
      })
      .strict()
      .default({}),
    defaults: z
      .object({
        profile: z.string().min(1).optional(),
        target: z.string().min(1).optional(),
        busyMode: busyModeSchema.default("queue"),
        verbosity: verbositySchema.default("compact"),
        inboundDebounceMs: z.number().int().min(0).default(1_500),
      })
      .strict()
      .default({
        busyMode: "queue",
        verbosity: "compact",
        inboundDebounceMs: 1_500,
      }),
  })
  .strict();

export type AccessRole = z.infer<typeof accessRoleSchema>;
export type BusyMode = z.infer<typeof busyModeSchema>;
export type LogLevel = z.infer<typeof logLevelSchema>;
export type TargetMode = z.infer<typeof targetModeSchema>;
export type Verbosity = z.infer<typeof verbositySchema>;
export type RawGatewayConfig = z.infer<typeof rawGatewayConfigSchema>;

export interface GatewayTargetConfig {
  id: string;
  name: string;
  mode: TargetMode;
  serverUrl?: string;
  workdir?: string;
  configDir?: string;
  defaultAgent?: string;
  defaultModel?: string;
}

export interface GatewayProfileConfig {
  id: string;
  displayName: string;
  description?: string;
  avatar?: string;
  defaultTargetId: string;
  defaultAgent?: string;
  defaultModel?: string;
  defaultConfigDir?: string;
  accessPolicyId?: string;
  commandPolicyId?: string;
  defaults: {
    verbosity?: Verbosity;
    busyMode?: BusyMode;
  };
}

export interface TelegramChannelConfig {
  enabled: boolean;
  token?: string;
  allowFrom: string[];
  groups: Record<string, { requireMention: boolean }>;
}

export interface GatewayConfig {
  gateway: {
    host: string;
    port: number;
    databasePath: string;
    logLevel: LogLevel;
  };
  opencode: {
    targets: GatewayTargetConfig[];
  };
  profiles: {
    default: string;
    entries: GatewayProfileConfig[];
  };
  channels: {
    telegram?: TelegramChannelConfig;
  };
  defaults: {
    profile: string;
    target: string;
    busyMode: BusyMode;
    verbosity: Verbosity;
    inboundDebounceMs: number;
  };
}

export interface AccessRuleSeed {
  channel: "telegram";
  accountId: "default";
  senderId: string;
  role: AccessRole;
}

export interface ConfigSeeds {
  targets: GatewayTargetConfig[];
  profiles: GatewayProfileConfig[];
  accessRules: AccessRuleSeed[];
}
