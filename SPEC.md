# OpenCode-First Messaging Gateway Specification

## 1. Purpose

Build a small, self-hosted messaging gateway that connects chat
surfaces such as Telegram, Slack, and Discord to OpenCode while
keeping **OpenCode as both the boss agent and the specialist execution
harness**.

This project exists because OpenCode already provides the agent loop,
model/provider configuration, tools, permissions, sessions, subagents,
and HTTP/SDK surface. What is missing is a durable, mobile-friendly
messaging gateway comparable to the Hermes/OpenClaw gateway layer, but
without replacing OpenCode as the primary control plane.

The gateway should be a transport and operations layer, not a
competing agent framework.

```text
Telegram / Slack / Discord / future channels
        │
        ▼
OpenCode Messaging Gateway
  - channel adapters
  - auth / pairing / allowlists
  - session bindings
  - message batching
  - media normalization
  - command interception
  - progress formatting
        │
        ▼
OpenCode Runtime Adapter
  - @opencode-ai/sdk or higher-level wrapper
  - opencode serve lifecycle, optional
  - session create/resume/prompt_async
  - SSE event observation
  - abort / permission response
        │
        ▼
OpenCode server + configured OpenCode agents/subagents
```

## 2. Design Principles

1. **OpenCode owns intelligence.** The gateway must not introduce a
   second agent that decides what work means. Natural-language user
   intent should go directly to OpenCode unless intercepted as an
   explicit gateway command.
2. **Gateway owns transport.** Platform APIs, retries, formatting,
   media downloads, message batching, auth, and chat UX belong in the
   gateway.
3. **Thin by default, extensible by design.** Start with a small
   TypeScript service and clean interfaces rather than a
   framework-sized runtime.
4. **Session continuity and selection are product features.** A chat
   thread should consistently map to the same OpenCode session until
   reset or explicitly rebound, and users should be able to inspect,
   select, resume, and switch sessions intentionally from the messaging
   surface.
5. **Safe remote control.** Messaging surfaces are untrusted
   inputs. Default to pairing/allowlists, conservative command access,
   and explicit permission flows.
6. **Operational clarity beats magic.** Every routing decision should
   be inspectable: channel, account, conversation, OpenCode server,
   OpenCode session, agent, current status.
7. **Operational guidance without policy lock-in.** The project should
   document recommended ways to run OpenCode as the control plane
   (attach mode, managed `opencode serve`, workspace layout, config
   isolation, VCS/concurrency safety), but the gateway must not impose a
   particular repository workflow or silently mutate VCS state itself.

## 3. Goals

### 3.1 MVP Goals

- Run as a long-lived local daemon or foreground process.
- Connect at least one initial messaging platform, preferably Telegram
  because setup and feedback loops are fast.
- Route inbound messages to OpenCode sessions through OpenCode's
  HTTP/SDK interface.
- Hide raw OpenCode SDK details behind a gateway-local wrapper and
  evaluate `@liontree/opencode-agent-sdk` for session/event
  normalization so channel code does not depend directly on
  low-level OpenCode API shapes.
- Preserve per-chat/per-thread OpenCode session bindings.
- Support a single default profile plus explicit in-chat profile
  switching (`/profile`) so the first implementation can test multiple
  identities/control-plane configurations through one bot.
- Support async execution with progress/status updates from OpenCode
  events.
- Support interactive OpenCode permission request messages on the
  initial platform, using native buttons/actions where available
  (Telegram inline keyboard first) instead of requiring users to type
  approval commands.
- Support gateway commands:
  - `/help`
  - `/status`
  - `/new` or `/reset`
  - `/stop`
  - `/sessions`
  - `/use-session`
  - `/profiles`
  - `/profile`
  - `/agent`
  - `/model`
- Support simple allowlist or pairing-based access control.
- Store local state in SQLite.
- Provide structured logs and a basic health endpoint.

### 3.2 Near-Term Goals

- Add Slack and Discord adapters.
- Support message batching/debouncing for rapid-fire messages.
- Support media downloads and forwarding to OpenCode where OpenCode
  supports file/image message parts.
- Support multiple OpenCode server targets/workspaces.
- Support named bindings, e.g. `work`, `oss`, `infra`, `personal`.
- Support background task-style behavior through OpenCode sessions,
  not a separate gateway agent.
- Extend permission request routing beyond the initial platform and add
  richer policy controls for who can approve which requests.
- Support webhook ingestion with configurable transformer functions:
  webhook payload comes in, a transformer maps it to one or more
  gateway messages, and the result is dispatched into the same binding
  and OpenCode runtime path as chat messages.
- Add a cron scheduler/server whose jobs dispatch messages into
  OpenCode sessions and which can also be exposed as an optional tool
  inside the OpenCode control plane.
- Add an optional OpenCode `question` tool replacement/bridge that
  renders questions, choices, and free-form prompts natively in the
  messaging client, then returns the user response to OpenCode.

### 3.3 Long-Term Goals

- Channel plugin SDK.
- Web dashboard for sessions, channel status, and bindings.
- First-class multi-profile deployment modes:
  1. **One bot, explicit profile switching** (`/profile cto`) — the MVP
     starting point because it is easiest to test with one token and one
     chat surface.
  2. **One bot, profile selected by binding** — route specific
     channels, topics, DMs, or threads to profiles automatically.
  3. **One bot/account per profile** — expose distinct
     platform-native bot identities for profiles such as CTO, Ops, or
     Personal.
