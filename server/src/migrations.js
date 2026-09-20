const migrations = [
  {
    version: 1,
    up: (database) => database.exec(`
      CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY,
        join_code TEXT NOT NULL,
        room_mode TEXT NOT NULL CHECK(room_mode IN ('friends', 'private')),
        revision INTEGER NOT NULL DEFAULT 0,
        host_player_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX sessions_join_code_index ON sessions(join_code);

      CREATE TABLE players (
        player_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        display_name TEXT NOT NULL,
        connected INTEGER NOT NULL DEFAULT 0 CHECK(connected IN (0, 1)),
        last_seen_at TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 0,
        tr INTEGER NOT NULL DEFAULT 20,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
      );

      CREATE INDEX players_session_id_index ON players(session_id);

      CREATE TABLE player_resources (
        player_id TEXT NOT NULL,
        resource_id TEXT NOT NULL CHECK(resource_id IN ('MC', 'Steel', 'Titanium', 'Plants', 'Energy', 'Heat')),
        amount INTEGER NOT NULL DEFAULT 0,
        production INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY(player_id, resource_id),
        FOREIGN KEY(player_id) REFERENCES players(player_id) ON DELETE CASCADE
      );

      CREATE TABLE client_players (
        session_id TEXT NOT NULL,
        client_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        PRIMARY KEY(session_id, client_id),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        FOREIGN KEY(player_id) REFERENCES players(player_id) ON DELETE CASCADE
      );

      CREATE INDEX client_players_player_id_index ON client_players(player_id);

      CREATE TABLE player_credentials (
        player_id TEXT PRIMARY KEY,
        resume_token_hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(player_id) REFERENCES players(player_id) ON DELETE CASCADE
      );

      CREATE TABLE processed_actions (
        session_id TEXT NOT NULL,
        action_id TEXT NOT NULL,
        player_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY(session_id, action_id),
        FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
        FOREIGN KEY(player_id) REFERENCES players(player_id) ON DELETE CASCADE
      );

      CREATE INDEX processed_actions_session_created_index
        ON processed_actions(session_id, created_at DESC);

      CREATE TABLE server_metadata (
        server_id TEXT PRIMARY KEY,
        server_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `),
  },
];

export function runMigrations(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    database.prepare("SELECT version FROM schema_migrations").all().map(({ version }) => version),
  );
  const apply = database.transaction((migration) => {
    migration.up(database);
    database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(migration.version, new Date().toISOString());
  });

  for (const migration of migrations) {
    if (!applied.has(migration.version)) apply(migration);
  }
}

export const latestSchemaVersion = migrations.at(-1)?.version ?? 0;
