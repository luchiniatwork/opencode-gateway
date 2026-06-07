import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { AccessRole, AccessRuleSeed } from "../../config/schema.ts";
import type { AccessRuleRecord } from "../types.ts";

interface AccessRuleRow {
  id: string;
  channel: string;
  account_id: string;
  sender_id: string;
  role: AccessRole;
  created_at: string;
  updated_at: string;
}

export interface AccessRuleRepository {
  upsertSeed(rule: AccessRuleSeed): AccessRuleRecord;
  getRole(input: { channel: string; accountId: string; senderId: string }): AccessRole | undefined;
}

export function createAccessRuleRepository(
  db: Database,
  options: { now?: () => Date; createId?: () => string } = {},
): AccessRuleRepository {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  return {
    upsertSeed(rule): AccessRuleRecord {
      const timestamp = now().toISOString();
      const row = db
        .query(
          `INSERT INTO access_rules (id, channel, account_id, sender_id, role, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(channel, account_id, sender_id) DO UPDATE SET
            role = excluded.role,
            updated_at = excluded.updated_at
          RETURNING *`,
        )
        .get(createId(), rule.channel, rule.accountId, rule.senderId, rule.role, timestamp, timestamp) as AccessRuleRow;

      return mapAccessRuleRow(row);
    },

    getRole(input): AccessRole | undefined {
      const row = db
        .query(
          `SELECT role FROM access_rules
          WHERE channel = ? AND account_id = ? AND sender_id = ?`,
        )
        .get(input.channel, input.accountId, input.senderId) as { role: AccessRole } | null;

      return row?.role;
    },
  };
}

function mapAccessRuleRow(row: AccessRuleRow): AccessRuleRecord {
  return {
    id: row.id,
    channel: row.channel,
    accountId: row.account_id,
    senderId: row.sender_id,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