- Multi-device/mobile node features only if they naturally fall out of
  user demand.
- Optional adapters for WhatsApp, Matrix, Signal, Email, ntfy.
- Optional hosted/remote deployment mode with a hardened security
  profile.

## 4. Non-Goals

- Do not build a new general-purpose agent runtime.
- Do not implement a planner/worker/reviewer hierarchy in the gateway.
- Do not reimplement OpenCode tools, permissions, MCP, memory,
  subagents, or model routing.
- Do not make OpenClaw, Hermes, or another gateway a mandatory runtime
  dependency.
- Do not start with all messaging platforms. Breadth comes after the
  adapter contract proves itself.
- Do not scrape or drive the OpenCode TUI. Use `opencode serve` and
  the SDK/API.
- Do not assume OpenCode is always local forever, but optimize for
  local-first operation.

## 5. Prior Art and Lessons

### 5.1 Hermes

Hermes validates the operational model:

- one gateway process
- platform adapters
- per-chat sessions
- `/background`
- queue/interrupt/steer modes
- progress messages
- mobile-friendly defaults

Lesson: the gateway UX matters as much as the agent runtime. Users
need control commands, status visibility, interruption, and background
completion messages.

### 5.2 OpenClaw

OpenClaw validates the gateway/channel abstraction but is too coupled
to its own session/agent/runtime model to extract cheaply.

Useful ideas to borrow:

- channel plugin shape
- session bindings
- message debouncing
- durable outbound delivery
- command interception
- pairing/allowlist defaults
- ACP as an external harness path

Avoid copying:

- replacing OpenCode with OpenClaw as the facade agent
- deep OpenClaw session/runtime coupling
- broad platform scope before core OpenCode integration is excellent

### 5.3 OpenCode

OpenCode already provides the important runtime primitives:

- `opencode serve`
- HTTP/OpenAPI server
- TypeScript SDK
- sessions
- messages
- async prompts
- events/SSE
- abort
- commands
- agents/subagents
- permission responses

This gateway should compose those primitives.

### 5.4 OpenCode SDK Wrappers

`@opencode-ai/sdk` is the source-of-truth client for OpenCode's server
API, but a messaging gateway benefits from a higher-level runtime
surface: reusable sessions, event normalization, subagent lineage,
final-result resolution, and observe-without-prompt support.

The project should evaluate `@liontree/opencode-agent-sdk` as either:

- a direct dependency for OpenCode runtime interaction, or
- prior art for the gateway's own `OpenCodeRuntime` wrapper.

The architectural requirement is that channel adapters depend on the
gateway's runtime interface, not directly on either SDK package.

## 6. System Architecture

### 6.1 Components

```text
src/
  app.ts                      # process composition root
  config/                     # config loading, schema, secrets refs
  db/                         # SQLite migrations and repositories
  gateway/                    # orchestration services, command router
  profiles/                   # identities/control-plane defaults
  dispatch/                   # profile/target/session/delivery resolution
  channels/
    types.ts                  # adapter contracts
    telegram/                 # first adapter
    slack/                    # future adapter
    discord/                  # future adapter
  opencode/
    client.ts                 # OpenCode SDK wrapper
    events.ts                 # SSE normalization
    sessions.ts               # session lifecycle and binding operations
    permissions.ts            # permission request response handling
  messages/
    normalize.ts              # inbound message normalization
    debounce.ts               # message batching
    format.ts                 # outbound markdown/platform formatting
  security/
    access.ts                 # allowlist/pairing/roles
    pairing.ts
  commands/
    registry.ts               # /status, /new, /stop, etc.
  webhooks/
    server.ts                 # webhook HTTP ingress
    transformers.ts           # payload → gateway message mapping
  automation/
    cron.ts                   # scheduled gateway dispatch
    tools.ts                  # optional OpenCode-facing cron tool
  interactive/
    permissions.ts            # approval cards/buttons
    questions.ts              # optional question tool bridge
  delivery/
    queue.ts                  # durable outbound sends, initially simple
    renderer.ts               # progress/final rendering
  observability/
    logging.ts
    health.ts
```

### 6.2 Runtime Flow

```text
Inbound platform event
  → ChannelAdapter or WebhookAdapter normalizes to InboundMessage
  → AccessController authorizes sender/conversation
  → CommandRouter intercepts explicit slash commands
  → Debouncer optionally batches rapid user messages
  → DispatchResolver selects profile, OpenCode target, session, delivery target
  → OpenCodeAdapter sends prompt_async or prompt
  → EventObserver subscribes to OpenCode events
  → ProgressRenderer emits chat progress updates
  → FinalRenderer emits final answer
  → Session/binding metadata updated in SQLite
```

### 6.3 Core Boundary

The most important interface is the runtime adapter boundary:

```ts
interface AgentRuntime {
  ensureSession(input: EnsureSessionInput): Promise<RuntimeSession>;
  send(input: SendRuntimeMessageInput): Promise<RuntimeTurn>;
  sendAsync(input: SendRuntimeMessageInput): Promise<RuntimeTurnHandle>;
  observe(input: ObserveRuntimeTurnInput): AsyncIterable<RuntimeEvent>;
  abort(input: AbortRuntimeTurnInput): Promise<void>;
  respondToPermission(input: PermissionResponseInput): Promise<void>;
  listSessions(input?: ListRuntimeSessionsInput): Promise<RuntimeSession[]>;
}
```

