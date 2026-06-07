import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

import type { RunRecord } from "../types.ts";

interface RunRow {
  id: string;
  binding_id: string;
  opencode_session_id: string;
  opencode_message_id: string | null;
  status: string;
  started_at: string;
  finished_at: string | null;
  error: string | null;
}

export interface CreateRunInput {
  bindingId: string;
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

export interface RunRepository {
  create(input: CreateRunInput): RunRecord;
  getActiveByBindingId(bindingId: string): RunRecord | undefined;
  finish(input: FinishRunInput): RunRecord | undefined;
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
            id, binding_id, opencode_session_id, opencode_message_id, status, started_at, finished_at, error
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)
          RETURNING *`,
        )
        .get(
          createId(),
          input.bindingId,
          input.opencodeSessionId,
          input.opencodeMessageId ?? null,
          input.status ?? "active",
          now().toISOString(),
        ) as RunRow;

      return mapRunRow(row);
    },

    getActiveByBindingId(bindingId): RunRecord | undefined {
      const row = db
        .query("SELECT * FROM runs WHERE binding_id = ? AND status = 'active'")
        .get(bindingId) as RunRow | null;

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

    markAborted(id): RunRecord | undefined {
      return this.finish({ id, status: "aborted" });
    },
  };
}

function mapRunRow(row: RunRow): RunRecord {
  return {
    id: row.id,
    bindingId: row.binding_id,
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
