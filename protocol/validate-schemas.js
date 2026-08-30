import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { SessionManager } from "../server/src/session-manager.js";

const schemasDirectory = join(import.meta.dirname, "schemas");
const fixturesDirectory = join(import.meta.dirname, "fixtures");

function loadJSON(directory, filename) {
  return JSON.parse(readFileSync(join(directory, filename), "utf8"));
}

const schemas = {
  game: loadJSON(schemasDirectory, "game-state.schema.json"),
  session: loadJSON(schemasDirectory, "session-state.schema.json"),
  client: loadJSON(schemasDirectory, "client-message.schema.json"),
  server: loadJSON(schemasDirectory, "server-message.schema.json"),
};

// The schemas use allOf composition where the object type is declared in a
// sibling subschema. Draft-07 permits this, so only strictTypes is relaxed.
const ajv = new Ajv({ allErrors: true, strict: true, strictTypes: false });
addFormats(ajv);
Object.values(schemas).forEach(schema => ajv.addSchema(schema));

const validators = {
  game: ajv.getSchema("game-state.schema.json"),
  session: ajv.getSchema("session-state.schema.json"),
  client: ajv.getSchema("client-message.schema.json"),
  server: ajv.getSchema("server-message.schema.json"),
};

let passed = 0;
let failed = 0;

