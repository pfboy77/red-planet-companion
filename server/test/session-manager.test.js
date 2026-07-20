import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../src/session-manager.js";

const createPlayer = (manager) => {
  const state = manager.createSession();
  const clientId = randomUUID();
  const joined = manager.join({ sessionId: state.sessionId, joinCode: state.joinCode, clientId, displayName: "Ada" });
  return { state, clientId, joined };
};

test("a mutation updates only its player and increments the revision", () => {
  const manager = new SessionManager(); const { state, clientId } = createPlayer(manager);
  const other = manager.join({ sessionId: state.sessionId, joinCode: state.joinCode, clientId: randomUUID(), displayName: "Ben" });
  const result = manager.mutate({ type: "updateResource", sessionId: state.sessionId, clientId, actionId: randomUUID(), expectedRevision: 0, resourceId: "Steel", amount: 4, operation: "add" });
  assert.equal(result.state.revision, 1);
  assert.equal(result.state.players[0].resources.Steel.amount, 4);
  assert.equal(other.state.players[1].resources.Steel.amount, 0);
});

test("a stale action is rejected without changing the game", () => {
  const manager = new SessionManager(); const { state, clientId } = createPlayer(manager);
  manager.mutate({ type: "updateTR", sessionId: state.sessionId, clientId, actionId: randomUUID(), expectedRevision: 0, tr: 21 });
  const result = manager.mutate({ type: "resetPlayer", sessionId: state.sessionId, clientId, actionId: randomUUID(), expectedRevision: 0 });
  assert.equal(result.error.code, "STALE_REVISION"); assert.equal(state.players[0].tr, 21);
});

test("disconnect marks a player offline without removing their resources", () => {
  const manager = new SessionManager(); const { state, clientId } = createPlayer(manager);
  const result = manager.disconnect(state.sessionId, clientId);
  assert.equal(result.player.connected, false);
  assert.equal(result.state.players[0].resources.MC.amount, 0);
});
