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