The first and primary implementation is `OpenCodeRuntime`. The
interface exists only to keep the gateway testable and to avoid
hard-coding SDK details into channel adapters.

### 6.4 Profiles and Dispatch Targets

The gateway needs separate routing layers so profiles, OpenCode
targets, sessions, and delivery destinations can vary independently.

```text
Profile routing:
  Which identity/control-plane configuration is handling this?

Runtime target routing:
  Which OpenCode server/config/workspace should execute the turn?

Session routing:
  Which OpenCode session receives this turn?

Delivery routing:
  Where should progress, questions, approvals, and final output appear?
```

This avoids overloading `conversation → session` with too much meaning.
A conversation binding should point to a profile, and the profile should
provide defaults for target, agent, model, verbosity, busy behavior, and
operational policy.

```ts
interface GatewayProfile {
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
  defaults?: {
    verbosity?: "off" | "compact" | "tools" | "verbose";
    busyMode?: "queue" | "interrupt" | "reject" | "steer";
  };
}

type SessionSelector =
  | { type: "active-for-conversation"; conversationKey: string }
  | { type: "most-recent-for-profile"; profileId: string }
  | { type: "pinned-session"; sessionId: string }
  | { type: "named-session"; name: string }
  | { type: "new-session-per-run"; titleTemplate?: string }
  | { type: "new-session-on-schedule-window"; window: "daily" | "weekly" | "monthly" };

interface DispatchTarget {
  profileId: string;
  opencodeTargetId: string;
  sessionSelector: SessionSelector;
  deliveryTarget?: DeliveryTarget;
}
```

MVP should implement one bot with explicit profile switching. Automatic
binding-selected profiles and separate bot identities are intended
targets, but not prerequisites for proving the OpenCode-first path.

Intended profile deployment modes:

1. **One bot, explicit profile switching.** A single platform bot serves
   multiple profiles, and users switch with `/profile <id>`. This is the
   MVP path because it is easiest to test and requires only one bot
   token/account.
2. **One bot, profile selected by binding.** The gateway automatically
   chooses a profile based on channel, thread/topic, DM, webhook, or
   cron binding. This is useful for routing `#infra-alerts` to an Ops
   profile and `#architecture` to a CTO profile without user commands.
3. **One platform bot/account per profile.** Each profile has a
   platform-native identity, such as separate Telegram bots or Slack app
   installations. This is clearest for users but costs more setup and
   should come after the shared gateway/profile model is proven.

## 7. Channel Adapter Contract

### 7.1 Adapter Shape

```ts
interface ChannelAdapter {
  id: ChannelId;
  start(ctx: ChannelStartContext): Promise<void>;
  stop(): Promise<void>;
  send(target: OutboundTarget, message: OutboundMessage): Promise<SendReceipt>;
  sendTyping?(target: OutboundTarget, state: TypingState): Promise<void>;
  edit?(receipt: SendReceipt, message: OutboundMessage): Promise<SendReceipt>;
  delete?(receipt: SendReceipt): Promise<void>;
}

interface ChannelStartContext {
  accountId: string;
  config: unknown;
  signal: AbortSignal;
  emit: (event: ChannelEvent) => Promise<void>;
  logger: Logger;
}
```

Channel adapters must not call OpenCode directly. They emit normalized
channel events and accept outbound messages.

### 7.2 Normalized Inbound Event

```ts
interface InboundMessage {
  id: string;
  channel: ChannelId;
  accountId: string;
  conversation: ConversationRef;
  sender: SenderRef;
  timestamp: string;
  text: string;
  commandText?: string;
  attachments: InboundAttachment[];
  replyTo?: MessageRef;
  raw?: unknown;
}
```

### 7.3 Conversation Identity

Conversation identity must be stable and platform-aware.

Examples:

```text
telegram:default:dm:123456789
telegram:default:group:-100123:topic:42
slack:work:channel:C123
slack:work:thread:C123:1712345678.000100
discord:main:guild:111:channel:222
discord:main:thread:333
```

The binding key is not the display name. It is a canonical ID.

## 8. OpenCode Runtime Adapter

### 8.1 Server Modes

Support two modes:

1. **Attach mode**: connect to an existing OpenCode server URL.
2. **Managed mode**: start `opencode serve` as a child process for a
   configured workspace.

MVP should prefer attach mode. Managed mode can come next.

### 8.2 OpenCode Session Mapping

Each conversation binding maps to an OpenCode session.

```text
conversation_key → opencode_target_id + session_id + optional agent/model
```

If no binding exists:

1. Resolve default target for channel/account/conversation.
2. Create an OpenCode session.
3. Store binding.
4. Send the inbound prompt.

### 8.2.1 Session Selection

Session selection is a first-class user workflow, not only an internal
mapping detail. Users should be able to:

- list recent OpenCode sessions for a conversation or target
- switch the conversation binding to an existing session
- create a new session intentionally
- label or title important sessions where OpenCode supports it
- see which session will receive the next message before sending

