import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { BusyMode, Verbosity } from "../../config/schema.ts";
import type { ConversationBindingRecord } from "../types.ts";

interface ConversationBindingRow {
  id: string;
  conversation_key: string;
  channel: string;
  account_id: string;
  profile_id: string;
  target_id: string;
  opencode_session_id: string;
  session_name: string | null;
  agent: string | null;
  model: string | null;
  busy_mode: BusyMode;
  verbosity: Verbosity;
  created_at: string;
  updated_at: string;
}

export interface UpsertConversationBindingInput {
  conversationKey: string;
  channel: string;
  accountId: string;
  profileId: string;
  targetId: string;
  opencodeSessionId: string;
  sessionName?: string;
  agent?: string;
  model?: string;
  busyMode: BusyMode;
  verbosity: Verbosity;
}

export interface UpdateBindingSessionInput {
  conversationKey: string;
  targetId: string;
  opencodeSessionId: string;
  sessionName?: string;
}

export interface UpdateBindingProfileInput {
  conversationKey: string;
  profileId: string;
  targetId: string;
  opencodeSessionId: string;
  sessionName?: string;
  busyMode: BusyMode;
  verbosity: Verbosity;
}

export interface UpdateBindingAgentInput {
  conversationKey: string;
  agent: string | null;
}

export interface UpdateBindingModelInput {
  conversationKey: string;
  model: string | null;
}

export interface ConversationBindingRepository {
  getById(id: string): ConversationBindingRecord | undefined;
  getByConversationKey(conversationKey: string): ConversationBindingRecord | undefined;
  upsert(input: UpsertConversationBindingInput): ConversationBindingRecord;
  updateSession(input: UpdateBindingSessionInput): ConversationBindingRecord | undefined;
  updateProfile(input: UpdateBindingProfileInput): ConversationBindingRecord | undefined;
  updateAgent(input: UpdateBindingAgentInput): ConversationBindingRecord | undefined;
  updateModel(input: UpdateBindingModelInput): ConversationBindingRecord | undefined;
}

export function createConversationBindingRepository(
  db: Database,
  options: { now?: () => Date; createId?: () => string } = {},
): ConversationBindingRepository {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  return {
    getById(id): ConversationBindingRecord | undefined {
      const row = db.query("SELECT * FROM conversation_bindings WHERE id = ?").get(id) as ConversationBindingRow | null;

      return row ? mapConversationBindingRow(row) : undefined;
    },

    getByConversationKey(conversationKey): ConversationBindingRecord | undefined {
      const row = db
        .query("SELECT * FROM conversation_bindings WHERE conversation_key = ?")
        .get(conversationKey) as ConversationBindingRow | null;

      return row ? mapConversationBindingRow(row) : undefined;
    },

    upsert(input): ConversationBindingRecord {
      const timestamp = now().toISOString();
      const row = db
        .query(
          `INSERT INTO conversation_bindings (
            id, conversation_key, channel, account_id, profile_id, target_id, opencode_session_id,
            session_name, agent, model, busy_mode, verbosity, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(conversation_key) DO UPDATE SET
            channel = excluded.channel,
            account_id = excluded.account_id,
            profile_id = excluded.profile_id,
            target_id = excluded.target_id,
            opencode_session_id = excluded.opencode_session_id,
            session_name = excluded.session_name,
            agent = excluded.agent,
            model = excluded.model,
            busy_mode = excluded.busy_mode,
            verbosity = excluded.verbosity,
            updated_at = excluded.updated_at
          RETURNING *`,
        )
        .get(
          createId(),
          input.conversationKey,
          input.channel,
          input.accountId,
          input.profileId,
          input.targetId,
          input.opencodeSessionId,
          input.sessionName ?? null,
          input.agent ?? null,
          input.model ?? null,
          input.busyMode,
          input.verbosity,
          timestamp,
          timestamp,
        ) as ConversationBindingRow;

      return mapConversationBindingRow(row);
    },

    updateSession(input): ConversationBindingRecord | undefined {
      const row = db
        .query(
          `UPDATE conversation_bindings SET
            target_id = ?,
            opencode_session_id = ?,
            session_name = ?,
            updated_at = ?
          WHERE conversation_key = ?
          RETURNING *`,
        )
        .get(
          input.targetId,
          input.opencodeSessionId,
          input.sessionName ?? null,
          now().toISOString(),
          input.conversationKey,
        ) as ConversationBindingRow | null;

      return row ? mapConversationBindingRow(row) : undefined;
    },

    updateProfile(input): ConversationBindingRecord | undefined {
      const row = db
        .query(
          `UPDATE conversation_bindings SET
            profile_id = ?,
            target_id = ?,
            opencode_session_id = ?,
            session_name = ?,
            busy_mode = ?,
            verbosity = ?,
            updated_at = ?
          WHERE conversation_key = ?
          RETURNING *`,
        )
        .get(
          input.profileId,
          input.targetId,
          input.opencodeSessionId,
          input.sessionName ?? null,
          input.busyMode,
          input.verbosity,
          now().toISOString(),
          input.conversationKey,
        ) as ConversationBindingRow | null;

      return row ? mapConversationBindingRow(row) : undefined;
    },

    updateAgent(input): ConversationBindingRecord | undefined {
      const row = db
        .query(
          `UPDATE conversation_bindings SET
            agent = ?,
            updated_at = ?
          WHERE conversation_key = ?
          RETURNING *`,
        )
        .get(input.agent, now().toISOString(), input.conversationKey) as ConversationBindingRow | null;

      return row ? mapConversationBindingRow(row) : undefined;
    },

    updateModel(input): ConversationBindingRecord | undefined {
      const row = db
        .query(
          `UPDATE conversation_bindings SET
            model = ?,
            updated_at = ?
          WHERE conversation_key = ?
          RETURNING *`,
        )
        .get(input.model, now().toISOString(), input.conversationKey) as ConversationBindingRow | null;

      return row ? mapConversationBindingRow(row) : undefined;
    },
  };
}

function mapConversationBindingRow(row: ConversationBindingRow): ConversationBindingRecord {
  return {
    id: row.id,
    conversationKey: row.conversation_key,
    channel: row.channel,
    accountId: row.account_id,
    profileId: row.profile_id,
    targetId: row.target_id,
    opencodeSessionId: row.opencode_session_id,
    sessionName: nullableToUndefined(row.session_name),
    agent: nullableToUndefined(row.agent),
    model: nullableToUndefined(row.model),
    busyMode: row.busy_mode,
    verbosity: row.verbosity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nullableToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}
