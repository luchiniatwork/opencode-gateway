import type { Database } from "bun:sqlite";

export interface Migration {
  id: string;
  statements: string[];
}

export const migrations: Migration[] = [
  {
    id: "001_initial_schema",
    statements: [
      `CREATE TABLE IF NOT EXISTS targets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        mode TEXT NOT NULL CHECK (mode IN ('attach', 'managed')),
        server_url TEXT,
        workdir TEXT,
        config_dir TEXT,
        default_agent TEXT,
        default_model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        description TEXT,
        avatar TEXT,
        default_target_id TEXT NOT NULL REFERENCES targets(id),
        default_agent TEXT,
        default_model TEXT,
        default_config_dir TEXT,
        access_policy_id TEXT,
        command_policy_id TEXT,
        default_busy_mode TEXT CHECK (default_busy_mode IS NULL OR default_busy_mode IN ('queue', 'interrupt', 'reject', 'steer')),
        default_verbosity TEXT CHECK (default_verbosity IS NULL OR default_verbosity IN ('off', 'compact', 'tools', 'verbose')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS conversation_bindings (
        id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL,
        profile_id TEXT NOT NULL REFERENCES profiles(id),
        target_id TEXT NOT NULL REFERENCES targets(id),
        opencode_session_id TEXT NOT NULL,
        session_name TEXT,
        agent TEXT,
        model TEXT,
        busy_mode TEXT NOT NULL DEFAULT 'queue' CHECK (busy_mode IN ('queue', 'interrupt', 'reject', 'steer')),
        verbosity TEXT NOT NULL DEFAULT 'compact' CHECK (verbosity IN ('off', 'compact', 'tools', 'verbose')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        binding_id TEXT NOT NULL REFERENCES conversation_bindings(id),
        opencode_session_id TEXT NOT NULL,
        opencode_message_id TEXT,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        error TEXT
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_binding
        ON runs(binding_id)
        WHERE status = 'active'`,
      `CREATE TABLE IF NOT EXISTS access_rules (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'user', 'blocked')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(channel, account_id, sender_id)
      )`,
    ],
  },
  {
    id: "002_phase_2_operational_ux",
    statements: [
      `CREATE TABLE IF NOT EXISTS pending_permissions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES runs(id),
        opencode_permission_id TEXT NOT NULL,
        summary TEXT NOT NULL,
        details_json TEXT,
        action_message_receipt_id TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        resolved_at TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS pending_permissions_run_id
        ON pending_permissions(run_id)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS pending_permissions_opencode_permission_id
        ON pending_permissions(opencode_permission_id)`,
      `CREATE TABLE IF NOT EXISTS delivery_receipts (
        id TEXT PRIMARY KEY,
        run_id TEXT REFERENCES runs(id),
        channel TEXT NOT NULL,
        account_id TEXT NOT NULL,
        conversation_key TEXT NOT NULL,
        platform_message_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('ack', 'progress', 'final', 'error', 'status')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS delivery_receipts_run_id
        ON delivery_receipts(run_id)`,
      `CREATE INDEX IF NOT EXISTS delivery_receipts_conversation_key
        ON delivery_receipts(conversation_key)`,
    ],
  },
  {
    id: "003_run_target_snapshot",
    statements: [
      `ALTER TABLE runs ADD COLUMN target_id TEXT`,
    ],
  },
  {
    id: "004_phase_4_target_binding_source",
    statements: [
      `ALTER TABLE conversation_bindings
        ADD COLUMN target_source TEXT NOT NULL DEFAULT 'profile_default'
        CHECK (target_source IN ('profile_default', 'explicit_bind'))`,
    ],
  },
  {
    id: "005_phase_4_pending_permission_scope",
    statements: [
      `DROP INDEX IF EXISTS pending_permissions_opencode_permission_id`,
      `CREATE UNIQUE INDEX IF NOT EXISTS pending_permissions_run_opencode_permission_id
        ON pending_permissions(run_id, opencode_permission_id)`,
      `CREATE INDEX IF NOT EXISTS pending_permissions_opencode_permission_id_lookup
        ON pending_permissions(opencode_permission_id)`,
    ],
  },
];

export function runMigrations(db: Database, now: () => Date = () => new Date()): void {
  db.run(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const runPending = db.transaction(() => {
    for (const migration of migrations) {
      const applied = db.query("SELECT id FROM schema_migrations WHERE id = ?").get(migration.id);

      if (applied) continue;

      for (const statement of migration.statements) {
        db.run(statement);
      }

      db.query("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(
        migration.id,
        now().toISOString(),
      );
    }
  });

  runPending();
}
