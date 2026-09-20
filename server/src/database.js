import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";

const defaultDatabasePath = fileURLToPath(new URL("../data/red-planet.sqlite3", import.meta.url));
export const DEFAULT_SERVER_NAME = "Red Planet Server";

export function resolveDatabasePath(value = process.env.DB_PATH) {
  if (!value) return defaultDatabasePath;
  if (value === ":memory:" || value.startsWith("file:")) return value;
  return isAbsolute(value) ? value : resolve(process.cwd(), value);
}

export function openDatabase({ databasePath = resolveDatabasePath(), serverName = process.env.SERVER_NAME } = {}) {
  if (databasePath !== ":memory:" && !databasePath.startsWith("file:")) {
    mkdirSync(dirname(databasePath), { recursive: true });
  }

  const database = new Database(databasePath);
  try {
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    runMigrations(database);
    database.prepare("UPDATE players SET connected = 0 WHERE connected != 0").run();

    let metadata = database.prepare("SELECT server_id AS serverId, server_name AS serverName, created_at AS createdAt FROM server_metadata LIMIT 1").get();
    if (!metadata) {
      metadata = {
        serverId: randomUUID(),
        serverName: serverName?.trim() || DEFAULT_SERVER_NAME,
        createdAt: new Date().toISOString(),
      };
      database.prepare("INSERT INTO server_metadata(server_id, server_name, created_at) VALUES (?, ?, ?)")
        .run(metadata.serverId, metadata.serverName, metadata.createdAt);
    } else if (serverName?.trim() && metadata.serverName !== serverName.trim()) {
      database.prepare("UPDATE server_metadata SET server_name = ? WHERE server_id = ?")
        .run(serverName.trim(), metadata.serverId);
      metadata = { ...metadata, serverName: serverName.trim() };
    }

    return { database, metadata, databasePath };
  } catch (failure) {
    database.close();
    throw failure;
  }
}
