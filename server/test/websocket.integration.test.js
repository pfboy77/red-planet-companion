import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { WebSocket } from "ws";
import { CONNECTION_REPLACED_CLOSE_CODE, createLocalServer } from "../src/index.js";

const protocolDirectory = new URL("../../protocol/schemas/", import.meta.url);
const serverSchema = JSON.parse(readFileSync(new URL("server-message.schema.json", protocolDirectory), "utf8"));
const sessionSchema = JSON.parse(readFileSync(new URL("session-state.schema.json", protocolDirectory), "utf8"));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addSchema(sessionSchema);
const validateServerMessage = ajv.compile(serverSchema);

const request = (type, values = {}) => ({ type, protocolVersion: "v1", requestId: randomUUID(), ...values });

async function startServer({ databasePath = ":memory:", serverName } = {}) {
  const app = createLocalServer({ databasePath, serverName });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  const address = app.server.address();
  return { ...app, url: `ws://127.0.0.1:${address.port}/ws` };
}

async function stopServer(app) {
  await app.close();
}

async function connect(url, observed) {
  const socket = new WebSocket(url);
  const queued = [];
  const waiters = [];
  socket.on("message", (payload) => {
    const message = JSON.parse(payload.toString("utf8"));
    assert.equal(validateServerMessage(message), true, JSON.stringify({ message, errors: validateServerMessage.errors }));
    observed.add(message.type);
    const index = waiters.findIndex(({ predicate }) => predicate(message));
    if (index >= 0) waiters.splice(index, 1)[0].resolve(message);
    else queued.push(message);
  });
  await once(socket, "open");
  const next = (predicate) => {
    const index = queued.findIndex(predicate);
    if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiters.push(waiter);
      setTimeout(() => {
        const position = waiters.indexOf(waiter);
        if (position >= 0) waiters.splice(position, 1);
        reject(new Error("Timed out waiting for WebSocket message"));
      }, 2000).unref();
    });
  };
  await next((message) => message.type === "connectionState");
  return { socket, next };
}