The gateway should never silently discard a binding when the user asks
for a new session; old sessions remain discoverable until pruned by an
explicit retention policy.

### 8.3 Prompt Construction

Default behavior should send user text as-is, plus a small gateway
envelope as context only when useful.

Avoid over-prompting. OpenCode should see the user’s message as the
user’s message.

Optional system/context metadata:

```text
Message came from Telegram DM with @alice.
Conversation key: telegram:default:dm:123456789.
Attachments: 1 image, 1 document.
```

This metadata should be concise and preferably included as structured
text or separate context part if OpenCode supports it.

### 8.4 Event Observation

The adapter should normalize OpenCode events into:

```ts
type RuntimeEvent =
  | { type: "status"; status: "queued" | "running" | "idle" | "aborted" | "error" }
  | { type: "text_delta"; text: string }
  | { type: "tool_start"; id: string; name: string; summary?: string }
  | { type: "tool_update"; id: string; name: string; summary?: string }
  | { type: "tool_end"; id: string; name: string; ok: boolean; summary?: string }
  | { type: "permission_request"; id: string; summary: string; details?: unknown }
  | { type: "question_request"; id: string; prompt: string; choices?: string[] }
  | { type: "final"; text: string; costUsd?: number; tokens?: TokenUsage }
  | { type: "error"; message: string; retryable?: boolean };
```

The `question_request` event is optional and may instead be implemented
as a gateway-hosted OpenCode tool. In either case, OpenCode should be
able to ask the user for clarification while the gateway renders the
interaction appropriately for the current messaging surface.

### 8.5 OpenCode Commands

Gateway commands may call OpenCode commands where appropriate:

- `/opencode-command review-pr 123`
- `/agent cto`
- `/model openai/gpt-5.5`

However, normal user messages should not be parsed by the gateway for
intent. That is OpenCode’s job.

### 8.6 Operating OpenCode as the Control Plane

The project should publish operational recommendations for running
OpenCode behind the gateway, without turning those recommendations into
hard requirements.

Recommended topics:

- attach mode versus managed `opencode serve`
- one OpenCode server per workspace versus shared server
- config directory isolation for different roles/workspaces
- model and agent defaults
- permission policy posture for remote messaging access
- VCS/concurrency safety guidelines, especially for repositories where
  multiple OpenCode or terminal sessions may operate concurrently
- process supervision for managed servers
- backup/retention guidance for OpenCode and gateway session state

The gateway may validate obviously broken target configuration, but it
should not enforce a specific branching model, VCS tool, workspace
layout, or commit workflow.

## 9. Command Model

### 9.1 Gateway Commands

Gateway commands are explicit slash commands intercepted before
OpenCode.

| Command           | Purpose                                                       |
|-------------------|---------------------------------------------------------------|
| `/help`           | Show available commands and current binding.                  |
| `/status`         | Show gateway, channel, OpenCode target, session, active turn. |
| `/new` / `/reset` | Create a new OpenCode session for this conversation.          |
| `/stop`           | Abort active OpenCode turn for this conversation.             |
| `/sessions`       | List recent sessions for this sender/conversation.            |
| `/use-session <id>` | Rebind this conversation to an existing OpenCode session.    |
| `/profiles`       | List available gateway profiles.                              |
| `/profile [id]`   | Show or explicitly switch this conversation's active profile.  |
| `/bind <target>`  | Bind conversation to a named OpenCode target/workspace.       |
| `/unbind`         | Remove current binding.                                       |
| `/agent [name]`   | Show or set OpenCode agent for future turns in this binding.  |
| `/model [id]`     | Show or set model override for future turns in this binding.  |
| `/verbose on/off` | Toggle tool/progress verbosity for this conversation.         |

Permission approvals should normally be handled through native
interactive messages (for example Telegram inline buttons), not slash
commands. Text fallbacks such as `/permission approve <id>` and
`/permission deny <id>` may exist for platforms without buttons or for
accessibility/debugging, but they are not the primary UX.

### 9.2 Command Authorization

Roles:

- `owner`: full access, all commands.
- `admin`: manage sessions/bindings for allowed channels.
- `user`: chat, status, stop own run, reset own session.
- `blocked`: no access.

Commands like `/bind`, `/model`, `/agent`, and profile management should
require owner/admin by default. Switching among already-allowed profiles
may be available to normal users when the profile's access policy permits
it. Permission approval actions should also require owner/admin unless a
binding explicitly allows the active user to approve their own session's
prompts.

## 10. Security Model

### 10.1 Default Security Posture

- Inbound DMs from unknown users are denied or sent a pairing
  challenge.
- Group/channel messages require mention by default unless explicitly
  configured.
- Dangerous gateway commands require owner/admin.
- OpenCode permission prompts are never auto-approved by the gateway
  unless explicitly configured.
- Secrets are read from environment variables or secret files, not
  committed config.

### 10.2 Pairing Flow

Unknown sender:

```text
Pairing required. Code: ABCD-1234
Approve with: gateway pairing approve telegram ABCD-1234
```

Pairing records:

```ts
interface PairingRecord {
  id: string;
  channel: ChannelId;
  accountId: string;
  senderId: string;
  codeHash: string;
  expiresAt: string;
  approvedAt?: string;
  role?: AccessRole;
}
```

### 10.3 Permission Requests

