import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveDatabasePath } from "../src/database.js";
import { latestSchemaVersion } from "../src/migrations.js";
import { hashResumeToken, RESOURCE_IDS, SessionManager } from "../src/session-manager.js";

const databasePath = () => join(mkdtempSync(join(tmpdir(), "red-planet-")), "test.sqlite3");
const action = (manager, sessionId, playerId, type, expectedRevision, values = {}, actionId = randomUUID()) => manager.mutate({
  type,
  sessionId,
  actionId,
  expectedRevision,
  ...values,
}, playerId);

test("database initialization applies migrations, pragmas, and stable server metadata", () => {
  const path = databasePath();
  const first = new SessionManager({ databasePath: path, serverName: "Home Server" });
  const tableNames = new Set(first.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name));
  for (const table of ["schema_migrations", "sessions", "players", "player_resources", "client_players", "player_credentials", "processed_actions", "server_metadata"]) {
    assert.equal(tableNames.has(table), true, `missing ${table}`);
  }
  assert.equal(first.database.pragma("foreign_keys", { simple: true }), 1);
  assert.equal(first.database.pragma("journal_mode", { simple: true }), "wal");
  assert.equal(first.database.pragma("busy_timeout", { simple: true }), 5000);
  assert.deepEqual(first.database.prepare("SELECT version FROM schema_migrations").all(), [{ version: latestSchemaVersion }]);
  const originalId = first.serverMetadata.serverId;
  first.close();

  const second = new SessionManager({ databasePath: path, serverName: "Renamed Server" });
  assert.equal(second.serverMetadata.serverId, originalId);
  assert.equal(second.serverMetadata.serverName, "Renamed Server");
  second.close();
});

test("database paths accept filesystem paths and reject unsupported SQLite file URIs", () => {
  assert.equal(resolveDatabasePath("data/custom.sqlite3"), resolve(process.cwd(), "data/custom.sqlite3"));
  assert.throws(
    () => resolveDatabasePath("file:custom.sqlite3?mode=rwc"),
    /SQLite file: URIs are not supported/,
  );
  assert.throws(
    () => new SessionManager({ databasePath: "file:custom.sqlite3?mode=rwc" }),
    /SQLite file: URIs are not supported/,
  );
});

test("database initialization rejects schemas newer than this server binary", () => {
  const path = databasePath();
  const current = new SessionManager({ databasePath: path });
  current.database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
    .run(latestSchemaVersion + 1, new Date().toISOString());
  current.close();

  assert.throws(
    () => new SessionManager({ databasePath: path }),
    /Database schema version .* is newer than supported version/,
  );
});

test("session capacity bounds persistent database growth and is released by explicit leave", () => {
  assert.throws(() => new SessionManager({ maxSessions: 0 }), /MAX_SESSIONS must be a positive integer/);
  const manager = new SessionManager({ maxSessions: 1 });
  const first = manager.createSession({ clientId: randomUUID(), displayName: "Ada", roomMode: "friends" });
  const rejected = manager.createSession({ clientId: randomUUID(), displayName: "Ben", roomMode: "friends" });

  assert.equal(rejected.error.code, "SERVER_CAPACITY_REACHED");
  assert.equal(manager.sessions.size, 1);
  manager.leave(first.state.sessionId, first.player.playerId);
  assert.equal(manager.createSession({ clientId: randomUUID(), displayName: "Ben", roomMode: "friends" }).error, undefined);
  manager.close();
});

for (const roomMode of ["friends", "private"]) {
  test(`${roomMode} session, identity, game state, and actions survive a restart`, () => {
    const path = databasePath();
    const clientId = randomUUID();
    const first = new SessionManager({ databasePath: path });
    const created = first.createSession({ clientId, displayName: "Ada", roomMode });
    const { sessionId, joinCode, hostPlayerId } = created.state;
    action(first, sessionId, created.player.playerId, "updateResource", 0, { resourceId: "Steel", amount: 7, operation: "set" });
    action(first, sessionId, created.player.playerId, "updateProduction", 1, { resourceId: "Steel", production: 3 });
    const processedActionId = randomUUID();
    const trMessage = {
      type: "updateTR",
      sessionId,
      actionId: processedActionId,
      requestId: randomUUID(),
      protocolVersion: "v1",
      expectedRevision: 2,
      tr: 42,
    };
    assert.equal(first.mutate(trMessage, created.player.playerId).error, undefined);
    const revision = first.loadState(sessionId).revision;
    first.close();

    const second = new SessionManager({ databasePath: path });
    const persisted = second.loadState(sessionId);
    const persistedPlayer = persisted.players[0];
    assert.equal(persisted.joinCode, joinCode);
    assert.equal(persisted.hostPlayerId, hostPlayerId);
    assert.equal(persisted.revision, revision);
    assert.equal(persistedPlayer.connected, false);
    assert.equal(persistedPlayer.tr, 42);
    assert.deepEqual(persistedPlayer.resources.Steel, { amount: 7, production: 3 });
    assert.equal(Object.keys(persistedPlayer.resources).length, RESOURCE_IDS.length);

    const resumed = roomMode === "friends"
      ? second.resume({ sessionId, clientId })
      : second.resume({ sessionId, playerId: created.player.playerId, resumeToken: created.resumeToken });
    assert.equal(resumed.error, undefined);
    assert.equal(resumed.player.playerId, created.player.playerId);
    assert.equal(resumed.player.connected, true);

    const duplicate = second.mutate({ ...trMessage, requestId: randomUUID() }, created.player.playerId);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.player.tr, 42);
    assert.equal(duplicate.player.revision, 3);
    second.close();
  });
}

