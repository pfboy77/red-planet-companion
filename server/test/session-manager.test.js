import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { SessionManager } from "../src/session-manager.js";

const createRoom = (manager, roomMode = "friends") => {
  const clientId = randomUUID();
  const created = manager.createSession({ clientId, displayName: "Ada", roomMode });
  return { state: created.state, player: created.player, clientId, created };
};

const action = (manager, state, player, type, values = {}, expectedRevision = player.revision, actionId = randomUUID()) => manager.mutate({
  type, sessionId: state.sessionId, actionId, expectedRevision, ...values,
}, player.playerId);

test("create defaults to a friends room with a public player identity", () => {
  const manager = new SessionManager();
  const result = manager.createSession({ clientId: randomUUID(), displayName: " Ada " });
  assert.equal(result.state.roomMode, "friends");
  assert.equal(result.state.hostPlayerId, result.player.playerId);
  assert.equal(result.player.displayName, "Ada");
  assert.equal(result.player.revision, 0);
  assert.equal(result.resumeToken, undefined);
  assert.equal("clientId" in result.state.players[0], false);
  assert.equal("resumeToken" in result.state.players[0], false);
});

test("private create issues a secret outside the public state", () => {
  const manager = new SessionManager();
  const result = manager.createSession({ clientId: randomUUID(), displayName: "Ada", roomMode: "private" });
  assert.match(result.resumeToken, /^[A-Za-z0-9_-]{32,256}$/);
  assert.equal(JSON.stringify(result.state).includes(result.resumeToken), false);
});

test("create validates identity and room mode", () => {
  const manager = new SessionManager();
  assert.equal(manager.createSession({ clientId: "bad", displayName: "Ada" }).error.code, "INVALID_MESSAGE");
  assert.equal(manager.createSession({ clientId: randomUUID(), displayName: "x".repeat(21) }).error.code, "INVALID_MESSAGE");
  assert.equal(manager.createSession({ clientId: randomUUID(), displayName: "Ada", roomMode: "public" }).error.code, "INVALID_MESSAGE");
});

test("join validates the code, capacity, and rejoin policy", () => {
  const manager = new SessionManager();
  const { state } = createRoom(manager);
  assert.equal(manager.join({ sessionId: state.sessionId, joinCode: "ZZZZZZ", clientId: randomUUID(), displayName: "Ben" }).error.code, "INVALID_JOIN_CODE");
  for (let index = 1; index < 10; index += 1) {
    assert.equal(manager.join({ sessionId: state.sessionId, joinCode: state.joinCode, clientId: randomUUID(), displayName: `P${index}` }).error, undefined);
  }
  assert.equal(manager.join({ sessionId: state.sessionId, joinCode: state.joinCode, clientId: randomUUID(), displayName: "Full" }).error.code, "SESSION_FULL");
});

test("friends reconnects with its stable client id and needs no token", () => {
  const manager = new SessionManager();
  const { state, player, clientId } = createRoom(manager, "friends");
  manager.disconnect(state.sessionId, player.playerId);
  const resumed = manager.resume({ sessionId: state.sessionId, clientId });
  assert.equal(resumed.player.playerId, player.playerId);
  assert.equal(resumed.player.connected, true);
});

test("private resume requires the issued player token", () => {
  const manager = new SessionManager();
  const { state, player, created } = createRoom(manager, "private");
  manager.disconnect(state.sessionId, player.playerId);
  assert.equal(manager.resume({ sessionId: state.sessionId, playerId: player.playerId }).error.code, "AUTHENTICATION_FAILED");
  assert.equal(manager.resume({ sessionId: state.sessionId, playerId: player.playerId, resumeToken: "wrong-token-value-that-is-long-enough" }).error.code, "AUTHENTICATION_FAILED");
  assert.equal(manager.resume({ sessionId: state.sessionId, playerId: player.playerId, resumeToken: created.resumeToken }).player.connected, true);
});

