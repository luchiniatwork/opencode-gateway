import { getConfigSeeds } from "./config/load.ts";
import type {
  ChannelAdapter,
  ChannelAction,
  ChannelEvent,
  ChannelLogger,
  InboundMessage,
  OutboundTarget,
  TypingState,
} from "./channels/types.ts";
import { createTelegramAdapter } from "./channels/telegram/index.ts";
import { createCommandRouter } from "./commands/registry.ts";
import type { GatewayConfig, TelegramChannelConfig } from "./config/schema.ts";
import { openGatewayDatabase, type GatewayDatabase } from "./db/client.ts";
import { runMigrations } from "./db/migrations.ts";
import { createAccessRuleRepository } from "./db/repositories/access-rules.ts";
import { createConversationBindingRepository } from "./db/repositories/conversation-bindings.ts";
import { createDeliveryReceiptRepository } from "./db/repositories/delivery-receipts.ts";
import { createPendingPermissionRepository } from "./db/repositories/pending-permissions.ts";
import { createProfileRepository } from "./db/repositories/profiles.ts";
import { createRunRepository } from "./db/repositories/runs.ts";
import { seedDatabaseFromConfig } from "./db/repositories/seeds.ts";
import { createTargetRepository } from "./db/repositories/targets.ts";
import type { ProgressDelivery } from "./delivery/renderer.ts";
import { createDispatchResolver } from "./dispatch/resolver.ts";
import { createTurnRunner, type StartTurnResult, type TurnRunner } from "./gateway/turn-runner.ts";
import { createPermissionInteractionService, type PermissionInteractionService } from "./interactive/permissions.ts";
import type { OutboundMessage } from "./messages/types.ts";
import {
  createHealthSnapshot,
  type ChannelHealthStatus,
  type GatewayHealthSnapshot,
  type GatewayRuntimeHealthSnapshot,
} from "./observability/health.ts";
import {
  createJsonLogSink,
  type GatewayLogContext,
  type GatewayLogEntry,
  type GatewayLogLevel,
} from "./observability/logging.ts";
import { OpenCodeRuntime } from "./opencode/client.ts";
import type { AgentRuntime } from "./opencode/types.ts";

const TYPING_KEEPALIVE_MS = 4_000;

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
  turnRunTimeoutMs?: number;
}