test("private tokens are hashed, authenticate correctly, and cascade with their player", () => {
  const manager = new SessionManager();
  const created = manager.createSession({ clientId: randomUUID(), displayName: "Ada", roomMode: "private" });
  const stored = manager.database.prepare("SELECT resume_token_hash AS hash FROM player_credentials WHERE player_id = ?")
    .get(created.player.playerId);
  assert.equal(stored.hash, hashResumeToken(created.resumeToken));
  assert.notEqual(stored.hash, created.resumeToken);
  const databaseContents = ["sessions", "players", "player_resources", "client_players", "player_credentials", "processed_actions"]
    .flatMap((table) => manager.database.prepare(`SELECT * FROM ${table}`).all());
  assert.equal(JSON.stringify(databaseContents).includes(created.resumeToken), false);
  assert.equal(manager.database.prepare("SELECT COUNT(*) AS count FROM player_resources WHERE player_id = ?").get(created.player.playerId).count, 6);
  assert.equal(manager.resume({ sessionId: created.state.sessionId, playerId: created.player.playerId, resumeToken: "wrong" }).error.code, "AUTHENTICATION_FAILED");
  assert.equal(manager.resume({ sessionId: created.state.sessionId, playerId: created.player.playerId, resumeToken: created.resumeToken }).error, undefined);

  manager.leave(created.state.sessionId, created.player.playerId);
  for (const table of ["sessions", "players", "player_resources", "client_players", "player_credentials", "processed_actions"]) {
    assert.equal(manager.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} did not cascade`);
  }
  manager.close();
});

test("a failed gameplay transaction rolls back state and action history", () => {
  const manager = new SessionManager();
  const created = manager.createSession({ clientId: randomUUID(), displayName: "Ada", roomMode: "friends" });
  manager.database.exec(`
    CREATE TRIGGER fail_action_insert BEFORE INSERT ON processed_actions
    BEGIN SELECT RAISE(ABORT, 'simulated write failure'); END;
  `);
  assert.throws(() => action(manager, created.state.sessionId, created.player.playerId, "updateTR", 0, { tr: 30 }));
  const persisted = manager.loadState(created.state.sessionId).players[0];
  assert.equal(persisted.tr, 20);
  assert.equal(persisted.revision, 0);
  assert.equal(manager.database.prepare("SELECT COUNT(*) AS count FROM processed_actions").get().count, 0);
  manager.close();
});

test("processed action history is capped at the most recent 1000 entries per session", () => {
  const manager = new SessionManager();
  const created = manager.createSession({ clientId: randomUUID(), displayName: "Ada", roomMode: "friends" });
  const actionIds = Array.from({ length: 1005 }, () => randomUUID());
  manager.database.transaction(() => {
    actionIds.forEach((actionId, index) => manager.actionRepository.insert(
      created.state.sessionId,
      actionId,
      created.player.playerId,
      `fingerprint-${index}`,
      new Date(index).toISOString(),
    ));
    manager.actionRepository.prune(created.state.sessionId);
  })();

  assert.equal(manager.database.prepare("SELECT COUNT(*) AS count FROM processed_actions WHERE session_id = ?").get(created.state.sessionId).count, 1000);
  assert.equal(manager.actionRepository.find(created.state.sessionId, actionIds[0]), undefined);
  assert.equal(manager.actionRepository.find(created.state.sessionId, actionIds.at(-1)).fingerprint, "fingerprint-1004");
  manager.close();
});