test("private join issues a token but never adds it to a snapshot", () => {
  const manager = new SessionManager();
  const { state } = createRoom(manager, "private");
  const joined = manager.join({ sessionId: state.sessionId, joinCode: state.joinCode, clientId: randomUUID(), displayName: "Ben" });
  assert.match(joined.resumeToken, /^[A-Za-z0-9_-]{32,256}$/);
  assert.equal(JSON.stringify(joined.state).includes(joined.resumeToken), false);
});

test("disconnect marks only the bound player offline", () => {
  const manager = new SessionManager();
  const { state, player } = createRoom(manager);
  const result = manager.disconnect(state.sessionId, player.playerId);
  assert.equal(result.player.connected, false);
  assert.equal(result.player.resources.MC.amount, 0);
});

for (const roomMode of ["friends", "private"]) {
  test(`${roomMode} explicit leave removes identity and permits a fresh join`, () => {
    const manager = new SessionManager();
    const { state } = createRoom(manager, roomMode);
    const clientId = randomUUID();
    const joined = manager.join({ sessionId: state.sessionId, joinCode: state.joinCode, clientId, displayName: "Ben" });
    const oldPlayerId = joined.player.playerId;
    const oldToken = joined.resumeToken;

    const left = manager.leave(state.sessionId, oldPlayerId);
    const internal = manager.sessions.get(state.sessionId);
    assert.equal(left.player.playerId, oldPlayerId);
    assert.equal(internal.state.players.some((player) => player.playerId === oldPlayerId), false);
    assert.equal(internal.clientPlayers.has(clientId), false);
    assert.equal(internal.credentials.has(oldPlayerId), false);

    const rejoined = manager.join({ sessionId: state.sessionId, joinCode: state.joinCode, clientId, displayName: "Ben again" });
    assert.equal(rejoined.error, undefined);
    assert.notEqual(rejoined.player.playerId, oldPlayerId);
    assert.equal(rejoined.rejoined, false);
    if (roomMode === "private") {
      assert.match(rejoined.resumeToken, /^[A-Za-z0-9_-]{32,256}$/);
      assert.notEqual(rejoined.resumeToken, oldToken);
    } else assert.equal(rejoined.resumeToken, undefined);
  });
}

test("host leave transfers ownership to the first remaining player", () => {
  const manager = new SessionManager();
  const { state, player: host } = createRoom(manager);
  const joined = manager.join({ sessionId: state.sessionId, joinCode: state.joinCode, clientId: randomUUID(), displayName: "Ben" });

  const result = manager.leave(state.sessionId, host.playerId);

  assert.equal(result.state.hostPlayerId, joined.player.playerId);
  assert.deepEqual(result.state.players.map((player) => player.playerId), [joined.player.playerId]);
});

test("last player leave deletes the session and all resume paths", () => {
  const manager = new SessionManager();
  const { state, player, clientId, created } = createRoom(manager, "private");

  const result = manager.leave(state.sessionId, player.playerId);

  assert.equal(result.sessionDeleted, true);
  assert.equal(manager.sessions.has(state.sessionId), false);
  assert.equal(manager.resume({ sessionId: state.sessionId, playerId: player.playerId, resumeToken: created.resumeToken }).error.code, "SESSION_NOT_FOUND");
  assert.equal(manager.join({ sessionId: state.sessionId, joinCode: state.joinCode, clientId, displayName: "Ada" }).error.code, "SESSION_NOT_FOUND");
});

test("explicit leave releases session capacity", () => {
  const manager = new SessionManager();
  const { state } = createRoom(manager);
  for (let index = 1; index < 10; index += 1) {
    manager.join({ sessionId: state.sessionId, joinCode: state.joinCode, clientId: randomUUID(), displayName: `P${index}` });
  }
  assert.equal(state.players.length, 10);
  manager.leave(state.sessionId, state.players[5].playerId);

  const replacement = manager.join({ sessionId: state.sessionId, joinCode: state.joinCode, clientId: randomUUID(), displayName: "Replacement" });

  assert.equal(replacement.error, undefined);
  assert.equal(state.players.length, 10);
});

