import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { RunRecord } from "../types.ts";

interface RunRow {
  id: string;
  binding_id: string;
  target_id: string | null;
  opencode_session_id: string;
  opencode_message_id: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface CreateRunInput {
  bindingId: string;
  targetId?: string;
  opencodeSessionId: string;
  opencodeMessageId?: string;
  status?: string;
}

export interface FinishRunInput {
  id: string;
  status: string;
  opencodeMessageId?: string;
  error?: string;
}

export interface FinishActiveByTargetInput {
  targetId: string;
  status: string;
  error?: string;
}

export interface RunRepository {
  create(input: CreateRunInput): RunRecord;
  getById(id: string): RunRecord | undefined;
  getActiveByBindingId(bindingId: string): RunRecord | undefined;
  listActive(): RunRecord[];
  listActiveByTargetId(targetId: string): RunRecord[];
  setOpenCodeMessageId(id: string, opencodeMessageId: string): RunRecord | undefined;
  finish(input: FinishRunInput): RunRecord | undefined;
  finishIfActive(input: FinishRunInput): RunRecord | undefined;
  finishActiveByTargetId(input: FinishActiveByTargetInput): RunRecord[];
  finishAllActive(input: Omit<FinishRunInput, "id" | "opencodeMessageId">): RunRecord[];
  markAborted(id: string): RunRecord | undefined;
}

export function createRunRepository(
  db: Database,
  options: { now?: () => Date; createId?: () => string } = {},
): RunRepository {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  return {
    create(input): RunRecord {
      const row = db
        .query(
          `INSERT INTO runs (
            id, binding_id, target_id, opencode_session_id, opencode_message_id, status, started_at, finished_at, error
          ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL)
          RETURNING *`,
        )
        .get(
          createId(),
          input.bindingId,
          input.targetId ?? null,
          input.opencodeSessionId,
          input.opencodeMessageId ?? null,
          input.status ?? "active",
          now().toISOString(),
        ) as RunRow;

      return mapRunRow(row);
    },

    getById(id): RunRecord | undefined {
      const row = db.query("SELECT * FROM runs WHERE id = ?").get(id) as RunRow | null;

      return row ? mapRunRow(row) : undefined;
    },

    getActiveByBindingId(bindingId): RunRecord | undefined {
      const row = db
        .query("SELECT * FROM runs WHERE binding_id = ? AND status = 'active'")
        .get(bindingId) as RunRow | null;

      return row ? mapRunRow(row) : undefined;
    },

    listActive(): RunRecord[] {
      const rows = db
        .query("SELECT * FROM runs WHERE status = 'active' ORDER BY started_at, id")
        .all() as RunRow[];

      return rows.map(mapRunRow);
    },

    listActiveByTargetId(targetId): RunRecord[] {
      const rows = db
        .query("SELECT * FROM runs WHERE target_id = ? AND status = 'active' ORDER BY started_at, id")
        .all(targetId) as RunRow[];

      return rows.map(mapRunRow);
    },

    setOpenCodeMessageId(id, opencodeMessageId): RunRecord | undefined {
      const row = db
        .query(
          `UPDATE runs SET
            opencode_message_id = ?
          WHERE id = ?
          RETURNING *`,
        )
        .get(opencodeMessageId, id) as RunRow | null;

      return row ? mapRunRow(row) : undefined;
    },

    finish(input): RunRecord | undefined {
      const row = db
        .query(
          `UPDATE runs SET
            status = ?,
            opencode_message_id = COALESCE(?, opencode_message_id),
            error = ?,
            finished_at = ?
          WHERE id = ?
          RETURNING *`,
        )
        .get(
          input.status,
          input.opencodeMessageId ?? null,
          input.error ?? null,
          now().toISOString(),
          input.id,
        ) as RunRow | null;

      return row ? mapRunRow(row) : undefined;
    },

    finishIfActive(input): RunRecord | undefined {
      const row = db
        .query(
          `UPDATE runs SET
            status = ?,
            opencode_message_id = COALESCE(?, opencode_message_id),
            error = ?,
            finished_at = ?
          WHERE id = ? AND status = 'active'
          RETURNING *`,
        )
        .get(
          input.status,
          input.opencodeMessageId ?? null,
          input.error ?? null,
          now().toISOString(),
          input.id,
        ) as RunRow | null;

      return row ? mapRunRow(row) : undefined;
    },

    finishActiveByTargetId(input): RunRecord[] {
      const rows = db
        .query(
          `UPDATE runs SET
            status = ?,
            error = ?,
            finished_at = ?
          WHERE target_id = ? AND status = 'active'
          RETURNING *`,
        )
        .all(input.status, input.error ?? null, now().toISOString(), input.targetId) as RunRow[];

      return rows.map(mapRunRow);
    },

    finishAllActive(input): RunRecord[] {
      const rows = db
        .query(
          `UPDATE runs SET
            status = ?,
            error = ?,
            finished_at = ?
          WHERE status = 'active'
          RETURNING *`,
        )
        .all(input.status, input.error ?? null, now().toISOString()) as RunRow[];

      return rows.map(mapRunRow);
    },

    markAborted(id): RunRecord | undefined {
      return this.finish({ id, status: "aborted" });
    },
  };
}

function mapRunRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    bindingId: row.binding_id,
    targetId: nullableToUndefined(row.target_id),
    opencodeSessionId: row.opencode_session_id,
    opencodeMessageId: nullableToUndefined(row.opencode_message_id),
    status: row.status,
    startedAt: row.started_at,
    finishedAt: nullableToUndefined(row.finished_at),
    error: nullableToUndefined(row.error),
  };
}

function nullableToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}