export function createApp(options: GatewayAppOptions = {}): GatewayApp {
  const logger = options.logger ?? createJsonLogSink({ level: options.config?.gateway.logLevel });
  const now = options.now ?? (() => new Date());
  let started = false;
  let database: GatewayDatabase | undefined;
  let abortController: AbortController | undefined;
  let healthServer: ReturnType<typeof Bun.serve> | undefined;
  let turnRunner: TurnRunner | undefined;
  let permissionService: PermissionInteractionService | undefined;
  let diagnosticRepositories: {
    runs: ReturnType<typeof createRunRepository>;
    pendingPermissions: ReturnType<typeof createPendingPermissionRepository>;
  } | undefined;
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
            pendingPermissions: createPendingPermissionRepository(openedDatabase.db, { now }),
            deliveryReceipts: createDeliveryReceiptRepository(openedDatabase.db, { now }),
          };
          const staleRuns = repositories.runs.finishAllActive({
            status: "aborted",
            error: "Gateway restarted before observing a final response.",
          });
          const expiredStalePermissions = staleRuns.flatMap((run) => repositories.pendingPermissions.expirePendingByRunId(run.id));

          if (staleRuns.length > 0) {
            log("warn", "stale active runs marked aborted", {
              count: staleRuns.length,
              runIds: staleRuns.map((run) => run.id),
              expiredPermissionIds: expiredStalePermissions.map((permission) => permission.id),
            });
          }

          const runtime = options.runtime ?? new OpenCodeRuntime();
          const resolver = createDispatchResolver({ config: options.config, repositories, runtime });
          diagnosticRepositories = {
            runs: repositories.runs,
            pendingPermissions: repositories.pendingPermissions,
          };
          permissionService = createPermissionInteractionService({
            config: options.config.interactive.permissions,
            repositories,
            runtime,
            now,
            log,
          });
          turnRunner = createTurnRunner({
            runtime,
            runs: repositories.runs,
            pendingPermissions: repositories.pendingPermissions,
            deliveryReceipts: repositories.deliveryReceipts,
            observePermissions: options.config.interactive.permissions.mode !== "off",
            onPermissionRequest: (input) => permissionService?.sendPermissionRequest(input),
            runTimeoutMs: options.turnRunTimeoutMs,
            now,
            log,
          });
          const commandRouter = createCommandRouter({
            config: options.config,
            repositories,
            resolver,
            runtime,
            turnRunner,
            permissionService,
            pendingPermissions: repositories.pendingPermissions,
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
                  await handleChannelEvent(channel, event, async (message, delivery) => {
                    log("info", "inbound message received", messageLogContext(message));

                    const commandResult = await commandRouter.handle(message);

                    if (commandResult.handled) {
                      log("info", "gateway command handled", {
                        ...messageLogContext(message),
                        command: commandResult.command,
                      });

                      return commandResult.messages;
                    }

                    const bindingResult = await resolver.ensureBindingForMessage(message);

                    if (bindingResult.status === "denied") {
                      log("warn", "dispatch denied", {
                        ...messageLogContext(message),
                        reason: bindingResult.decision.reason,
                      });

                      return deniedMessages(bindingResult.decision.reason);
                    }

                    if (!turnRunner) throw new Error("Turn runner is not initialized");

                    const startResult = await turnRunner.start({
                      message,
                      resolution: bindingResult.resolution,
                      delivery,
                      signal: abortController?.signal,
                    });
                    logTurnStartResult(startResult, message);

                    return turnStartMessages(startResult);
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
          await turnRunner?.stop();
          turnRunner = undefined;
          permissionService = undefined;
          diagnosticRepositories = undefined;
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
      await turnRunner?.stop();
      turnRunner = undefined;
      permissionService = undefined;
      diagnosticRepositories = undefined;
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
    routeMessage: (message: InboundMessage, delivery: ProgressDelivery) => Promise<OutboundMessage[]>,
  ): Promise<void> {
    if (event.type === "action") {
      const { action } = event;
      const target = outboundTargetFromAction(action);
      const delivery = channelDelivery(channel, target);

      try {
        const handled = await permissionService?.handleAction(action, delivery);

        log(handled ? "info" : "debug", handled ? "channel action handled" : "channel action ignored", {
          channel: action.channel,
          accountId: action.accountId,
          conversationKey: action.conversation.key,
          actionId: action.actionId,
        });
      } catch (error) {
        log("error", "channel action handling failed", {
          channel: action.channel,
          accountId: action.accountId,
          conversationKey: action.conversation.key,
          actionId: action.actionId,
          error: formatError(error),
        });

        await channel.adapter.send(target, {
          kind: "error",
          format: "plain",
          text: `Gateway error: ${formatError(error)}`,
        });
      }

      return;
    }

    const { message } = event;
    const target = outboundTargetFromMessage(message);
    const stopTyping = startTyping(channel, target, message);
    const delivery = channelDelivery(channel, target);

    try {
      const responses = await routeMessage(message, delivery);

      for (const response of responses) {
        await delivery.send(response);
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
    } finally {
      stopTyping();
    }
  }

  function startTyping(
    channel: GatewayChannelRegistration<any>,
    target: OutboundTarget,
    message: InboundMessage,
  ): () => void {
    if (!channel.adapter.sendTyping) return () => undefined;

    const sendTyping = channel.adapter.sendTyping.bind(channel.adapter);
    let stopped = false;

    function sendTypingState(state: TypingState): void {
      Promise.resolve(sendTyping(target, state)).catch((error) => {
        log("warn", "channel typing update failed", {
          ...messageLogContext(message),
          state,
          error: formatError(error),
        });
      });
    }

    sendTypingState("typing");
    const timer = setInterval(() => {
      if (!stopped) sendTypingState("typing");
    }, TYPING_KEEPALIVE_MS);

    return () => {
      stopped = true;
      clearInterval(timer);
      sendTypingState("idle");
    };
  }

  function channelDelivery(channel: GatewayChannelRegistration<any>, target: OutboundTarget): ProgressDelivery {
    const delivery: ProgressDelivery = {
      send: (message) => channel.adapter.send(target, message),
    };

    if (channel.adapter.edit) {
      const edit = channel.adapter.edit.bind(channel.adapter);
      delivery.edit = (receipt, message) => edit(receipt, message);
    }

    if (channel.adapter.sendTyping) {
      const sendTyping = channel.adapter.sendTyping.bind(channel.adapter);
      delivery.setTyping = (state) => sendTyping(target, state);
    }

    return delivery;
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
      runtime: runtimeHealthSnapshot(),
    });
  }

  function runtimeHealthSnapshot(): GatewayRuntimeHealthSnapshot | undefined {
    if (!diagnosticRepositories) return undefined;

    return {
      activeRuns: diagnosticRepositories.runs.listActive().map((run) => ({
        id: run.id,
        bindingId: run.bindingId,
        sessionId: run.opencodeSessionId,
        opencodeMessageId: run.opencodeMessageId,
        startedAt: run.startedAt,
      })),
      queuedTurns: turnRunner?.listQueueDiagnostics() ?? [],
      pendingPermissions: diagnosticRepositories.pendingPermissions.listPending().map((permission) => ({
        id: permission.id,
        runId: permission.runId,
        opencodePermissionId: permission.opencodePermissionId,
        hasActionMessageReceipt: Boolean(permission.actionMessageReceiptId),
        expiresAt: permission.expiresAt,
      })),
    };
  }

  function logTurnStartResult(result: StartTurnResult, message: InboundMessage): void {
    const context = {
      ...messageLogContext(message),
      profileId: result.resolution.profile.id,
      targetId: result.resolution.target.id,
      sessionId: result.resolution.binding.opencodeSessionId,
      runId: result.run.id,
      opencodeMessageId: result.status === "started" ? result.handle.id : result.run.opencodeMessageId,
      queuedId: result.status === "queued" ? result.queuedId : undefined,
      queueSize: result.status === "queued" ? result.queueSize : undefined,
    };

    if (result.status === "error") {
      log("error", "turn start failed", { ...context, error: result.error });
      return;
    }

    log(result.status === "busy" ? "warn" : "info", `turn ${result.status}`, context);
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

function turnStartMessages(result: StartTurnResult): OutboundMessage[] {
    switch (result.status) {
    case "started":
      return [];
    case "queued":
      return [
        {
          kind: "status",
          format: "plain",
          text: `Queued behind active run ${result.run.id}. Queue size: ${result.queueSize}.`,
        },
      ];
    case "busy": {
      const activeSessionId = result.run.opencodeSessionId;
      const currentSessionId = result.resolution.binding.opencodeSessionId;
      const sessionText =
        activeSessionId === currentSessionId
          ? `Session ${currentSessionId} is busy.`
          : `Session ${currentSessionId} is blocked by active run ${result.run.id} from previous session ${activeSessionId}.`;

      return [
        {
          kind: "status",
          format: "plain",
          text: `${sessionText} Use /stop to abort the active run.`,
        },
      ];
    }
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

function deniedMessages(reason: "unknown_sender" | "blocked"): OutboundMessage[] {
  return [
    {
      kind: "error",
      format: "plain",
      text: deniedDecisionText(reason),
    },
  ];
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

function outboundTargetFromAction(action: ChannelAction): OutboundTarget {
  return {
    channel: action.channel,
    accountId: action.accountId,
    conversationKey: action.conversation.key,
    conversationId: action.conversation.id,
    threadId: action.conversation.threadId,
    topicId: action.conversation.topicId,
    raw: action.raw,
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