function check(condition, description, errors = null) {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${description}`);
    return;
  }

  failed += 1;
  console.error(`  ✗ ${description}`);
  if (errors) {
    console.error(ajv.errorsText(errors, { separator: "\n    " }));
  }
}

function validateFixture(filename, validator) {
  const data = loadJSON(fixturesDirectory, filename);
  const valid = validator(data);
  check(valid, `${filename} passes its schema`, validator.errors);
  return data;
}

function without(object, key) {
  const clone = { ...object };
  delete clone[key];
  return clone;
}

console.log("=== Red Planet Companion — JSON Schema validation ===");

const gameState = validateFixture("game-state.json", validators.game);
const createSession = validateFixture("create-session.json", validators.client);
validateFixture("join-session.json", validators.client);
const resumeSession = validateFixture("resume-session.json", validators.client);
validateFixture("update-resource.json", validators.client);
validateFixture("update-production.json", validators.client);
validateFixture("update-tr.json", validators.client);
validateFixture("run-production.json", validators.client);
validateFixture("reset-player.json", validators.client);
const stateSnapshot = validateFixture("state-snapshot.json", validators.server);
validateFixture("stale-revision-error.json", validators.server);
validateFixture("invalid-message.json", validators.server);
const sessionJoined = validateFixture("session-joined.json", validators.server);
const sessionLeft = validateFixture("session-left.json", validators.server);
validateFixture("session-full-error.json", validators.server);
validateFixture("authentication-failed-error.json", validators.server);

check(validators.session(stateSnapshot.sessionState),
      "state-snapshot sessionState passes the session schema",
      validators.session.errors);
check(gameState.resources.every(resource => resource.amount === 0 && resource.production === 0),
      "canonical game state starts with zero amounts and production");
check(gameState.tr === 20, "canonical game state starts with TR 20");

const sessionId = "c3d4e5f6-a7b8-9012-cdef-123456789012";
const resumeToken = "0123456789abcdef0123456789abcdef";
const timestamp = "2026-07-13T12:00:05.000Z";

const sessionCreated = {
  type: "sessionCreated",
  protocolVersion: "v1",
  timestamp,
  sessionId,
  joinCode: stateSnapshot.sessionState.joinCode,
  hostPlayerId: stateSnapshot.sessionState.hostPlayerId,
  playerId: stateSnapshot.sessionState.hostPlayerId,
  roomMode: "private",
  resumeToken,
  sessionState: stateSnapshot.sessionState,
};
check(validators.server(sessionCreated),
      "sessionCreated returns the host resume token",
      validators.server.errors);

const negativeMcProduction = {
  ...loadJSON(fixturesDirectory, "update-production.json"),
  resourceId: "MC",
  production: -5,
};
check(validators.client(negativeMcProduction),
      "MC production may be negative down to -5",
      validators.client.errors);

check(!Object.hasOwn(stateSnapshot.sessionState, "resumeToken") &&
      stateSnapshot.sessionState.players.every(player => !Object.hasOwn(player, "resumeToken") && !Object.hasOwn(player, "clientId")),
      "public session snapshots never expose credentials or client IDs");

const invalidOperationRejection = {
  ...loadJSON(fixturesDirectory, "stale-revision-error.json"),
  errors: [{ code: "INVALID_OPERATION", message: "Unsupported resource operation" }],
};
check(validators.server(invalidOperationRejection),
      "INVALID_OPERATION is a valid actionRejected code",
      validators.server.errors);

const authenticationRejection = {
  ...loadJSON(fixturesDirectory, "stale-revision-error.json"),
  errors: [{ code: "AUTHENTICATION_FAILED", message: "Connection identity does not match" }],
};
check(validators.server(authenticationRejection),
      "authentication failures on mutations use actionRejected",
      validators.server.errors);

const implementationManager = new SessionManager();
const implementationHostId = randomUUID();
const implementationCreated = implementationManager.createSession({ clientId: implementationHostId, displayName: "Host", roomMode: "private" });
check(validators.session(implementationCreated.state),
      "SessionManager createSession produces a schema-valid hosted session",
      validators.session.errors);
check(validators.server({
        type: "sessionCreated",
        protocolVersion: "v1",
        timestamp,
        sessionId: implementationCreated.state.sessionId,
        joinCode: implementationCreated.state.joinCode,
        hostPlayerId: implementationCreated.state.hostPlayerId,
        playerId: implementationCreated.player.playerId,
        roomMode: implementationCreated.state.roomMode,
        resumeToken: implementationCreated.resumeToken,
        sessionState: implementationCreated.state,
      }),
      "SessionManager create result produces a schema-valid sessionCreated response",
      validators.server.errors);
const implementationJoinerId = randomUUID();
const implementationJoined = implementationManager.join({
  sessionId: implementationCreated.state.sessionId,
  joinCode: implementationCreated.state.joinCode,
  clientId: implementationJoinerId,
  displayName: "Joiner",
});
check(validators.server({
        type: "sessionJoined",
        protocolVersion: "v1",
        timestamp,
        sessionId: implementationCreated.state.sessionId,
        playerId: implementationJoined.player.playerId,
        playerIndex: implementationCreated.state.players.indexOf(implementationJoined.player),
        roomMode: implementationCreated.state.roomMode,
        resumeToken: implementationJoined.resumeToken,
      }),
      "SessionManager join result produces a schema-valid sessionJoined response",
      validators.server.errors);
check(!JSON.stringify(implementationCreated.state).includes(implementationCreated.resumeToken) &&
      !JSON.stringify(implementationCreated.state).includes(implementationJoined.resumeToken),
      "SessionManager keeps resume credentials outside its public state");

const invalidCases = [
  {
    description: "resumeSession rejects a short resume token",
    validator: validators.client,
    data: { ...resumeSession, resumeToken: "too-short" },
  },
  {
    description: "createSession rejects a leaked resume token",
    validator: validators.client,
    data: { ...createSession, resumeToken },
  },
  {
    description: "non-MC production cannot be negative",
    validator: validators.client,
    data: { ...loadJSON(fixturesDirectory, "update-production.json"), resourceId: "Steel", production: -1 },
  },
  {
    description: "GameState also rejects negative non-MC production",
    validator: validators.game,
    data: {
      ...gameState,
      resources: gameState.resources.map(resource =>
        resource.name === "Steel" ? { ...resource, production: -1 } : resource),
    },
  },
  {
    description: "sessionState rejects a leaked top-level resume token",
    validator: validators.session,
    data: { ...stateSnapshot.sessionState, resumeToken },
  },
  {
    description: "stateSnapshot rejects a leaked response-level resume token",
    validator: validators.server,
    data: { ...stateSnapshot, resumeToken },
  },
  {
    description: "sessionState rejects a leaked player resume token",
    validator: validators.session,
    data: {
      ...stateSnapshot.sessionState,
      players: stateSnapshot.sessionState.players.map((player, index) =>
        index === 0 ? { ...player, resumeToken } : player),
    },
  },
  {
    description: "missing type is rejected",
    validator: validators.client,
    data: { protocolVersion: "v1", requestId: createSession.requestId },
  },
  {
    description: "unknown message type is rejected",
    validator: validators.client,
    data: { ...createSession, type: "unknownType" },
  },
  {
    description: "invalid request UUID is rejected",
    validator: validators.client,
    data: { ...createSession, requestId: "not-a-uuid" },
  },
  {
    description: "unsupported protocol version is rejected",
    validator: validators.client,
    data: { ...createSession, protocolVersion: "v2" },
  },
  {
    description: "createSession without clientId is rejected",
    validator: validators.client,
    data: without(createSession, "clientId"),
  },
  {
    description: "createSession without displayName is rejected",
    validator: validators.client,
    data: without(createSession, "displayName"),
  },
  {
    description: "resumeSession without resumeToken is rejected",
    validator: validators.client,
    data: without(resumeSession, "resumeToken"),
  },
  {
    description: "a mutation without sessionId is rejected",
    validator: validators.client,
    data: without(loadJSON(fixturesDirectory, "update-resource.json"), "sessionId"),
  },
  {
    description: "a mutation without expectedRevision is rejected",
    validator: validators.client,
    data: without(loadJSON(fixturesDirectory, "update-resource.json"), "expectedRevision"),
  },
  {
    description: "sessionCreated without resumeToken is rejected",
    validator: validators.server,
    data: without(sessionCreated, "resumeToken"),
  },
  {
    description: "sessionJoined without resumeToken is rejected",
    validator: validators.server,
    data: without(sessionJoined, "resumeToken"),
  },
  {
    description: "sessionLeft requires sessionDeleted",
    validator: validators.server,
    data: without(sessionLeft, "sessionDeleted"),
  },
  {
    description: "STALE_REVISION uses actionRejected, not error",
    validator: validators.server,
    data: {
      type: "error",
      protocolVersion: "v1",
      timestamp,
      errors: [{ code: "STALE_REVISION", message: "Revision has changed" }],
    },
  },
  {
    description: "non-action validation failures cannot use actionRejected",
    validator: validators.server,
    data: {
      type: "actionRejected",
      protocolVersion: "v1",
      timestamp,
      actionId: "f6a7b8c9-d0e1-2345-fabc-456789012345",
      errors: [{ code: "INVALID_JOIN_CODE", message: "Join code is invalid" }],
    },
  },
  {
    description: "a production result cannot have a negative resource amount",
    validator: validators.session,
    data: {
      ...stateSnapshot.sessionState,
      players: stateSnapshot.sessionState.players.map((player, index) => index === 0 ? {
        ...player,
        resources: { ...player.resources, MC: { amount: -5, production: -5 } },
      } : player),
    },
  },
  {
    description: "invalid timestamp format is rejected",
    validator: validators.server,
    data: {
      type: "pong",
      protocolVersion: "v1",
      timestamp: "not-a-date",
    },
  },
  {
    description: "snapshot without sessionState is rejected",
    validator: validators.server,
    data: {
      type: "stateSnapshot",
      protocolVersion: "v1",
      timestamp: "2026-07-13T12:00:05.000Z",
      revision: 5,
    },
  },
];

for (const testCase of invalidCases) {
  const valid = testCase.validator(testCase.data);
  check(!valid, testCase.description);
}

console.log(`\nPassed: ${passed}`);
console.log(`Failed: ${failed}`);

if (failed > 0) {
  process.exitCode = 1;
} else {
  console.log("All schema validation tests passed.");
}
