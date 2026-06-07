import type { Database } from "bun:sqlite";

import type { GatewayTargetConfig } from "../../config/schema.ts";
import type { TargetRecord } from "../types.ts";

interface TargetRow {
  id: string;
  name: string;
  mode: TargetRecord["mode"];
  server_url: string | null;
  workdir: string | null;
  config_dir: string | null;
  default_agent: string | null;
  default_model: string | null;
  created_at: string;
  updated_at: string;
}

export interface TargetRepository {
  upsertSeed(target: GatewayTargetConfig): TargetRecord;
  getById(id: string): TargetRecord | undefined;
  list(): TargetRecord[];
}

export function createTargetRepository(
  db: Database,
  now: () => Date = () => new Date(),
): TargetRepository {
  return {
    upsertSeed(target): TargetRecord {
      const timestamp = now().toISOString();
      const row = db
        .query(
          `INSERT INTO targets (
            id, name, mode, server_url, workdir, config_dir, default_agent, default_model, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            mode = excluded.mode,
            server_url = excluded.server_url,
            workdir = excluded.workdir,
            config_dir = excluded.config_dir,
            default_agent = excluded.default_agent,
            default_model = excluded.default_model,
            updated_at = excluded.updated_at
          RETURNING *`,
        )
        .get(
          target.id,
          target.name,
          target.mode,
          target.serverUrl ?? null,
          target.workdir ?? null,
          target.configDir ?? null,
          target.defaultAgent ?? null,
          target.defaultModel ?? null,
          timestamp,
          timestamp,
        ) as TargetRow;

      return mapTargetRow(row);
    },

    getById(id): TargetRecord | undefined {
      const row = db.query("SELECT * FROM targets WHERE id = ?").get(id) as TargetRow | null;
      return row ? mapTargetRow(row) : undefined;
    },

    list(): TargetRecord[] {
      const rows = db.query("SELECT * FROM targets ORDER BY id").all() as TargetRow[];
      return rows.map(mapTargetRow);
    },
  };
}

function mapTargetRow(row: TargetRow): TargetRecord {
  return {
    id: row.id,
    name: row.name,
    mode: row.mode,
    serverUrl: nullableToUndefined(row.server_url),
    workdir: nullableToUndefined(row.workdir),
    configDir: nullableToUndefined(row.config_dir),
    defaultAgent: nullableToUndefined(row.default_agent),
    defaultModel: nullableToUndefined(row.default_model),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nullableToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}