When OpenCode asks for permission:

1. Gateway stores pending permission request.
2. Gateway posts a concise approval message to the conversation or
   owner channel with native actions where available (Approve, Deny,
   optionally Always Allow for a narrowly-scoped remembered decision if
   OpenCode supports it).
3. Authorized user selects the action in the messaging client. Text
   fallback commands may be supported where native actions are
   unavailable.
4. Gateway calls OpenCode permission response endpoint.

Approval messages should include:

- command/tool name
- risk summary
- workspace/target
- requesting session
- timeout

The gateway should edit or reply to the approval message after
resolution so the chat history clearly shows whether the request was
approved, denied, expired, or superseded.

## 11. Message Batching and Busy Behavior

### 11.1 Batching

Users often send multiple short messages quickly. The gateway should
support per-conversation debounce.

Default MVP policy:

- debounce text messages for 1.5 seconds
- do not debounce slash commands
- do not debounce approval commands
- media + caption should be combined where platform APIs deliver them
  separately

### 11.2 Busy Modes

When OpenCode is already running for a conversation:

| Mode        | Behavior                                                                  |
|-------------|---------------------------------------------------------------------------|
| `queue`     | Queue new user message as next turn. MVP default.                         |
| `interrupt` | Abort current run and start new turn.                                     |
| `reject`    | Reply that the session is busy.                                           |
| `steer`     | Future: send steering instruction to current run if OpenCode supports it. |

MVP should implement `queue` and `/stop`.

## 12. Automation and Interactive OpenCode Tools

### 12.1 Webhook Ingress

The gateway should support webhooks as another inbound surface. Webhooks
are not chat platforms, but after transformation they should enter the
same dispatch path as a normal message.

```text
HTTP webhook request
  → authentication/signature verification
  → transformer(payload, headers, query)
  → InboundMessage[]
  → binding resolution
  → OpenCode session dispatch
```

Transformer requirements:

- configured per endpoint
- deterministic and side-effect-light
- receives raw payload, headers, query parameters, and endpoint config
- returns one or more normalized gateway messages
- can choose target/binding hints, urgency, and optional metadata

Example use cases:

- GitHub issue/PR event → ask OpenCode to triage or summarize
- Linear issue event → ask OpenCode to draft an implementation plan
- monitoring alert → ask OpenCode to investigate using configured tools
- custom form submission → route to a named OpenCode workspace

### 12.2 Cron Scheduler

The gateway should include a small cron scheduler for recurring prompts
into OpenCode sessions.

Cron scheduling must distinguish between **execution routing** and
**delivery routing**:

- execution routing decides which profile, OpenCode target, and session
  receives the prompt
- delivery routing decides where progress/final summaries appear

The common default should be simple: append the cron prompt to the
active session for the configured conversation and deliver the result
back to that same conversation. But operational jobs often need a
different strategy, such as a pinned `infra-daily` session, a fresh
session per run, or a profile-specific most-recent session.

Cron jobs should support:

- schedule expression
- target OpenCode binding/session or target workspace
- profile
- session selector strategy
- delivery target
- prompt template
- timezone
- enabled/disabled state
- last/next run metadata
- delivery target for completion summaries

The cron subsystem should also be exposed as an optional OpenCode tool
or MCP server so the OpenCode control plane can list, create, update,
pause, and delete scheduled jobs when allowed by policy.

This keeps scheduling operationally owned by the gateway while letting
OpenCode manage schedules conversationally.

Cron status messages should surface routing explicitly so the user can
see whether the job appended to the current chat session, used a named
session, or created a fresh session:

```text
⏰ Cron: daily-status
Profile: CTO Tiago
Target: ai-sharing
Session: active-for-conversation / sess_abc123
Delivery: telegram:default:dm:123456789
```

Useful chat commands:

- `/cron list`
- `/cron show <job>`
- `/cron bind <job> here`
- `/cron session <job> active`
- `/cron session <job> named <name>`
- `/cron session <job> new-per-run`
- `/cron deliver <job> here`

### 12.3 Question Tool Bridge

OpenCode may need to ask the human a clarification question. The
gateway should optionally provide a replacement or bridge for OpenCode's
`question` tool that renders well in messaging clients.

The bridge should support:

- free-form text responses
- multiple choice buttons where supported
- timeout/default behavior
- routing the question to the active conversation or configured owner
  channel
- returning the answer to the waiting OpenCode turn

This is intentionally separate from permission approvals: permissions
are safety decisions; questions are product/workflow clarification.

## 13. Outbound Rendering

### 13.1 Progress Messages

Mobile-friendly default:

- Send a short “working” acknowledgement after ~2 seconds.
- Update one progress message if platform supports editing.
- Avoid spamming every tool call by default.

Verbosity modes:

- `off`: final answer only.
- `compact`: working heartbeat + final answer.
- `tools`: include tool start/end summaries.
- `verbose`: detailed tool updates and debug info.

### 13.2 Final Messages

- Preserve Markdown where supported.
- Convert Markdown to platform-specific format.
- Split long messages safely.
- Preserve code blocks.
- Attach generated files/media when supported.

## 14. Persistence

Use SQLite initially. It is enough, inspectable, and local-first.

### 14.1 Tables

#### `targets`

Named OpenCode servers/workspaces.

