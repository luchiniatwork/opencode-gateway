import { getConfigSeeds } from "./config/load.ts";
import type { ChannelAdapter, ChannelEvent, ChannelLogger, InboundMessage, OutboundTarget } from "./channels/types.ts";
import { createTelegramAdapter } from "./channels/telegram/index.ts";
import { createCommandRouter } from "./commands/registry.ts";
import type { GatewayConfig, TelegramChannelConfig } from "./config/schema.ts";
import { openGatewayDatabase, type GatewayDatabase } from "./db/client.ts";
import { runMigrations } from "./db/migrations.ts";
import { createAccessRuleRepository } from "./db/repositories/access-rules.ts";
import { createConversationBindingRepository } from "./db/repositories/conversation-bindings.ts";
import { createProfileRepository } from "./db/repositories/profiles.ts";
import { createRunRepository } from "./db/repositories/runs.ts";
import { seedDatabaseFromConfig } from "./db/repositories/seeds.ts";
import { createTargetRepository } from "./db/repositories/targets.ts";
import { createDispatchResolver, type DispatchMessageResult } from "./dispatch/resolver.ts";
import type { OutboundMessage } from "./messages/types.ts";
import { createHealthSnapshot, type ChannelHealthStatus, type GatewayHealthSnapshot } from "./observability/health.ts";
import {
  createJsonLogSink,
  type GatewayLogContext,
  type GatewayLogEntry,
  type GatewayLogLevel,
} from "./observability/logging.ts";
import { OpenCodeRuntime } from "./opencode/client.ts";
import type { AgentRuntime } from "./opencode/types.ts";

export type { GatewayLogEntry, GatewayLogLevel } from "./observability/logging.ts";

export interface GatewayAppStatus {
  started: boolean;
  configLoaded: boolean;
  databaseConnected: boolean;
}

