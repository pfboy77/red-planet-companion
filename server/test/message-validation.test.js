import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { baseMessageError, messageShapeError } from "../src/message-validation.js";

const base = (type, values = {}) => ({ type, protocolVersion: "v1", requestId: randomUUID(), ...values });

test("base protocol fields are required before a message is handled", () => {
  assert.equal(baseMessageError(null).code, "INVALID_MESSAGE");
  assert.equal(baseMessageError({ protocolVersion: "v1", requestId: randomUUID() }).code, "INVALID_MESSAGE");
  assert.equal(baseMessageError({ type: "ping", protocolVersion: "v1", requestId: "not-a-uuid" }).code, "INVALID_MESSAGE");
  assert.equal(baseMessageError({ type: "unknownAction", protocolVersion: "v1", requestId: randomUUID() }).code, "INVALID_MESSAGE");
});

test("unsupported protocol versions have a specific error", () => {
  assert.equal(baseMessageError({ type: "ping", protocolVersion: "v2", requestId: randomUUID() }).code, "UNSUPPORTED_PROTOCOL_VERSION");
  assert.equal(baseMessageError({ type: "ping", protocolVersion: "v1", requestId: randomUUID() }), undefined);
});

test("identity and resume fields use the shared protocol schema", () => {
  assert.equal(messageShapeError(base("createSession", { clientId: randomUUID(), displayName: "Ada", roomMode: "friends" })), undefined);
  assert.equal(messageShapeError(base("resumeSession", { sessionId: randomUUID(), clientId: randomUUID() })), undefined);
  assert.equal(messageShapeError(base("resumeSession", { sessionId: randomUUID(), playerId: randomUUID(), resumeToken: "a".repeat(32) })), undefined);
  assert.equal(messageShapeError(base("leaveSession", { sessionId: randomUUID() })), undefined);
});

test("mutations require action identity but no payload client identity", () => {
  const valid = base("updateTR", { sessionId: randomUUID(), actionId: randomUUID(), expectedRevision: 0, tr: 21 });
  assert.equal(messageShapeError(valid), undefined);
  assert.equal(messageShapeError({ ...valid, sessionId: undefined }).code, "INVALID_MESSAGE");
  assert.equal(messageShapeError({ ...valid, actionId: "bad" }).code, "INVALID_MESSAGE");
  assert.equal(messageShapeError({ ...valid, expectedRevision: -1 }).code, "INVALID_MESSAGE");
});