test("independent players do not conflict on session revision", () => {
  const manager = new SessionManager();
  const { state, player: ada } = createRoom(manager);
  const { player: ben } = manager.join({ sessionId: state.sessionId, joinCode: state.joinCode, clientId: randomUUID(), displayName: "Ben" });
  const adaResult = action(manager, state, ada, "updateResource", { resourceId: "Steel", amount: 4, operation: "add" }, 0);
  const benResult = action(manager, state, ben, "updateResource", { resourceId: "Plants", amount: 3, operation: "add" }, 0);
  assert.equal(adaResult.error, undefined);
  assert.equal(benResult.error, undefined);
  assert.equal(ada.resources.Steel.amount, 4);
  assert.equal(ben.resources.Plants.amount, 3);
  assert.equal(ada.revision, 1);
  assert.equal(ben.revision, 1);
});

test("a stale action for the same player returns the latest state", () => {
  const manager = new SessionManager();
  const { state, player } = createRoom(manager);
  action(manager, state, player, "updateTR", { tr: 21 }, 0);
  const stale = action(manager, state, player, "resetPlayer", {}, 0);
  assert.equal(stale.error.code, "STALE_REVISION");
  assert.equal(stale.state, state);
  assert.equal(player.tr, 21);
});

test("resource, production, TR, production phase, and reset mutations work", () => {
  const manager = new SessionManager();
  const { state, player } = createRoom(manager);
  assert.equal(action(manager, state, player, "updateResource", { resourceId: "Energy", amount: 5, operation: "set" }).error, undefined);
  assert.equal(action(manager, state, player, "updateProduction", { resourceId: "Energy", production: 2 }).error, undefined);
  assert.equal(action(manager, state, player, "updateTR", { tr: 25 }).error, undefined);
  assert.equal(action(manager, state, player, "runProduction").error, undefined);
  assert.equal(player.resources.Heat.amount, 5);
  assert.equal(player.resources.Energy.amount, 2);
  assert.equal(action(manager, state, player, "resetPlayer").error, undefined);
  assert.equal(player.tr, 20);
  assert.equal(player.resources.Energy.amount, 0);
});

test("invalid and unsafe mutations are atomic", () => {
  const manager = new SessionManager();
  const { state, player } = createRoom(manager);
  assert.equal(action(manager, state, player, "updateResource", { resourceId: "Water", amount: 1, operation: "add" }).error.code, "INVALID_RESOURCE");
  assert.equal(action(manager, state, player, "updateResource", { resourceId: "Steel", amount: -1, operation: "add" }).error.code, "INVALID_AMOUNT");
  assert.equal(action(manager, state, player, "updateProduction", { resourceId: "Steel", production: -1 }).error.code, "INVALID_PRODUCTION");
  assert.equal(action(manager, state, player, "updateTR", { tr: 101 }).error.code, "INVALID_TR");
  assert.equal(action(manager, state, player, "unsupported").error.code, "INVALID_MESSAGE");
  action(manager, state, player, "updateResource", { resourceId: "MC", amount: Number.MAX_SAFE_INTEGER, operation: "set" });
  const before = player.resources.MC.amount;
  const overflow = action(manager, state, player, "runProduction");
  assert.equal(overflow.error.code, "INVALID_AMOUNT");
  assert.equal(player.resources.MC.amount, before);
  assert.equal(player.resources.Heat.amount, 0);
});

test("production clamps negative MC at zero", () => {
  const manager = new SessionManager();
  const { state, player } = createRoom(manager);
  action(manager, state, player, "updateTR", { tr: 0 });
  action(manager, state, player, "updateProduction", { resourceId: "MC", production: -5 });
  assert.equal(action(manager, state, player, "runProduction").error, undefined);
  assert.equal(player.resources.MC.amount, 0);
});

test("duplicate actions are idempotent only for the same fingerprint and player", () => {
  const manager = new SessionManager();
  const { state, player } = createRoom(manager);
  const actionId = randomUUID();
  const message = { type: "updateTR", sessionId: state.sessionId, actionId, expectedRevision: 0, tr: 21 };
  assert.equal(manager.mutate(message, player.playerId).error, undefined);
  assert.equal(manager.mutate(message, player.playerId).duplicate, true);
  assert.equal(manager.mutate({ ...message, tr: 22 }, player.playerId).error.code, "DUPLICATE_ACTION");
  assert.equal(player.tr, 21);
});