export interface GatewayApp {
  readonly status: GatewayAppStatus;
  readonly healthUrl?: string;
  health(): GatewayHealthSnapshot;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface GatewayChannelRegistration<TConfig = unknown> {
  adapter: ChannelAdapter<TConfig>;
  accountId: string;
  config: TConfig;
}

export interface GatewayAppOptions {
  config?: GatewayConfig;
  logger?: (entry: GatewayLogEntry) => void;
  now?: () => Date;
  runtime?: AgentRuntime;
  channels?: GatewayChannelRegistration<any>[];
  createTelegramAdapter?: () => ChannelAdapter<TelegramChannelConfig>;
}

export function createApp(options: GatewayAppOptions = {}): GatewayApp {
  const logger = options.logger ?? createJsonLogSink({ level: options.config?.gateway.logLevel });
  const now = options.now ?? (() => new Date());
  let started = false;
  let database: GatewayDatabase | undefined;
  let abortController: AbortController | undefined;
  let healthServer: ReturnType<typeof Bun.serve> | undefined;
  const startedChannels: GatewayChannelRegistration<any>[] = [];
  const channelStatuses = new Map<string, ChannelHealthStatus>();

  function log(
    level: GatewayLogLevel,
    message: string,
    context: GatewayLogContext = {},
  ): void {
    logger({
      timestamp: now().toISOString(),
      level,
      component: "app",
      message,
      ...context,
    });
  }

  return {
    get status(): GatewayAppStatus {
      return {
        started,
        configLoaded: Boolean(options.config),
        databaseConnected: Boolean(database),
      };
    },

    get healthUrl(): string | undefined {
      return healthServer ? new URL("/health", healthServer.url).toString() : undefined;
    },

    health(): GatewayHealthSnapshot {
      return healthSnapshot();
    },

    async start(): Promise<void> {
      if (started) return;

      let openedDatabase: GatewayDatabase | undefined;

      if (options.config) {
        validatePhase1RuntimeTargets(options.config);

        openedDatabase = await openGatewayDatabase(options.config.gateway.databasePath);

        try {
          runMigrations(openedDatabase.db, now);
          seedDatabaseFromConfig(openedDatabase.db, getConfigSeeds(options.config), now);
          database = openedDatabase;
          abortController = new AbortController();

          const repositories = {
            accessRules: createAccessRuleRepository(openedDatabase.db, { now }),
            bindings: createConversationBindingRepository(openedDatabase.db, { now }),
            profiles: createProfileRepository(openedDatabase.db, now),
            targets: createTargetRepository(openedDatabase.db, now),
            runs: createRunRepository(openedDatabase.db, { now }),
          };
          const runtime = options.runtime ?? new OpenCodeRuntime();
          const resolver = createDispatchResolver({ config: options.config, repositories, runtime });
          const commandRouter = createCommandRouter({
            config: options.config,
            repositories,
            resolver,
            runtime,
            getHealth: () => {
              const snapshot = healthSnapshot();

              return {
                gateway: snapshot.gateway,
                targets: snapshot.opencodeTargets,
              };
            },
          });
          const channels = options.channels ?? configuredChannels(options.config, options.createTelegramAdapter);

          for (const channel of channels) {
            startedChannels.push(channel);
            channelStatuses.set(channelStatusKey(channel), "configured");

            try {
              await channel.adapter.start({
                accountId: channel.accountId,
                config: channel.config,
                signal: abortController.signal,
                logger: channelLogger(channel.adapter.id, channel.accountId),
                emit: async (event) => {
                  await handleChannelEvent(channel, event, async (message) => {
                    log("info", "inbound message received", messageLogContext(message));

                    const commandResult = await commandRouter.handle(message);

                    if (commandResult.handled) {
                      log("info", "gateway command handled", {
                        ...messageLogContext(message),
                        command: commandResult.command,
                      });

                      return commandResult.messages;
                    }

                    const dispatchResult = await resolver.dispatchMessage(message);
                    logDispatchResult(dispatchResult, message);

                    return dispatchMessages(dispatchResult);
                  });
                },
              });
              channelStatuses.set(channelStatusKey(channel), "running");
              log("info", "channel started", {
                source: "channel",
                channel: channel.adapter.id,
                accountId: channel.accountId,
              });
            } catch (error) {
              channelStatuses.set(channelStatusKey(channel), "error");
              log("error", "channel start failed", {
                source: "channel",
                channel: channel.adapter.id,
                accountId: channel.accountId,
                error: formatError(error),
              });
              throw error;
            }
          }

          startHealthServer(options.config);
        } catch (error) {
          await stopStartedChannels();
          stopHealthServer();
          abortController = undefined;
          database = undefined;
          openedDatabase.close();
          throw error;
        }
      }

      started = true;
      log("info", "opencode-gateway starting");
    },

    async stop(): Promise<void> {
      if (!started) return;

      started = false;
      abortController?.abort();
      abortController = undefined;
      await stopStartedChannels();
      stopHealthServer();
      database?.close();
      database = undefined;
      log("info", "opencode-gateway stopped");
    },
  };

  async function handleChannelEvent(
    channel: GatewayChannelRegistration<any>,
    event: ChannelEvent,
    routeMessage: (message: InboundMessage) => Promise<OutboundMessage[]>,
  ): Promise<void> {
    if (event.type !== "message") {
      log("debug", "channel action ignored in phase 1", {
        channel: event.action.channel,
        accountId: event.action.accountId,
        conversationKey: event.action.conversation.key,
      });
      return;
    }

    const { message } = event;
    const target = outboundTargetFromMessage(message);

    try {
      const responses = await routeMessage(message);

      for (const response of responses) {
        await channel.adapter.send(target, response);
      }
    } catch (error) {
      log("error", "channel message handling failed", {
        channel: message.channel,
        accountId: message.accountId,
        conversationKey: message.conversation.key,
        error: formatError(error),
      });

      await channel.adapter.send(target, {
        kind: "error",
        format: "plain",
        text: `Gateway error: ${formatError(error)}`,
      });
    }
  }

  async function stopStartedChannels(): Promise<void> {
    const channels = startedChannels.splice(0, startedChannels.length).reverse();

    for (const channel of channels) {
      try {
        await channel.adapter.stop();
        channelStatuses.set(channelStatusKey(channel), "stopped");
        log("info", "channel stopped", {
          source: "channel",
          channel: channel.adapter.id,
          accountId: channel.accountId,
        });
      } catch (error) {
        channelStatuses.set(channelStatusKey(channel), "error");
        log("error", "channel stop failed", {
          source: "channel",
          channel: channel.adapter.id,
          accountId: channel.accountId,
          error: formatError(error),
        });
      }
    }
  }

  function channelLogger(channel: string, accountId: string): ChannelLogger {
    return {
      debug: (message, context) => log("debug", message, { channel, accountId, ...context }),
      info: (message, context) => log("info", message, { channel, accountId, ...context }),
      warn: (message, context) => log("warn", message, { channel, accountId, ...context }),
      error: (message, context) => log("error", message, { channel, accountId, ...context }),
    };
  }

  function startHealthServer(config: GatewayConfig): void {
    healthServer = Bun.serve({
      hostname: config.gateway.host,
      port: config.gateway.port,
      fetch(request) {
        const url = new URL(request.url);

        if (request.method !== "GET" || url.pathname !== "/health") {
          return new Response("Not Found", { status: 404 });
        }

        return Response.json(healthSnapshot());
      },
    });

    log("info", "health endpoint started", {
      component: "health",
      host: config.gateway.host,
      port: healthServer.port,
    });
  }

  function stopHealthServer(): void {
    if (!healthServer) return;

    healthServer.stop(true);
    healthServer = undefined;
  }

  function healthSnapshot(): GatewayHealthSnapshot {
    return createHealthSnapshot({
      config: options.config,
      started,
      channelStatuses: Object.fromEntries(channelStatuses),
    });
  }

  function logDispatchResult(result: DispatchMessageResult, message: InboundMessage): void {
    if (result.status === "denied") {
      log("warn", "dispatch denied", {
        ...messageLogContext(message),
        reason: result.decision.reason,
      });
      return;
    }

    const context = {
      ...messageLogContext(message),
      profileId: result.resolution.profile.id,
      targetId: result.resolution.target.id,
      sessionId: result.resolution.binding.opencodeSessionId,
      runId: result.run.id,
    };

    if (result.status === "error") {
      log("error", "dispatch failed", { ...context, error: result.error });
      return;
    }

    log(result.status === "busy" ? "warn" : "info", `dispatch ${result.status}`, context);
  }
}

function channelStatusKey(channel: GatewayChannelRegistration<any>): string {
  return `${channel.adapter.id}:${channel.accountId}`;
}

function messageLogContext(message: InboundMessage): GatewayLogContext {
  return {
    source: "channel",
    channel: message.channel,
    accountId: message.accountId,
    conversationKey: message.conversation.key,
  };
}

function configuredChannels(
  config: GatewayConfig,
  createTelegram: (() => ChannelAdapter<TelegramChannelConfig>) | undefined,
): GatewayChannelRegistration<any>[] {
  const channels: GatewayChannelRegistration<any>[] = [];

  if (config.channels.telegram?.enabled) {
    channels.push({
      adapter: createTelegram ? createTelegram() : createTelegramAdapter(),
      accountId: "default",
      config: config.channels.telegram,
    });
  }

  return channels;
}

function validatePhase1RuntimeTargets(config: GatewayConfig): void {
  const targetsById = new Map(config.opencode.targets.map((target) => [target.id, target]));
  const profileTargetIds = new Set(config.profiles.entries.map((profile) => profile.defaultTargetId));
  profileTargetIds.add(config.defaults.target);

  const unsupportedTargets = [...profileTargetIds]
    .map((targetId) => targetsById.get(targetId))
    .filter((target): target is NonNullable<typeof target> => Boolean(target && target.mode !== "attach"));

  if (unsupportedTargets.length === 0) return;

  const labels = unsupportedTargets.map((target) => `${target.id} (${target.mode})`).join(", ");

  throw new Error(`Phase 1 only supports attach-mode OpenCode targets for profile routing: ${labels}`);
}

function dispatchMessages(result: DispatchMessageResult): OutboundMessage[] {
  switch (result.status) {
    case "sent":
      return [
        {
          kind: "final",
          format: "markdown",
          text: result.turn.text?.trim() || "OpenCode completed without a text response.",
        },
      ];
    case "busy":
      return [
        {
          kind: "status",
          format: "plain",
          text: `Session ${result.resolution.binding.opencodeSessionId} is busy. Use /stop to abort the active run.`,
        },
      ];
    case "denied":
      return [
        {
          kind: "error",
          format: "plain",
          text: deniedDecisionText(result.decision.reason),
        },
      ];
    case "error":
      return [
        {
          kind: "error",
          format: "plain",
          text: `OpenCode error: ${result.error}`,
        },
      ];
  }
}

function outboundTargetFromMessage(message: InboundMessage): OutboundTarget {
  return {
    channel: message.channel,
    accountId: message.accountId,
    conversationKey: message.conversation.key,
    conversationId: message.conversation.id,
    threadId: message.conversation.threadId,
    topicId: message.conversation.topicId,
    raw: message.raw,
  };
}

function deniedDecisionText(reason: "unknown_sender" | "blocked"): string {
  return reason === "blocked" ? "Access denied: this sender is blocked." : "Access denied: this sender is not allowlisted.";
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

function defaultLogger(entry: GatewayLogEntry): void {
  console.log(JSON.stringify(entry));
}