```sql
id TEXT PRIMARY KEY,
name TEXT NOT NULL UNIQUE,
mode TEXT NOT NULL, -- attach | managed
server_url TEXT,
workdir TEXT,
config_dir TEXT,
default_agent TEXT,
default_model TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

#### `profiles`

Gateway identities/control-plane defaults. MVP may ship with one
`default` profile plus explicit `/profile` switching.

```sql
id TEXT PRIMARY KEY,
display_name TEXT NOT NULL,
description TEXT,
avatar TEXT,
default_target_id TEXT NOT NULL,
default_agent TEXT,
default_model TEXT,
default_config_dir TEXT,
access_policy_id TEXT,
command_policy_id TEXT,
default_busy_mode TEXT,
default_verbosity TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

#### `conversation_bindings`

```sql
id TEXT PRIMARY KEY,
conversation_key TEXT NOT NULL UNIQUE,
channel TEXT NOT NULL,
account_id TEXT NOT NULL,
profile_id TEXT NOT NULL,
target_id TEXT NOT NULL,
opencode_session_id TEXT NOT NULL,
session_name TEXT,
agent TEXT,
model TEXT,
busy_mode TEXT NOT NULL DEFAULT 'queue',
verbosity TEXT NOT NULL DEFAULT 'compact',
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

#### `runs`

```sql
id TEXT PRIMARY KEY,
binding_id TEXT NOT NULL,
opencode_session_id TEXT NOT NULL,
opencode_message_id TEXT,
status TEXT NOT NULL,
started_at TEXT NOT NULL,
finished_at TEXT,
error TEXT
```

#### `pending_permissions`

```sql
id TEXT PRIMARY KEY,
run_id TEXT NOT NULL,
opencode_permission_id TEXT NOT NULL,
summary TEXT NOT NULL,
details_json TEXT,
action_message_receipt_id TEXT,
status TEXT NOT NULL, -- pending | approved | denied | expired
created_at TEXT NOT NULL,
expires_at TEXT NOT NULL,
resolved_at TEXT
```

#### `access_rules`

```sql
id TEXT PRIMARY KEY,
channel TEXT NOT NULL,
account_id TEXT NOT NULL,
sender_id TEXT NOT NULL,
role TEXT NOT NULL,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

#### `delivery_receipts`

```sql
id TEXT PRIMARY KEY,
run_id TEXT,
channel TEXT NOT NULL,
account_id TEXT NOT NULL,
conversation_key TEXT NOT NULL,
platform_message_id TEXT NOT NULL,
kind TEXT NOT NULL, -- ack | progress | final | error
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

#### `webhook_endpoints`

```sql
id TEXT PRIMARY KEY,
name TEXT NOT NULL UNIQUE,
path TEXT NOT NULL UNIQUE,
auth_mode TEXT NOT NULL, -- none | shared_secret | signature
transformer TEXT NOT NULL,
default_profile_id TEXT,
default_target_id TEXT,
enabled INTEGER NOT NULL DEFAULT 1,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

#### `cron_jobs`

```sql
id TEXT PRIMARY KEY,
name TEXT NOT NULL UNIQUE,
schedule TEXT NOT NULL,
timezone TEXT,
profile_id TEXT,
target_id TEXT,
conversation_key TEXT,
session_selector_json TEXT NOT NULL,
delivery_target_json TEXT,
prompt_template TEXT NOT NULL,
enabled INTEGER NOT NULL DEFAULT 1,
last_run_at TEXT,
next_run_at TEXT,
created_at TEXT NOT NULL,
updated_at TEXT NOT NULL
```

#### `interactive_requests`

Tracks non-permission human interactions such as OpenCode question tool
requests.

```sql
id TEXT PRIMARY KEY,
run_id TEXT NOT NULL,
kind TEXT NOT NULL, -- question | choice | form
prompt TEXT NOT NULL,
choices_json TEXT,
status TEXT NOT NULL, -- pending | answered | expired | cancelled
response_json TEXT,
action_message_receipt_id TEXT,
created_at TEXT NOT NULL,
expires_at TEXT,
resolved_at TEXT
```

## 15. Configuration

Config file example:

