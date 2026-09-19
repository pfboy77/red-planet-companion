# Red Planet Companion — Common Communication Protocol

**Version**: v1.3.0
**Created**: 2026-07-13
**Updated**: 2026-08-31
**Applicable to**: iOS (SwiftUI) and Web (React/TypeScript)

---

## 1. Overview

This document defines the JSON Schema-based communication protocol between
clients (iOS, Web) and the local WebSocket server (Node.js).

All messages use JSON. WebSocket frames carry single JSON objects.
No binary, no protocol buffers, no custom encoding.

The server is the single source of truth. Clients only send **actions**
and receive **results** and **state snapshots**.

---

## 2. Protocol Version

The protocol uses a version string:

```
protocolVersion: "v1"
```

New versions may be introduced in future phases.
Clients must reject messages with an unknown `protocolVersion`.

---

## 3. Data Models

### 3.1 SessionState

Represents a multiplayer game session on the server.

| Field | Type | Description |
|-------|------|-------------|
| `protocolVersion` | string | Protocol version string. Fixed to `"v1"` |
| `sessionId` | string (UUID) | Unique session identifier |
| `joinCode` | string | 6-character uppercase code for clients to join (e.g., `"A7B2C9"`) |
| `roomMode` | `friends` or `private` | Reconnect identity policy selected by the host |
| `revision` | integer | Monotonically increasing integer. Starts at 0 |
| `createdAt` | string (ISO 8601 date-time) | Session creation timestamp |
| `updatedAt` | string (ISO 8601 date-time) | Last update timestamp |
| `hostPlayerId` | string (UUID) | Public player ID of the session host |
| `players` | array of PlayerState | List of players in the session |

### 3.2 PlayerState

Represents a player in a session.

| Field | Type | Description |
|-------|------|-------------|
| `playerId` | string (UUID) | Internal player identifier |
| `displayName` | string | Display name (max 20 characters) |
| `connected` | boolean | Connection status |
| `lastSeenAt` | string (ISO 8601 date-time) | Last seen timestamp |
| `revision` | integer | Revision of this player's gameplay state |
| `tr` | integer | Player's Terraform Rating (0–100) |
| `resources` | object (ResourcesMap) | Player's current resources |

### 3.3 ResourcesMap

A map of resource IDs to resource values.

```json
{
  "MC":      { "amount": 0, "production": 0 },
  "Steel":   { "amount": 0, "production": 0 },
  "Titanium": { "amount": 0, "production": 0 },
  "Plants":  { "amount": 0, "production": 0 },
  "Energy":  { "amount": 0, "production": 0 },
  "Heat":    { "amount": 0,  "production": 0 }
}
```

Valid resource IDs (case-sensitive): `MC`, `Steel`, `Titanium`, `Plants`, `Energy`, `Heat`.

The server MUST reject any resource ID not in this list.

Resource `amount` values are always non-negative. A production phase MUST clamp
every computed amount to at least `0`, including MC when its production is
negative.

### 3.4 GameState

The complete game state for a session.

| Field | Type | Description |
|-------|------|-------------|
| `version` | integer | Internal state version (starts at 1) |
| `resources` | array of Resource | Full resource definitions |
| `tr` | integer | Game-wide Terraform Rating (0–100) |

#### Resource

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Resource instance identifier |
| `name` | string | Human-readable name |
| `amount` | integer | Current amount |
| `production` | integer | Production amount |
| `isMegaCredit` | boolean | Is Mega Credit resource |
| `isEnergy` | boolean | Is Energy resource |
| `isHeat` | boolean | Is Heat resource |

### 3.5 Canonical Initial State

The canonical initial game state is:

```json
{
  "version": 1,
  "resources": [
    { "id": "00000000-0000-4000-8000-000000000001", "name": "MC",       "amount": 0, "production": 0, "isMegaCredit": true,  "isEnergy": false, "isHeat": false },
    { "id": "00000000-0000-4000-8000-000000000002", "name": "Steel",    "amount": 0, "production": 0, "isMegaCredit": false, "isEnergy": false, "isHeat": false },
    { "id": "00000000-0000-4000-8000-000000000003", "name": "Titanium", "amount": 0, "production": 0, "isMegaCredit": false, "isEnergy": false, "isHeat": false },
    { "id": "00000000-0000-4000-8000-000000000004", "name": "Plants",   "amount": 0, "production": 0, "isMegaCredit": false, "isEnergy": false, "isHeat": false },
    { "id": "00000000-0000-4000-8000-000000000005", "name": "Energy",   "amount": 0, "production": 0, "isMegaCredit": false, "isEnergy": true,  "isHeat": false },
    { "id": "00000000-0000-4000-8000-000000000006", "name": "Heat",     "amount": 0, "production": 0, "isMegaCredit": false, "isEnergy": false, "isHeat": true }
  ],
  "tr": 20
}
```

Notes:
- TR starts at 20
- Every resource amount starts at 0
- Every production value starts at 0

---

## 4. Client Messages

All client messages share these common fields:

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Message type identifier (required) |
| `protocolVersion` | string | Protocol version (must be `"v1"`) |
| `requestId` | string (UUID) | Unique request identifier per message |

### 4.1 Create Session

Client requests creation of a new session.

