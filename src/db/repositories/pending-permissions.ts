import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { PendingPermissionRecord, PendingPermissionStatus } from "../types.ts";

interface PendingPermissionRow {
  id: string;
  run_id: string;
  opencode_permission_id: string;
  summary: string;
  details_json: string | null;
  action_message_receipt_id: string | null;
  status: PendingPermissionStatus;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
}

export interface CreatePendingPermissionInput {
  runId: string;
  opencodePermissionId: string;
  summary: string;
  details?: unknown;
  actionMessageReceiptId?: string;
  expiresAt: string;
  status?: PendingPermissionStatus;
}

export interface ResolvePendingPermissionInput {
  id: string;
  status: Exclude<PendingPermissionStatus, "pending">;
  actionMessageReceiptId?: string;
}

export interface UpdatePendingPermissionActionReceiptInput {
  id: string;
  actionMessageReceiptId: string;
}

export interface PendingPermissionRepository {
  create(input: CreatePendingPermissionInput): PendingPermissionRecord;
  upsertByOpenCodePermissionId(input: CreatePendingPermissionInput): PendingPermissionRecord;
  getById(id: string): PendingPermissionRecord | undefined;
  getByOpenCodePermissionId(opencodePermissionId: string): PendingPermissionRecord | undefined;
  listPending(): PendingPermissionRecord[];
  listPendingByRunId(runId: string): PendingPermissionRecord[];
  setActionMessageReceiptId(input: UpdatePendingPermissionActionReceiptInput): PendingPermissionRecord | undefined;
  resolve(input: ResolvePendingPermissionInput): PendingPermissionRecord | undefined;
}

export function createPendingPermissionRepository(
  db: Database,
  options: { now?: () => Date; createId?: () => string } = {},
): PendingPermissionRepository {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  return {
    create(input): PendingPermissionRecord {
      const row = db
        .query(
          `INSERT INTO pending_permissions (
            id, run_id, opencode_permission_id, summary, details_json, action_message_receipt_id,
            status, created_at, expires_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          RETURNING *`,
        )
        .get(
          createId(),
          input.runId,
          input.opencodePermissionId,
          input.summary,
          input.details === undefined ? null : JSON.stringify(input.details),
          input.actionMessageReceiptId ?? null,
          input.status ?? "pending",
          now().toISOString(),
          input.expiresAt,
        ) as PendingPermissionRow;

      return mapPendingPermissionRow(row);
    },

    upsertByOpenCodePermissionId(input): PendingPermissionRecord {
      const row = db
        .query(
          `INSERT INTO pending_permissions (
            id, run_id, opencode_permission_id, summary, details_json, action_message_receipt_id,
            status, created_at, expires_at, resolved_at
          ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
          ON CONFLICT(opencode_permission_id) DO UPDATE SET
            run_id = excluded.run_id,
            summary = excluded.summary,
            details_json = excluded.details_json,
            action_message_receipt_id = NULL,
            status = excluded.status,
            created_at = excluded.created_at,
            expires_at = excluded.expires_at,
            resolved_at = NULL
          RETURNING *`,
        )
        .get(
          createId(),
          input.runId,
          input.opencodePermissionId,
          input.summary,
          input.details === undefined ? null : JSON.stringify(input.details),
          input.status ?? "pending",
          now().toISOString(),
          input.expiresAt,
        ) as PendingPermissionRow;

      return mapPendingPermissionRow(row);
    },

    getById(id): PendingPermissionRecord | undefined {
      const row = db.query("SELECT * FROM pending_permissions WHERE id = ?").get(id) as PendingPermissionRow | null;

      return row ? mapPendingPermissionRow(row) : undefined;
    },

    getByOpenCodePermissionId(opencodePermissionId): PendingPermissionRecord | undefined {
      const row = db
        .query("SELECT * FROM pending_permissions WHERE opencode_permission_id = ?")
        .get(opencodePermissionId) as PendingPermissionRow | null;

      return row ? mapPendingPermissionRow(row) : undefined;
    },

    listPending(): PendingPermissionRecord[] {
      const rows = db
        .query("SELECT * FROM pending_permissions WHERE status = 'pending' ORDER BY created_at, id")
        .all() as PendingPermissionRow[];

      return rows.map(mapPendingPermissionRow);
    },

    listPendingByRunId(runId): PendingPermissionRecord[] {
      const rows = db
        .query("SELECT * FROM pending_permissions WHERE run_id = ? AND status = 'pending' ORDER BY created_at, id")
        .all(runId) as PendingPermissionRow[];

      return rows.map(mapPendingPermissionRow);
    },

    setActionMessageReceiptId(input): PendingPermissionRecord | undefined {
      const row = db
        .query(
          `UPDATE pending_permissions SET
            action_message_receipt_id = ?
          WHERE id = ?
          RETURNING *`,
        )
        .get(input.actionMessageReceiptId, input.id) as PendingPermissionRow | null;

      return row ? mapPendingPermissionRow(row) : undefined;
    },

    resolve(input): PendingPermissionRecord | undefined {
      const row = db
        .query(
          `UPDATE pending_permissions SET
            status = ?,
            action_message_receipt_id = COALESCE(?, action_message_receipt_id),
            resolved_at = ?
          WHERE id = ?
          RETURNING *`,
        )
        .get(input.status, input.actionMessageReceiptId ?? null, now().toISOString(), input.id) as PendingPermissionRow | null;

      return row ? mapPendingPermissionRow(row) : undefined;
    },
  };
}

function mapPendingPermissionRow(row: PendingPermissionRow): PendingPermissionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    opencodePermissionId: row.opencode_permission_id,
    summary: row.summary,
    details: parseJson(row.details_json),
    actionMessageReceiptId: nullableToUndefined(row.action_message_receipt_id),
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: nullableToUndefined(row.resolved_at),
  };
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;

  return JSON.parse(value) as unknown;
}

function nullableToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}