```json5
{
  gateway: {
    host: "127.0.0.1",
    port: 8765,
    databasePath: "~/.opencode-gateway/state.db",
    logLevel: "info"
  },
  opencode: {
    targets: [
      {
        id: "default",
        name: "Default workspace",
        mode: "attach",
        serverUrl: "http://127.0.0.1:4096",
        defaultAgent: "build"
      },
      {
        id: "ai-sharing",
        name: "AI Sharing repo",
        mode: "managed",
        workdir: "/home/tiago_theoai_ai/repos/work/ai-sharing",
        configDir: "/home/tiago_theoai_ai/repos/work/ai-sharing/tiago-setup",
        defaultAgent: "cto"
      }
    ]
  },
  profiles: {
    default: "cto",
    entries: [
      {
        id: "cto",
        displayName: "Tiago CTO",
        description: "Architecture, review, and technical leadership",
        defaultTarget: "ai-sharing",
        defaultAgent: "cto",
        defaultModel: "google-vertex-anthropic/claude-opus-4-6@default",
        defaults: { verbosity: "compact", busyMode: "queue" }
      },
      {
        id: "ops",
        displayName: "Ops",
        description: "Operational checks and scheduled automation",
        defaultTarget: "default",
        defaultAgent: "build",
        defaults: { verbosity: "tools", busyMode: "queue" }
      }
    ]
  },
  channels: {
    telegram: {
      enabled: true,
      token: "{env:TELEGRAM_BOT_TOKEN}",
      allowFrom: ["123456789"],
      groups: {
        "-1001234567890": { requireMention: true }
      }
    }
  },
  webhooks: {
    enabled: true,
    endpoints: [
      {
        name: "github-triage",
        path: "/webhooks/github-triage",
        authMode: "signature",
        secret: "{env:GITHUB_WEBHOOK_SECRET}",
        transformer: "./transformers/github-triage.ts",
        defaultProfile: "cto",
        defaultTarget: "ai-sharing"
      }
    ]
  },
  cron: {
    enabled: true,
    exposeToolToOpenCode: false,
    jobs: [
      {
        name: "daily-status",
        schedule: "0 9 * * 1-5",
        timezone: "America/Sao_Paulo",
        profile: "cto",
        target: "default",
        sessionSelector: { type: "active-for-conversation", conversationKey: "telegram:default:dm:123456789" },
        deliveryTarget: { type: "conversation", conversationKey: "telegram:default:dm:123456789" },
        prompt: "Review open work and summarize what needs attention today."
      }
    ]
  },
  interactive: {
    permissions: { mode: "buttons", fallbackCommands: true },
    questionBridge: { enabled: false }
  },
  defaults: {
    profile: "cto",
    target: "default",
    busyMode: "queue",
    verbosity: "compact",
    inboundDebounceMs: 1500
  }
}
```

## 16. CLI

Proposed commands:

```bash
opencode-gateway init
opencode-gateway serve --config ~/.opencode-gateway/config.jsonc
opencode-gateway doctor
opencode-gateway targets list
opencode-gateway targets add default --server-url http://127.0.0.1:4096
opencode-gateway profiles list
opencode-gateway profiles add cto --target ai-sharing --agent cto
opencode-gateway channels status
opencode-gateway webhooks list
opencode-gateway webhooks test github-triage ./payload.json
opencode-gateway cron list
opencode-gateway cron run daily-status
opencode-gateway sessions list
opencode-gateway bindings list
opencode-gateway pairing list
opencode-gateway pairing approve telegram ABCD-1234 --role owner
```

## 17. Health and Observability

### 17.1 Health Endpoint

```text
GET /health
```

Returns:

```json
{
  "ok": true,
  "version": "0.1.0",
  "channels": {
    "telegram:default": "running"
  },
  "opencodeTargets": {
    "default": "healthy"
  },
  "profiles": {
    "default": "cto",
    "active": ["cto", "ops"]
  },
  "webhooks": {
    "github-triage": "enabled"
  },
  "cron": {
    "enabled": true,
    "dueJobs": 0
  }
}
```

### 17.2 Logs

Use structured JSON logs with fields:

- `timestamp`
- `level`
- `component`
- `source` (`channel`, `webhook`, `cron`, `tool`)
- `channel`
- `accountId`
- `conversationKey`
- `targetId`
- `profileId`
- `sessionId`
- `runId`
- `message`

### 17.3 Metrics, Later

- inbound messages by channel
- active runs
- run duration
- OpenCode errors
- delivery failures
- permission requests
- webhook deliveries and transformer failures
- cron job runs/failures
- interactive question requests and response latency

## 18. Error Handling

### 18.1 OpenCode Unavailable

If target is unavailable:

- reply with a concise error
- mark target unhealthy
- do not lose the inbound message if queueing is enabled
- provide operator hint: server URL, last error, recovery command

### 18.2 Platform Delivery Failure

- retry transient failures with backoff
- store delivery failure in SQLite
- avoid infinite retry loops for permanent errors

### 18.3 Gateway Restart

On restart:

- reload bindings
- reconnect channels
- check OpenCode target health
- mark interrupted runs as `unknown` or `interrupted`
- optionally notify owner channel if configured

## 19. Testing Strategy

### 19.1 Unit Tests

- conversation key generation
- profile resolution and dispatch target selection
- command parsing
- access control decisions
- debounce behavior
- binding resolution
- OpenCode event normalization
- Markdown/platform formatting
- webhook transformer execution and validation
- cron schedule calculation and dispatch planning
- cron session selector behavior
- interactive permission/question request lifecycle

### 19.2 Integration Tests

- fake channel adapter → fake OpenCode runtime
- Telegram sandbox bot where feasible
- OpenCode attach mode against local `opencode serve`
- explicit `/profile` switching in one bot conversation
- native permission action round trip, starting with Telegram buttons
- webhook payload → transformed message → OpenCode dispatch
- cron job → OpenCode dispatch
- question bridge request → messaging response → OpenCode answer

### 19.3 Contract Tests

Each channel adapter must pass contract tests:

- can start/stop
- can normalize inbound message
- can send final response
- can handle long messages
- can reject unauthorized sender

## 20. Implementation Plan

### Phase 0: Spike

- Create minimal TypeScript service.
- Connect to existing OpenCode server using `@opencode-ai/sdk`.
- Compare direct SDK usage with `@liontree/opencode-agent-sdk` for
  session/event normalization and choose the wrapper strategy.
