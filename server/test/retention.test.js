import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateJoinCode, SessionManager } from "../src/session-manager.js";

const clock = () => new Date("2026-09-21T00:00:00.000Z");
const create = (manager) => manager.createSession({ clientId: randomUUID(), displayName: "Test", roomMode: "private" });
const age = (manager, id, date = "2026-08-01T00:00:00.000Z") => manager.database.prepare("UPDATE sessions SET updated_at = ? WHERE session_id = ?").run(date, id);

test("secure join codes have exactly six characters from the friendly alphabet", () => {
  const values = Array.from({ length: 1000 }, generateJoinCode);
  assert.ok(values.every((value) => /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(value)));
  assert.ok(new Set(values).size > 990);
});

test("retention removes only stale disconnected sessions and cascades every child table", () => {
  const manager = new SessionManager({ clock });
  try {
    const old = create(manager);
    const recent = create(manager);
    const connected = create(manager);
    manager.mutate({ type: "updateTR", sessionId: old.state.sessionId, actionId: randomUUID(), expectedRevision: 0, tr: 21 }, old.player.playerId);
    manager.disconnect(old.state.sessionId, old.player.playerId);
    manager.disconnect(recent.state.sessionId, recent.player.playerId);
    age(manager, old.state.sessionId);
    age(manager, connected.state.sessionId);
    age(manager, recent.state.sessionId, "2026-08-22T00:00:00.000Z"); // exact boundary stays
    assert.equal(manager.cleanupInactiveSessions(), 1);
    assert.equal(manager.sessions.has(old.state.sessionId), false);
    assert.equal(manager.stateProjections.has(old.state.sessionId), false);
    assert.equal(manager.sessions.has(recent.state.sessionId), true);
    assert.equal(manager.sessions.has(connected.state.sessionId), true);
    for (const table of ["players", "player_resources", "client_players", "player_credentials", "processed_actions"]) {
      assert.equal(manager.database.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE player_id = ?`).get(old.player.playerId).n, 0, table);
    }
  } finally { manager.close(); }
  assert.equal(manager.cleanupInactiveSessions(), 0);
});

test("startup clears stale sessions after resetting old connected flags", () => {
  const path = join(mkdtempSync(join(tmpdir(), "retention-")), "test.sqlite3");
  const first = new SessionManager({ databasePath: path, clock });
  const old = create(first);
  age(first, old.state.sessionId);
  first.close();
  const next = new SessionManager({ databasePath: path, clock });
  assert.equal(next.sessions.size, 0);
  next.close();
  next.close();
});

test("cleanup before create reclaims stale capacity without requiring a restart", () => {
  const manager = new SessionManager({ clock, maxSessions: 1 });
  const old = create(manager);
  manager.disconnect(old.state.sessionId, old.player.playerId);
  age(manager, old.state.sessionId);
  assert.equal(create(manager).error, undefined);
  manager.close();
});

test("retention can be disabled and invalid configuration fails before opening a database", () => {
  for (const value of ["", " ", "abc", -1, 1.5, Infinity, 36501]) {
    assert.throws(() => new SessionManager({ sessionRetentionDays: value }), /SESSION_RETENTION_DAYS/);
  }
  const manager = new SessionManager({ clock, sessionRetentionDays: 0 });
  const old = create(manager);
  manager.disconnect(old.state.sessionId, old.player.playerId);
  age(manager, old.state.sessionId);
  assert.equal(manager.cleanupInactiveSessions(), 0);
  assert.equal(manager.sessions.size, 1);
  manager.close();
});
