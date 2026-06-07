import type { Database } from "bun:sqlite";

import type { GatewayProfileConfig } from "../../config/schema.ts";
import type { ProfileRecord } from "../types.ts";

interface ProfileRow {
  id: string;
  display_name: string;
  description: string | null;
  avatar: string | null;
  default_target_id: string;
  default_agent: string | null;
  default_model: string | null;
  default_config_dir: string | null;
  access_policy_id: string | null;
  command_policy_id: string | null;
  default_busy_mode: ProfileRecord["defaultBusyMode"] | null;
  default_verbosity: ProfileRecord["defaultVerbosity"] | null;
  created_at: string;
  updated_at: string;
}

export interface ProfileRepository {
  upsertSeed(profile: GatewayProfileConfig): ProfileRecord;
  getById(id: string): ProfileRecord | undefined;
  list(): ProfileRecord[];
}

export function createProfileRepository(
  db: Database,
  now: () => Date = () => new Date(),
): ProfileRepository {
  return {
    upsertSeed(profile): ProfileRecord {
      const timestamp = now().toISOString();
      const row = db
        .query(
          `INSERT INTO profiles (
            id, display_name, description, avatar, default_target_id, default_agent, default_model,
            default_config_dir, access_policy_id, command_policy_id, default_busy_mode, default_verbosity,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            display_name = excluded.display_name,
            description = excluded.description,
            avatar = excluded.avatar,
            default_target_id = excluded.default_target_id,
            default_agent = excluded.default_agent,
            default_model = excluded.default_model,
            default_config_dir = excluded.default_config_dir,
            access_policy_id = excluded.access_policy_id,
            command_policy_id = excluded.command_policy_id,
            default_busy_mode = excluded.default_busy_mode,
            default_verbosity = excluded.default_verbosity,
            updated_at = excluded.updated_at
          RETURNING *`,
        )
        .get(
          profile.id,
          profile.displayName,
          profile.description ?? null,
          profile.avatar ?? null,
          profile.defaultTargetId,
          profile.defaultAgent ?? null,
          profile.defaultModel ?? null,
          profile.defaultConfigDir ?? null,
          profile.accessPolicyId ?? null,
          profile.commandPolicyId ?? null,
          profile.defaults.busyMode ?? null,
          profile.defaults.verbosity ?? null,
          timestamp,
          timestamp,
        ) as ProfileRow;

      return mapProfileRow(row);
    },

    getById(id): ProfileRecord | undefined {
      const row = db.query("SELECT * FROM profiles WHERE id = ?").get(id) as ProfileRow | null;
      return row ? mapProfileRow(row) : undefined;
    },

    list(): ProfileRecord[] {
      const rows = db.query("SELECT * FROM profiles ORDER BY id").all() as ProfileRow[];
      return rows.map(mapProfileRow);
    },
  };
}

function mapProfileRow(row: ProfileRow): ProfileRecord {
  return {
    id: row.id,
    displayName: row.display_name,
    description: nullableToUndefined(row.description),
    avatar: nullableToUndefined(row.avatar),
    defaultTargetId: row.default_target_id,
    defaultAgent: nullableToUndefined(row.default_agent),
    defaultModel: nullableToUndefined(row.default_model),
    defaultConfigDir: nullableToUndefined(row.default_config_dir),
    accessPolicyId: nullableToUndefined(row.access_policy_id),
    commandPolicyId: nullableToUndefined(row.command_policy_id),
    defaultBusyMode: nullableToUndefined(row.default_busy_mode),
    defaultVerbosity: nullableToUndefined(row.default_verbosity),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function nullableToUndefined<T>(value: T | null): T | undefined {
  return value === null ? undefined : value;
}