- Hard-code one Telegram bot and one OpenCode target.
- Send Telegram text to OpenCode and return final response.

Success: a Telegram DM can ask OpenCode to inspect this repository and
receive an answer.

### Phase 1: MVP Gateway

- Add config loader.
- Add SQLite persistence.
- Add session binding table.
- Add profile table with one default profile.
- Add `/status`, `/new`, `/stop`, `/sessions`, `/use-session`,
  `/profiles`, and `/profile`.
- Add structured logs and health endpoint.
- Add simple allowlist.

Success: gateway survives restart and preserves chat → OpenCode
session mapping, with explicit profile selection through one bot.

### Phase 2: Operational UX

- Add async prompt + event observation.
- Add progress messages.
- Add interactive permission request routing with Telegram buttons and
  a text fallback.
- Add debounce.
- Add `/agent` and `/model`.

Success: long-running OpenCode tasks are observable and controllable
from chat.

### Phase 3: Multi-Channel

- Extract channel adapter interface fully.
- Add Slack.
- Add Discord.
- Add durable delivery queue.

Success: same OpenCode runtime can be reached from multiple chat
surfaces with consistent session semantics.

### Phase 4: Multi-Target

- Add named OpenCode targets.
- Add managed `opencode serve` process mode.
- Add `/bind` and `/unbind`.
- Add target health/restart handling.
- Add richer profile defaults for target, agent, model, verbosity, and
  command policy.

Success: different chats can route to different workspaces/OpenCode
configs and profiles.

### Phase 5: Automation and Interactive Tools

- Add webhook HTTP ingress.
- Add transformer interface and initial examples for GitHub/Linear-style
  payloads.
- Add cron scheduler and dispatch path.
- Add explicit cron session selector strategies and delivery target
  routing.
- Expose cron management as an optional OpenCode tool/MCP server.
- Add optional question tool bridge for messaging-native human
  clarification.

Success: non-chat events and schedules can enter OpenCode through the
same control plane, and OpenCode can ask the human questions in a
client-native way.

### Phase 6: Multi-Profile Deployment Modes

- Add automatic profile selection by channel/conversation binding.
- Add support for multiple platform bot accounts mapped to different
  profiles.
- Add profile-specific avatars/display metadata where platforms expose
  it.
- Add profile policy validation so each profile's allowed targets,
  commands, and approval scopes are explicit.

Success: the same gateway can operate as one switchable bot, one bot
with binding-selected profiles, or multiple platform-native bots backed
by shared OpenCode-first infrastructure.

## 21. Open Questions

1. Which channel should be first: Telegram only, or Telegram + Slack
   immediately?
2. Should managed OpenCode server mode be in MVP, or should attach
   mode be mandatory first?
3. How much OpenCode event detail is available and stable enough for
   progress rendering?
4. What exact OpenCode API shape should be used for permission request
   responses?
5. Should `/agent` switch OpenCode primary agent for the session or
   only set per-turn agent override?
6. Should conversation bindings be per sender, per channel/thread, or
   configurable by chat type?
7. How should file attachments be represented when OpenCode does not
   support a platform media type directly?
8. Should the first implementation depend on `@liontree/opencode-agent-sdk`
   or keep a local wrapper directly on `@opencode-ai/sdk`?
9. What transformer API is safe enough for webhook customization without
   turning the gateway into an arbitrary code execution server by
   default?
10. Should cron be implemented as an internal scheduler only, or exposed
    through MCP from day one?
11. What is the cleanest way to override or bridge OpenCode's `question`
    tool without forking user OpenCode configurations?
12. Which messaging clients support button-based permission approvals
    well enough for MVP, and what is the fallback UX elsewhere?
13. How should profile switching interact with existing session
    bindings: should switching profiles automatically select that
    profile's last active session, prompt for a session, or create a new
    one by default?
14. Which profile deployment mode should be second after explicit
    switching: binding-selected profiles or one bot account per profile?
15. How much profile identity should be mirrored into platform-native
    bot metadata versus shown only in status/progress messages?

## 22. Success Criteria

The project is successful when:

- A user can message Telegram/Slack/Discord and interact with OpenCode
  naturally.
- OpenCode remains the only agentic decision-maker for normal
  natural-language work.
- Gateway commands are explicit, predictable, and safe.
- Sessions persist across gateway restarts and can be listed, selected,
  resumed, reset, and rebound intentionally from chat.
- The active profile is visible and switchable, with profile defaults
  cleanly influencing target, agent, model, session selection, and
  delivery behavior without adding a second agentic decision-maker.
- Long-running OpenCode work can be monitored, stopped, and approved via
  native messaging-client interactions from chat.
- Webhook and cron-triggered work enters the same OpenCode-first
  dispatch path as human chat messages.
- OpenCode can ask human clarification questions through a
  messaging-native interaction when the optional question bridge is
  enabled.
- Adding a new channel does not require touching OpenCode runtime
  code.
- Replacing or upgrading OpenCode SDK usage does not require touching
  channel adapter code.

## 23. Architectural Stance

This should feel like **OpenCode with a messaging front door**, not
OpenClaw-lite, Hermes-lite, or a new agent OS.

If a feature requires the gateway to interpret intent, plan work, or
spawn specialist agents using its own judgment, it probably belongs in
OpenCode instead.
