import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { validateClientMessage } from "../src/validator.js";

const base = (type, values = {}) => ({ type, protocolVersion: "v1", requestId: randomUUID(), ...values });
const mutation = (values = {}) => base("updateResource", {
  sessionId: randomUUID(), actionId: randomUUID(), expectedRevision: 0,
  resourceId: "Steel", amount: 1, operation: "add", ...values,
});

test("runtime schema accepts every supported identity shape", () => {
  assert.equal(validateClientMessage(base("createSession", { clientId: randomUUID(), displayName: "Ada", roomMode: "friends" })), true);
  assert.equal(validateClientMessage(base("resumeSession", { sessionId: randomUUID(), clientId: randomUUID() })), true);
  assert.equal(validateClientMessage(base("resumeSession", { sessionId: randomUUID(), playerId: randomUUID(), resumeToken: "a".repeat(32) })), true);
  assert.equal(validateClientMessage(mutation()), true);
});

test("runtime schema rejects malformed protocol messages", () => {
  const invalid = [
    mutation({ requestId: "not-a-uuid" }),
    base("unknownType"),
    mutation({ operation: "multiply" }),
    base("createSession", { clientId: randomUUID(), displayName: "x".repeat(21), roomMode: "friends" }),
    mutation({ production: -99 }),
    Object.fromEntries(Object.entries(mutation()).filter(([key]) => key !== "actionId")),
    mutation({ expectedRevision: -1 }),
    mutation({ unexpected: true }),
  ];
  for (const message of invalid) assert.equal(validateClientMessage(message), false, JSON.stringify(message));
});
