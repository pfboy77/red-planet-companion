import test from "node:test";
import assert from "node:assert/strict";
import { peerAuthorizationError } from "../src/peer-authorization.js";

test("a peer may act only in its bound session", () => {
  const peer = { sessionId: "session-a", playerId: "player-a" };

  assert.equal(peerAuthorizationError(peer, { sessionId: "session-a" }), undefined);
  assert.equal(peerAuthorizationError(peer, { sessionId: "session-b" }).code, "SESSION_MISMATCH");
});

test("an unbound peer cannot mutate or leave a session", () => {
  assert.equal(peerAuthorizationError({}, { sessionId: "session-a" }).code, "NOT_JOINED");
});