```json
{
  "type": "createSession",
  "protocolVersion": "v1",
  "requestId": "uuid-here",
  "clientId": "uuid-here",
  "displayName": "Player1",
  "roomMode": "friends"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `clientId` | string (UUID) | Host client's own identifier |
| `displayName` | string | Host player's display name (1–20 chars) |
| `roomMode` | string | `friends` (default UX) or `private` |

Creation atomically creates the session and its host player. Server responds
with `sessionCreated`; an empty session is never externally observable.

### 4.2 Join Session

Client joins an existing session.

```json
{
  "type": "joinSession",
  "protocolVersion": "v1",
  "requestId": "uuid-here",
  "sessionId": "uuid-here",
  "joinCode": "A7B2C9",
  "clientId": "uuid-here",
  "displayName": "Player1"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string (UUID) | Session to join |
| `joinCode` | string | Join code for verification |
| `clientId` | string (UUID) | Client's own identifier |
| `displayName` | string | Player's display name (1–20 chars) |

### 4.3 Leave Session

Client leaves the session.

```json
{
  "type": "leaveSession",
  "protocolVersion": "v1",
  "requestId": "uuid-here",
  "sessionId": "uuid-here"
}
```

This is an explicit departure, not a transient disconnect. The server removes
the bound player, its Friends `clientId` mapping, and any Private resume token.
If the host leaves, the first remaining player becomes host. If the last player
leaves, the session is deleted. A later `joinSession` from the same client
creates a new player identity (and a new token in Private mode).

### 4.4 Resume Session

Client reconnects to an existing session. Friends mode uses the stable local
`clientId`; Private mode uses the `playerId` and opaque token that the client
stored automatically.

```json
{
  "type": "resumeSession",
  "protocolVersion": "v1",
  "requestId": "uuid-here",
  "sessionId": "uuid-here",
  "playerId": "uuid-here",
  "resumeToken": "opaque-private-token"
}
```

Friends mode omits `playerId` and `resumeToken` and sends `clientId` instead.
`resumeToken` is the Private-mode per-player credential returned by the successful
`sessionCreated` or `sessionJoined` response. It is an opaque, base64url-safe
string of 32–256 characters. Server responds with `stateSnapshot` containing
the latest state. An invalid token or identity tuple is rejected with
`AUTHENTICATION_FAILED`.

### 4.5 Update Resource

Client updates a resource amount.

```json
{
  "type": "updateResource",
  "protocolVersion": "v1",
  "requestId": "uuid-here",
  "sessionId": "uuid-here",
  "actionId": "uuid-here",
  "expectedRevision": 5,
  "resourceId": "Steel",
  "amount": 10,
  "operation": "set"
}
```

| Field | Type | Description |
|-------|------|-------------|
| `sessionId` | string (UUID) | Session to modify |
| `actionId` | string (UUID) | Unique action identifier |
| `expectedRevision` | integer | Expected revision of the bound player |
| `resourceId` | string | Resource ID (from valid list) |
| `amount` | integer | New amount value |
| `operation` | string | `"set"` or `"add"` |

### 4.6 Update Production

Client updates a resource production value.

```json
{
  "type": "updateProduction",
  "protocolVersion": "v1",
  "requestId": "uuid-here",
  "sessionId": "uuid-here",
  "actionId": "uuid-here",
  "expectedRevision": 5,
  "resourceId": "Steel",
  "production": 3
}
```

### 4.7 Update TR

Client updates their TR.

```json
{
  "type": "updateTR",
  "protocolVersion": "v1",
  "requestId": "uuid-here",
  "sessionId": "uuid-here",
  "actionId": "uuid-here",
  "expectedRevision": 5,
  "tr": 22
}
```

### 4.8 Run Production

Client triggers the production phase.

```json
{
  "type": "runProduction",
  "protocolVersion": "v1",
  "requestId": "uuid-here",
  "sessionId": "uuid-here",
  "actionId": "uuid-here",
  "expectedRevision": 5
}
```

### 4.9 Reset Player

Client resets their resources.

```json
{
  "type": "resetPlayer",
  "protocolVersion": "v1",
  "requestId": "uuid-here",
  "sessionId": "uuid-here",
  "actionId": "uuid-here",
  "expectedRevision": 5
}
```

### 4.10 Ping

Client pings the server for health check.

```json
{
  "type": "ping",
  "protocolVersion": "v1",
  "requestId": "uuid-here"
}
```

---

## 5. Server Messages

All server messages share these common fields:

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Message type identifier |
| `protocolVersion` | string | Protocol version |
| `timestamp` | string (ISO 8601) | Server timestamp |

### 5.1 Session Created

```json
{
  "type": "sessionCreated",
  "protocolVersion": "v1",
  "timestamp": "2026-07-13T12:00:00.000Z",
  "sessionId": "uuid-here",
  "joinCode": "A7B2C9",
  "hostPlayerId": "uuid-here",
  "playerId": "uuid-here",
  "roomMode": "private",
  "resumeToken": "opaque-private-token",
  "sessionState": <SessionState>
}
```

`resumeToken` is present only for Private rooms. It belongs to the host player and is delivered only on this
requesting connection. It MUST NOT be copied into `sessionState`.

### 5.2 Session Joined

```json
{
  "type": "sessionJoined",
  "protocolVersion": "v1",
  "timestamp": "2026-07-13T12:00:01.000Z",
  "sessionId": "uuid-here",
  "playerId": "uuid-here",
  "playerIndex": 0,
  "roomMode": "private",
  "resumeToken": "opaque-private-token"
}
```

`resumeToken` is present only for Private rooms. It belongs to the joining player and is delivered only on this
requesting connection. It MUST NOT be broadcast to other players.

### 5.3 Session Left

Sent directly to the leaving client after the server has removed its player
identity and reconnect credential.

```json
{
  "type": "sessionLeft",
  "protocolVersion": "v1",
  "timestamp": "2026-08-31T00:00:00.000Z",
  "sessionId": "uuid-here",
  "playerId": "uuid-here",
  "sessionDeleted": false
}
```

`sessionDeleted` is `true` when the leaving player was the final player. Clients
MUST keep local resume credentials and the WebSocket open until this acknowledgement
arrives. A pending leave that receives `SESSION_NOT_FOUND` may be treated as already
complete. A leave timeout MUST preserve credentials for retry.

### 5.4 State Snapshot

```json
{
  "type": "stateSnapshot",
  "protocolVersion": "v1",
  "timestamp": "2026-07-13T12:00:02.000Z",
  "revision": 5,
  "sessionState": <SessionState>
}
```

### 5.5 Action Accepted

```json
{
  "type": "actionAccepted",
  "protocolVersion": "v1",
  "timestamp": "2026-07-13T12:00:03.000Z",
  "actionId": "uuid-here",
  "revision": 6,
  "playerRevision": 2,
  "sessionState": <SessionState>
}
```

### 5.6 Action Rejected

```json
{
  "type": "actionRejected",
  "protocolVersion": "v1",
  "timestamp": "2026-07-13T12:00:03.000Z",
  "actionId": "uuid-here",
  "errors": [
    { "code": "STALE_REVISION", "message": "Revision has changed" }
  ]
}
```

`actionRejected` is used only for mutation requests carrying an `actionId`.
It echoes that `actionId` and uses a mutation error code such as
`STALE_REVISION`, `INVALID_OPERATION`, or `AUTHENTICATION_FAILED`. Lifecycle,
protocol, and connection requests without an `actionId` use the `error`
message instead.

### 5.7 Player Joined

```json
{
  "type": "playerJoined",
  "protocolVersion": "v1",
  "timestamp": "2026-07-13T12:00:04.000Z",
  "playerId": "uuid-here",
  "displayName": "Player1",
  "playerCount": 2
}
```

### 5.8 Player Left

```json
{
  "type": "playerLeft",
  "protocolVersion": "v1",
  "timestamp": "2026-07-13T12:00:05.000Z",
  "playerId": "uuid-here",
  "displayName": "Player1",
  "playerCount": 1
}
```

`playerLeft` is broadcast only after explicit `leaveSession` removes a player.
A transient socket disconnect keeps the player in the session and broadcasts only
a `stateSnapshot` with `connected: false`.

### 5.9 Connection State

```json
{
  "type": "connectionState",
  "protocolVersion": "v1",
  "timestamp": "2026-07-13T12:00:00.000Z",
  "state": "connected",
  "message": null
}
```

Possible `state` values: `"connected"`, `"reconnecting"`, `"disconnected"`.

### 5.10 Pong

```json
{
  "type": "pong",
  "protocolVersion": "v1",
  "timestamp": "2026-07-13T12:00:00.000Z"
}
```

### 5.11 Error

```json
{
  "type": "error",
  "protocolVersion": "v1",
  "timestamp": "2026-07-13T12:00:00.000Z",
  "errors": [
    { "code": "INVALID_MESSAGE", "message": "Message validation failed" }
  ]
}
```

The `errors` field is an array. Each error has `code` (machine-readable) and `message` (human-readable).

The generic `error` message is for protocol/validation and session lifecycle
failures that are not mutation results. Mutation failures MUST use
`actionRejected` when the request contains a valid `actionId`.

---

## 6. Error Codes

| Code | HTTP-like | Client Message Context | Description |
|------|-----------|----------------------|-------------|
| `INVALID_MESSAGE` | 400 | Any | Message structure is invalid (schema violation) |
| `UNSUPPORTED_PROTOCOL_VERSION` | 426 | Any | `protocolVersion` is not `"v1"` |
| `SESSION_NOT_FOUND` | 404 | Any action | Session does not exist |
| `INVALID_JOIN_CODE` | 400 | `joinSession` | Join code is incorrect |
| `PLAYER_NOT_FOUND` | 404 | Any action | Client is not in the session |
| `SESSION_FULL` | 409 | `joinSession` | Session already contains 10 players |
| `ALREADY_JOINED` | 409 | Create, join, resume | This WebSocket is already bound to a player/session |
| `AUTHENTICATION_FAILED` | 401 | Resume, leave, mutation | Resume token is invalid, or connection/session/client identity does not match |
| `NOT_JOINED` | 401 | Leave, mutation | The WebSocket has not joined or resumed a session |
| `SESSION_MISMATCH` | 409 | Leave, mutation | The payload session differs from the WebSocket binding |
| `DUPLICATE_ACTION` | 409 | Mutation actions | An existing `actionId` was reused with a different payload |
| `STALE_REVISION` | 409 | Mutation actions | `expectedRevision` is behind current revision |
| `INVALID_RESOURCE` | 400 | `updateResource`, `updateProduction` | Resource ID is not valid |
| `INVALID_OPERATION` | 400 | `updateResource` | Operation is not `set` or `add` |
| `INVALID_AMOUNT` | 400 | `updateResource` | Amount is out of range (< 0 or too large) |
| `INVALID_PRODUCTION` | 400 | `updateProduction` | Production is out of range |
| `INVALID_TR` | 400 | `updateTR` | TR is out of range (< 0 or > 100) |
| `RATE_LIMITED` | 429 | Any | Client sent too many requests |
| `INTERNAL_ERROR` | 500 | Any | Server-side error |

Each error object has:

| Field | Type | Description |
|-------|------|-------------|
| `code` | string | Machine-readable error code |
| `message` | string | Human-readable description |

### 6.1 Authentication and Connection Binding

- `clientId` and `playerId` are identifiers, not passwords. `clientId` is not
  included in public session snapshots.
- A successful `createSession` or `joinSession` binds that WebSocket connection
  to its `sessionId` and server-selected `playerId`.
- One WebSocket connection can be bound to at most one player/session at a time.
  A bound connection must leave its current session before another create, join,
  or resume request; otherwise the server returns `ALREADY_JOINED`.
- Each player has at most one active WebSocket. A new successful bind for the
  same session and player replaces the older connection; closing that replaced
  connection does not mark the player offline.
- A replaced WebSocket is closed with application close code `4001` and reason
  `Connection replaced`. Clients MUST suppress automatic reconnect for this code,
  but may offer an explicit manual takeover action without deleting credentials.
- `leaveSession` and every mutation use the bound player. A payload `clientId`
  is ignored and cannot select another player.
- Friends resume uses the session-scoped mapping from stable `clientId` to
  `playerId`. Private resume requires `playerId` and `resumeToken`.
- Private resume tokens are returned only in the direct `sessionCreated` and
  `sessionJoined` responses. They MUST NOT appear in `SessionState`, snapshots,
  player broadcasts, or logs.
- A transport disconnect keeps the player identity and credential so that
  `resumeSession` remains possible. Only `leaveSession` removes them.

---

## 7. Revision Specification

### 7.1 Initial Revision

- Initial session and player revisions are **0**.
- Player revision increases only on that player's successful gameplay mutation.
- Session revision is a snapshot version and also changes for presence updates.

### 7.2 Revision Increase Rules

Player revision increases when:
1. A resource is added or subtracted (`updateResource`)
2. Production is updated (`updateProduction`)
3. TR is updated (`updateTR`)
4. Production phase is triggered (`runProduction`)
5. Player state is reset (`resetPlayer`)

Player revision does NOT increase when:
1. `ping` is received (pong response)
2. `createSession` (session creation itself)
3. `joinSession` (joining only adds a player)
4. `leaveSession` (leaving only removes a player)
5. `resumeSession` (resuming only returns snapshot)
6. A rejected action (invalid, stale revision, etc.)

### 7.3 Expected Revision

- Client sends `expectedRevision` with each mutation action
- Server compares with the revision of the player bound to that WebSocket
- If mismatch → `actionRejected` containing `STALE_REVISION`, followed by the latest `stateSnapshot`
- Independent players therefore do not reject each other's actions. The client
  shows the rejection and latest snapshot; it must not silently replay a stale
  user action.

### 7.4 Undo / Redo

Future feature. When implemented:
- Undo/Redo operations will also increase revision
- Stale revision detection applies to all mutations

---

## 8. Action ID Specification

### 8.1 Format

- `actionId` is a **UUID string** (e.g., `"550e8400-e29b-41d4-a716-446655440000"`)
- Generated by the **client** for each mutation request

### 8.2 Deduplication

- Server MUST track all `actionId` values for the session
- If the same `actionId` and payload are received twice, return the cached
  `actionAccepted` result without applying the action again
- If an existing `actionId` is reused with a different payload, return
  `DUPLICATE_ACTION`

### 8.3 Retransmission

- Client may resend the same message with the same `actionId`
- This is the intended retransmission mechanism
- Server returns the same `actionAccepted` result

### 8.4 Retention

- Server retains `actionId` history for a **maximum of 1000 entries** per session
- When limit is exceeded, oldest entries are removed
- Alternatively, entries are removed after **5 minutes** of inactivity

### 8.5 Safety

- `actionId` is only used for **mutation** operations
- `createSession`, `joinSession`, `leaveSession`, `resumeSession`, `ping` do NOT need `actionId`
- `actionId` is included in `actionAccepted` and `actionRejected` responses

---

## 9. Message Exchange Flow

### 9.1 Create Session

```
Client (WebSocket)          Server
        |--- createSession -------->|
        |<-- sessionCreated -------|
        |<-- stateSnapshot -------| (session state for host)
```

### 9.2 Join Session

```
Client A (Host)    Server    Client B (Joiner)
        |                |               |
        |                |--- joinSession->|
        |                |<-- sessionJoined|
        |                |<-- stateSnapshot|
        |<-- playerJoined --|               |
        |                |               |
```

### 9.3 Mutation (Success)

```
Client            Server
    |--- updateResource ------->|
    |<-- actionAccepted --------|
    |<-- stateSnapshot ---------| (broadcast to all clients)
    |<-- playerJoined ---------| (if applicable)
```

### 9.4 Mutation (Stale Revision)

```
Client            Server
    |--- updateResource ------->|
    |<-- actionRejected --------|
    |<-- stateSnapshot ---------| (latest state)
    |--- updateResource (retry) ->|
    |<-- actionAccepted --------|
```

### 9.5 Leave Session

```
Leaving Client       Server       Remaining Clients
      |--- leaveSession --->|              |
      |<-- sessionLeft -----|              |
      |                     |-- playerLeft>|
      |                     |-- snapshot ->|
```

---

## 10. Validation Rules

### 10.1 Message Level

1. `type` must be one of the defined message types
2. `protocolVersion` must be `"v1"` (or the version string defined here)
3. Message body must match the corresponding schema
4. Unknown `type` values are rejected with `INVALID_MESSAGE`

### 10.2 String Constraints

| Field | Constraint |
|-------|-----------|
| `protocolVersion` | Must match `"v1"` exactly |
| `joinCode` | 6 uppercase alphanumeric characters (A-Z, 0-9) |
| `displayName` | 1–20 printable characters |
| `sessionId` | RFC 4122 UUID format |
| `actionId` | RFC 4122 UUID format |
| `clientId` | RFC 4122 UUID format |
| `playerId` | RFC 4122 UUID format |
| `resumeToken` | 32–256 base64url-safe characters (`A-Z`, `a-z`, `0-9`, `_`, `-`) |

### 10.3 Numeric Constraints

| Field | Constraint |
|-------|-----------|
| `revision` | Non-negative integer (≥ 0) |
| `expectedRevision` | Non-negative integer (≥ 0) |
| `tr` | Integer 0–100 |
| `amount` | Integer ≥ 0 (no upper limit for now) |
| `production` | Integer -5–20 for MC; integer 0–20 for every other resource |

After `runProduction`, every resulting resource `amount` remains an integer
greater than or equal to `0`. The server clamps a negative computed result to
`0` before publishing or persisting state.

### 10.4 Array Constraints

| Field | Constraint |
|-------|-----------|
| `resources` (GameState) | Exactly 6 items (MC, Steel, Titanium, Plants, Energy, Heat) |
| `players` (SessionState) | 1–10 players |

---

## 11. Fixture Files

The following fixture files are provided for schema validation testing:

| File | Description |
|------|-------------|
| `protocol/fixtures/game-state.json` | Canonical initial game state |
| `protocol/fixtures/create-session.json` | Create session message |
| `protocol/fixtures/join-session.json` | Join session message |
| `protocol/fixtures/resume-session.json` | Authenticated resume session message |
| `protocol/fixtures/update-resource.json` | Update resource message |
| `protocol/fixtures/update-production.json` | Update production message |
| `protocol/fixtures/update-tr.json` | Update TR message |
| `protocol/fixtures/run-production.json` | Run production message |
| `protocol/fixtures/reset-player.json` | Reset player message |
| `protocol/fixtures/state-snapshot.json` | State snapshot from server |
| `protocol/fixtures/session-joined.json` | Join response carrying the private resume token |
| `protocol/fixtures/session-left.json` | Explicit leave acknowledgement |
| `protocol/fixtures/session-full-error.json` | Full-session lifecycle error |
| `protocol/fixtures/authentication-failed-error.json` | Authentication failure error |
| `protocol/fixtures/stale-revision-error.json` | Stale revision error |
| `protocol/fixtures/invalid-message.json` | Invalid message fixture |

---

## 12. JSON Schema Files

| File | Purpose |
|------|---------|
| `protocol/schemas/game-state.schema.json` | GameState schema |
| `protocol/schemas/session-state.schema.json` | SessionState + PlayerState schema |
| `protocol/schemas/client-message.schema.json` | All client message types |
| `protocol/schemas/server-message.schema.json` | All server message types |

All schemas use **JSON Schema Draft-07**.

---

## 13. Notes

- This protocol is designed to be implementable in both iOS (Swift Codable)
  and Web (TypeScript interfaces)
- No binary encoding, no custom serialization
- WebSocket frames contain exactly one JSON object
- The server is authoritative; clients send actions, not state
