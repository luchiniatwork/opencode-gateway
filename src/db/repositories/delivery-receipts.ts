import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { DeliveryReceiptRecord } from "../types.ts";

interface DeliveryReceiptRow {
  id: string;
  run_id: string | null;
  channel: DeliveryReceiptRecord["channel"];
  account_id: string;
  conversation_key: DeliveryReceiptRecord["conversationKey"];
  platform_message_id: string;
  kind: DeliveryReceiptRecord["kind"];
  created_at: string;
  updated_at: string;
}

export interface CreateDeliveryReceiptInput {
  runId?: string;
  channel: DeliveryReceiptRecord["channel"];
  accountId: string;
  conversationKey: DeliveryReceiptRecord["conversationKey"];
  platformMessageId: string;
  kind: DeliveryReceiptRecord["kind"];
}

export interface DeliveryReceiptRepository {
  create(input: CreateDeliveryReceiptInput): DeliveryReceiptRecord;
  listByRunId(runId: string): DeliveryReceiptRecord[];
  listByConversationKey(conversationKey: string): DeliveryReceiptRecord[];
}

export function createDeliveryReceiptRepository(
  db: Database,
  options: { now?: () => Date; createId?: () => string } = {},
): DeliveryReceiptRepository {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  return {
    create(input): DeliveryReceiptRecord {
      const timestamp = now().toISOString();
      const row = db
        .query(
          `INSERT INTO delivery_receipts (
            id, run_id, channel, account_id, conversation_key, platform_message_id, kind, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING *`,
        )
        .get(
          createId(),
          input.runId ?? null,
          input.channel,
          input.accountId,
          input.conversationKey,
          input.platformMessageId,
          input.kind,
          timestamp,
          timestamp,
        ) as DeliveryReceiptRow;

      return mapDeliveryReceiptRow(row);
    },

    listByRunId(runId): DeliveryReceiptRecord[] {
      const rows = db
        .query("SELECT * FROM delivery_receipts WHERE run_id = ? ORDER BY created_at, id")
        .all(runId) as DeliveryReceiptRow[];

      return rows.map(mapDeliveryReceiptRow);
    },

    listByConversationKey(conversationKey): DeliveryReceiptRecord[] {
      const rows = db
        .query("SELECT * FROM delivery_receipts WHERE conversation_key = ? ORDER BY created_at, id")
        .all(conversationKey) as DeliveryReceiptRow[];

      return rows.map(mapDeliveryReceiptRow);
    },
  };
}

function mapDeliveryReceiptRow(row: DeliveryReceiptRow): DeliveryReceiptRecord {
  return {
    id: row.id,
    runId: nullableToUndefined(row.run_id),
    channel: row.channel,
    accountId: row.account_id,
    conversationKey: row.conversation_key,
    platformMessageId: row.platform_message_id,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nullableToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}