async function waitFor(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

test("actual WebSockets enforce binding, validate schema, broadcast, and disconnect", async (context) => {
  const app = await startServer();
  context.after(() => stopServer(app));
  const observed = new Set();
  const adaClientId = randomUUID();
  const benClientId = randomUUID();
  const ada = await connect(app.url, observed);

  const beforeJoinAction = request("updateTR", { sessionId: randomUUID(), actionId: randomUUID(), expectedRevision: 0, tr: 21 });
  ada.socket.send(JSON.stringify(beforeJoinAction));
  assert.equal((await ada.next((message) => message.type === "actionRejected")).errors[0].code, "NOT_JOINED");

  ada.socket.send(JSON.stringify(request("createSession", { clientId: adaClientId, displayName: "Ada", roomMode: "friends" })));
  const created = await ada.next((message) => message.type === "sessionCreated");
  assert.equal(created.roomMode, "friends");
  assert.equal("resumeToken" in created, false);
  assert.equal("clientId" in created.sessionState.players[0], false);
  const adaPlayerId = created.playerId;

  const ben = await connect(app.url, observed);
  ben.socket.send(JSON.stringify(request("joinSession", {
    sessionId: created.sessionId, joinCode: created.joinCode, clientId: benClientId, displayName: "Ben",
  })));
  const joined = await ben.next((message) => message.type === "sessionJoined");
  assert.equal(joined.roomMode, "friends");
  assert.equal("resumeToken" in joined, false);
  await ada.next((message) => message.type === "playerJoined" && message.playerId === joined.playerId);
  await ben.next((message) => message.type === "stateSnapshot" && message.sessionState.players.length === 2);

  const adaActionId = randomUUID();
  const benActionId = randomUUID();
  ada.socket.send(JSON.stringify(request("updateResource", {
    sessionId: created.sessionId, actionId: adaActionId, expectedRevision: 0, resourceId: "Steel", amount: 2, operation: "add",
  })));
  ben.socket.send(JSON.stringify(request("updateResource", {
    sessionId: created.sessionId, actionId: benActionId, expectedRevision: 0, resourceId: "Plants", amount: 3, operation: "add",
  })));
  const adaAccepted = await ada.next((message) => message.type === "actionAccepted" && message.actionId === adaActionId);
  const benAccepted = await ben.next((message) => message.type === "actionAccepted" && message.actionId === benActionId);
  assert.equal(adaAccepted.sessionState.players.find((player) => player.playerId === adaPlayerId).resources.Steel.amount, 2);
  assert.equal(benAccepted.sessionState.players.find((player) => player.playerId === joined.playerId).resources.Plants.amount, 3);

  const spoofActionId = randomUUID();
  ada.socket.send(JSON.stringify(request("updateTR", {
    sessionId: created.sessionId, clientId: benClientId, actionId: spoofActionId, expectedRevision: 1, tr: 99,
  })));
  const spoofResult = await ada.next((message) => message.type === "actionAccepted" && message.actionId === spoofActionId);
  assert.equal(spoofResult.sessionState.players.find((player) => player.playerId === adaPlayerId).tr, 99);
  assert.equal(spoofResult.sessionState.players.find((player) => player.playerId === joined.playerId).tr, 20);

  const invalidActionId = randomUUID();
  ada.socket.send(JSON.stringify(request("updateResource", {
    sessionId: created.sessionId, actionId: invalidActionId, expectedRevision: 2, resourceId: "Steel", amount: 1, operation: "multiply",
  })));
  assert.equal((await ada.next((message) => message.type === "actionRejected" && message.actionId === invalidActionId)).errors[0].code, "INVALID_MESSAGE");

  const wrongSessionId = randomUUID();
  ada.socket.send(JSON.stringify(request("updateTR", { sessionId: wrongSessionId, actionId: randomUUID(), expectedRevision: 2, tr: 22 })));
  assert.equal((await ada.next((message) => message.type === "actionRejected" && message.errors[0].code === "SESSION_MISMATCH")).errors[0].code, "SESSION_MISMATCH");

  ada.socket.send("not-json");
  assert.equal((await ada.next((message) => message.type === "error" && message.errors[0].code === "INVALID_MESSAGE")).errors[0].code, "INVALID_MESSAGE");
  ada.socket.send(JSON.stringify({ ...request("ping"), unexpected: true }));
  await ada.next((message) => message.type === "error" && message.errors[0].code === "INVALID_MESSAGE");
  ada.socket.send(JSON.stringify(request("ping")));
  await ada.next((message) => message.type === "pong");

  ben.socket.terminate();
  await once(ben.socket, "close");
  const offline = await ada.next((message) => message.type === "stateSnapshot" && message.sessionState.players.some((player) => player.playerId === joined.playerId && !player.connected));
  assert.equal(offline.sessionState.players.find((player) => player.playerId === joined.playerId).connected, false);
  assert.equal(observed.has("playerLeft"), false);

  for (const type of ["connectionState", "sessionCreated", "sessionJoined", "stateSnapshot", "actionAccepted", "actionRejected", "playerJoined", "error", "pong"]) {
    assert.equal(observed.has(type), true, `missing ${type}`);
  }
});

test("private resume succeeds only with the automatically issued token", async (context) => {
  const app = await startServer();
  context.after(() => stopServer(app));
  const observed = new Set();
  const host = await connect(app.url, observed);
  host.socket.send(JSON.stringify(request("createSession", { clientId: randomUUID(), displayName: "Ada", roomMode: "private" })));
  const created = await host.next((message) => message.type === "sessionCreated");
  assert.match(created.resumeToken, /^[A-Za-z0-9_-]{32,256}$/);
  assert.equal(JSON.stringify(created.sessionState).includes(created.resumeToken), false);

  host.socket.terminate();
  await once(host.socket, "close");
  const wrong = await connect(app.url, observed);
  wrong.socket.send(JSON.stringify(request("resumeSession", { sessionId: created.sessionId, playerId: created.playerId, resumeToken: "x".repeat(32) })));
  assert.equal((await wrong.next((message) => message.type === "error")).errors[0].code, "AUTHENTICATION_FAILED");
  wrong.socket.close();

  const resumed = await connect(app.url, observed);
  resumed.socket.send(JSON.stringify(request("resumeSession", { sessionId: created.sessionId, playerId: created.playerId, resumeToken: created.resumeToken })));
  const snapshot = await resumed.next((message) => message.type === "stateSnapshot");
  assert.equal(snapshot.sessionState.players.find((player) => player.playerId === created.playerId).connected, true);
});

test("a bound WebSocket rejects a second create without leaking a connected player", async (context) => {
  const app = await startServer();
  context.after(() => stopServer(app));
  const observed = new Set();
  const peer = await connect(app.url, observed);
  peer.socket.send(JSON.stringify(request("createSession", {
    clientId: randomUUID(), displayName: "Ada", roomMode: "friends",
  })));
  const created = await peer.next((message) => message.type === "sessionCreated");

  peer.socket.send(JSON.stringify(request("createSession", {
    clientId: randomUUID(), displayName: "Other Ada", roomMode: "private",
  })));
  const rejected = await peer.next((message) => message.type === "error");

  assert.equal(rejected.errors[0].code, "ALREADY_JOINED");
  assert.equal(app.manager.sessions.size, 1);
  assert.equal(app.manager.sessions.get(created.sessionId).state.players.length, 1);

  peer.socket.terminate();
  await once(peer.socket, "close");
  await waitFor(
    () => app.manager.sessions.get(created.sessionId).state.players[0].connected === false,
    "the original player remained connected after its bound socket closed",
  );
});

test("a bound WebSocket rejects a second join and keeps its original binding", async (context) => {
  const app = await startServer();
  context.after(() => stopServer(app));
  const observed = new Set();
  const host = await connect(app.url, observed);
  host.socket.send(JSON.stringify(request("createSession", {
    clientId: randomUUID(), displayName: "Host", roomMode: "friends",
  })));
  const created = await host.next((message) => message.type === "sessionCreated");
  const guest = await connect(app.url, observed);
  guest.socket.send(JSON.stringify(request("joinSession", {
    sessionId: created.sessionId, joinCode: created.joinCode, clientId: randomUUID(), displayName: "Guest",
  })));
  const joined = await guest.next((message) => message.type === "sessionJoined");

  guest.socket.send(JSON.stringify(request("joinSession", {
    sessionId: created.sessionId, joinCode: created.joinCode, clientId: randomUUID(), displayName: "Ghost",
  })));
  const rejected = await guest.next((message) => message.type === "error");

  assert.equal(rejected.errors[0].code, "ALREADY_JOINED");
  assert.equal(app.manager.sessions.get(created.sessionId).state.players.length, 2);

  guest.socket.terminate();
  await once(guest.socket, "close");
  await waitFor(
    () => app.manager.sessions.get(created.sessionId).state.players.find((player) => player.playerId === joined.playerId).connected === false,
    "the originally joined player remained connected after its socket closed",
  );
});

test("a resumed WebSocket rejects join and keeps the resumed player binding", async (context) => {
  const app = await startServer();
  context.after(() => stopServer(app));
  const observed = new Set();
  const first = await connect(app.url, observed);
  first.socket.send(JSON.stringify(request("createSession", {
    clientId: randomUUID(), displayName: "Ada", roomMode: "private",
  })));
  const created = await first.next((message) => message.type === "sessionCreated");
  first.socket.terminate();
  await once(first.socket, "close");

  const resumed = await connect(app.url, observed);
  resumed.socket.send(JSON.stringify(request("resumeSession", {
    sessionId: created.sessionId, playerId: created.playerId, resumeToken: created.resumeToken,
  })));
  await resumed.next((message) => message.type === "stateSnapshot");
  resumed.socket.send(JSON.stringify(request("joinSession", {
    sessionId: created.sessionId, joinCode: created.joinCode, clientId: randomUUID(), displayName: "Ghost",
  })));
  const rejected = await resumed.next((message) => message.type === "error");

  assert.equal(rejected.errors[0].code, "ALREADY_JOINED");
  assert.equal(app.manager.sessions.get(created.sessionId).state.players.length, 1);

  resumed.socket.terminate();
  await once(resumed.socket, "close");
  await waitFor(
    () => app.manager.sessions.get(created.sessionId).state.players[0].connected === false,
    "the resumed player remained connected after its socket closed",
  );
});

for (const roomMode of ["friends", "private"]) {
  test(`${roomMode} keeps the replacement socket active until it closes`, async (context) => {
    const app = await startServer();
    context.after(() => stopServer(app));
    const observed = new Set();
    const clientId = randomUUID();
    const first = await connect(app.url, observed);
    first.socket.send(JSON.stringify(request("createSession", { clientId, displayName: "Ada", roomMode })));
    const created = await first.next((message) => message.type === "sessionCreated");
    const firstClosed = once(first.socket, "close");

    const replacement = await connect(app.url, observed);
    const identity = roomMode === "private"
      ? { playerId: created.playerId, resumeToken: created.resumeToken }
      : { clientId };
    replacement.socket.send(JSON.stringify(request("resumeSession", { sessionId: created.sessionId, ...identity })));
    const resumed = await replacement.next((message) => message.type === "stateSnapshot");
    const [closeCode, closeReason] = await firstClosed;

    assert.equal(closeCode, CONNECTION_REPLACED_CLOSE_CODE);
    assert.equal(closeReason.toString(), "Connection replaced");
    assert.equal(resumed.sessionState.players.find((player) => player.playerId === created.playerId).connected, true);
    assert.equal(app.manager.sessions.get(created.sessionId).state.players[0].connected, true);

    const actionId = randomUUID();
    replacement.socket.send(JSON.stringify(request("updateTR", {
      sessionId: created.sessionId, actionId, expectedRevision: 0, tr: 21,
    })));
    const accepted = await replacement.next((message) => message.type === "actionAccepted" && message.actionId === actionId);
    assert.equal(accepted.sessionState.players[0].tr, 21);

    replacement.socket.terminate();
    await once(replacement.socket, "close");
    await waitFor(
      () => app.manager.sessions.get(created.sessionId).state.players[0].connected === false,
      "active replacement socket did not mark the player offline",
    );
  });

  test(`${roomMode} explicit leave permits the same client to join as a new player`, async (context) => {
    const app = await startServer();
    context.after(() => stopServer(app));
    const observed = new Set();
    const host = await connect(app.url, observed);
    host.socket.send(JSON.stringify(request("createSession", { clientId: randomUUID(), displayName: "Host", roomMode })));
    const created = await host.next((message) => message.type === "sessionCreated");
    const guestClientId = randomUUID();
    let guest = await connect(app.url, observed);
    guest.socket.send(JSON.stringify(request("joinSession", {
      sessionId: created.sessionId, joinCode: created.joinCode, clientId: guestClientId, displayName: "Guest",
    })));
    const joined = await guest.next((message) => message.type === "sessionJoined");
    await host.next((message) => message.type === "playerJoined" && message.playerId === joined.playerId);
    const oldToken = joined.resumeToken;

    if (roomMode === "private") {
      for (let cycle = 0; cycle < 2; cycle += 1) {
        guest.socket.terminate();
        await once(guest.socket, "close");
        await host.next((message) => message.type === "stateSnapshot"
          && message.sessionState.players.some((player) => player.playerId === joined.playerId && !player.connected));
        guest = await connect(app.url, observed);
        guest.socket.send(JSON.stringify(request("resumeSession", {
          sessionId: created.sessionId, playerId: joined.playerId, resumeToken: oldToken,
        })));
        const resumed = await guest.next((message) => message.type === "stateSnapshot"
          && message.sessionState.players.some((player) => player.playerId === joined.playerId && player.connected));
        assert.equal(resumed.sessionState.players.find((player) => player.playerId === joined.playerId).connected, true);
      }
    }

    guest.socket.send(JSON.stringify(request("leaveSession", { sessionId: created.sessionId })));
    const left = await guest.next((message) => message.type === "sessionLeft");
    assert.equal(left.sessionId, created.sessionId);
    assert.equal(left.playerId, joined.playerId);
    assert.equal(left.sessionDeleted, false);
    await host.next((message) => message.type === "playerLeft" && message.playerId === joined.playerId);
    const afterLeave = await host.next((message) => message.type === "stateSnapshot"
      && !message.sessionState.players.some((player) => player.playerId === joined.playerId));
    assert.equal(afterLeave.sessionState.players.length, 1);

    if (roomMode === "private") {
      const staleResume = await connect(app.url, observed);
      staleResume.socket.send(JSON.stringify(request("resumeSession", {
        sessionId: created.sessionId, playerId: joined.playerId, resumeToken: oldToken,
      })));
      assert.equal((await staleResume.next((message) => message.type === "error")).errors[0].code, "PLAYER_NOT_FOUND");
      staleResume.socket.close();
    }

    const fresh = await connect(app.url, observed);
    fresh.socket.send(JSON.stringify(request("joinSession", {
      sessionId: created.sessionId, joinCode: created.joinCode, clientId: guestClientId, displayName: "Guest again",
    })));
    const rejoined = await fresh.next((message) => message.type === "sessionJoined");
    assert.notEqual(rejoined.playerId, joined.playerId);
    if (roomMode === "private") {
      assert.match(rejoined.resumeToken, /^[A-Za-z0-9_-]{32,256}$/);
      assert.notEqual(rejoined.resumeToken, oldToken);
    } else assert.equal("resumeToken" in rejoined, false);
  });
}

test("last player receives sessionLeft before its session is deleted", async (context) => {
  const app = await startServer();
  context.after(() => stopServer(app));
  const observed = new Set();
  const player = await connect(app.url, observed);
  player.socket.send(JSON.stringify(request("createSession", {
    clientId: randomUUID(), displayName: "Solo host", roomMode: "private",
  })));
  const created = await player.next((message) => message.type === "sessionCreated");

  player.socket.send(JSON.stringify(request("leaveSession", { sessionId: created.sessionId })));
  const left = await player.next((message) => message.type === "sessionLeft");

  assert.equal(left.sessionId, created.sessionId);
  assert.equal(left.playerId, created.playerId);
  assert.equal(left.sessionDeleted, true);
  assert.equal(app.manager.sessions.has(created.sessionId), false);
});

test("health exposes stable public server metadata without internal configuration", async (context) => {
  const app = await startServer({ serverName: "Home Red Planet Server" });
  context.after(() => stopServer(app));
  const response = await fetch(app.url.replace("ws://", "http://").replace("/ws", "/health"));
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.deepEqual(body, {
    status: "ok",
    serverId: app.manager.serverMetadata.serverId,
    serverName: "Home Red Planet Server",
    protocolVersion: "v1",
  });
  assert.equal("databasePath" in body, false);
  assert.equal("resumeToken" in body, false);
});

for (const roomMode of ["friends", "private"]) {
  test(`${roomMode} WebSocket resume restores state and idempotency after server restart`, async () => {
    const databasePath = join(mkdtempSync(join(tmpdir(), "red-planet-ws-")), "restart.sqlite3");
    const clientId = randomUUID();
    const observedA = new Set();
    const serverA = await startServer({ databasePath });
    const original = await connect(serverA.url, observedA);
    original.socket.send(JSON.stringify(request("createSession", { clientId, displayName: "Ada", roomMode })));
    const created = await original.next((message) => message.type === "sessionCreated");
    const actionId = randomUUID();
    original.socket.send(JSON.stringify(request("updateResource", {
      sessionId: created.sessionId,
      actionId,
      expectedRevision: 0,
      resourceId: "Steel",
      amount: 7,
      operation: "add",
    })));
    await original.next((message) => message.type === "actionAccepted" && message.actionId === actionId);
    original.socket.send(JSON.stringify(request("updateProduction", {
      sessionId: created.sessionId,
      actionId: randomUUID(),
      expectedRevision: 1,
      resourceId: "Steel",
      production: 3,
    })));
    await original.next((message) => message.type === "actionAccepted" && message.playerRevision === 2);
    original.socket.send(JSON.stringify(request("updateTR", {
      sessionId: created.sessionId,
      actionId: randomUUID(),
      expectedRevision: 2,
      tr: 42,
    })));
    const beforeRestart = await original.next((message) => message.type === "actionAccepted" && message.playerRevision === 3);
    await stopServer(serverA);

    const observedB = new Set();
    const serverB = await startServer({ databasePath });
    try {
      const resumed = await connect(serverB.url, observedB);
      const resumeValues = roomMode === "friends"
        ? { sessionId: created.sessionId, clientId }
        : { sessionId: created.sessionId, playerId: created.playerId, resumeToken: created.resumeToken };
      resumed.socket.send(JSON.stringify(request("resumeSession", resumeValues)));
      const snapshot = await resumed.next((message) => message.type === "stateSnapshot");
      const player = snapshot.sessionState.players.find(({ playerId }) => playerId === created.playerId);
      assert.equal(snapshot.sessionState.sessionId, created.sessionId);
      assert.equal(snapshot.sessionState.joinCode, created.joinCode);
      assert.equal(snapshot.sessionState.hostPlayerId, created.hostPlayerId);
      assert.equal(player.tr, 42);
      assert.deepEqual(player.resources.Steel, { amount: 7, production: 3 });
      assert.equal(player.revision, 3);
      assert.ok(snapshot.sessionState.revision > beforeRestart.sessionState.revision);

      resumed.socket.send(JSON.stringify(request("updateResource", {
        sessionId: created.sessionId,
        actionId,
        expectedRevision: 0,
        resourceId: "Steel",
        amount: 7,
        operation: "add",
      })));
      const duplicate = await resumed.next((message) => message.type === "actionAccepted" && message.actionId === actionId);
      assert.equal(duplicate.sessionState.players.find(({ playerId }) => playerId === created.playerId).resources.Steel.amount, 7);
    } finally {
      await stopServer(serverB);
    }
  });
}
