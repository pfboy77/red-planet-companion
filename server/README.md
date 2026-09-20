# Red Planet Server

Install and run this on the computer hosting the game:

```bash
cd server
npm ci
npm start
```

The server listens on port `8080` on the local network. On the host computer,
use `ws://localhost:8080/ws`; other players should replace `localhost` with the
host computer's LAN IP address, for example `ws://192.168.1.20:8080/ws`.

Web and iOS clients save multiple named server profiles. Register this server's
WebSocket URL, select it, and then create or join a game. Every successful action
is committed to SQLite before the authoritative snapshot is broadcast.

## Configuration

The default database is `./data/red-planet.sqlite3` relative to this directory.
Override it for a long-running Linux installation:

```bash
DB_PATH=/var/lib/red-planet/red-planet.sqlite3 npm start
```

Set a public display name without changing the persistent server ID:

```bash
SERVER_NAME="Home Red Planet Server" npm start
```

`HOST` and `PORT` remain configurable; their defaults are `0.0.0.0` and `8080`.
`MAX_SESSIONS` is a positive integer and defaults to `1000`; once reached, new
session creation is rejected until an existing session is explicitly left and
deleted. This bounds persistent database growth. `DB_PATH` must be a normal
filesystem path; SQLite `file:` URI filenames are not supported.

For internet deployment, terminate TLS in a reverse proxy such as Caddy and
register its `wss://` URL in the clients. Also add reverse-proxy connection and
request rate limits, and define an inactive-session retention/cleanup policy;
the session cap limits disk growth but is not a complete public-service DoS
defense.

## Persistence

The SQLite database stores:

- multiplayer sessions and host assignment
- player state and TR
- resource amounts and production
- Friends reconnect identities
- SHA-256 hashes of Private resume tokens
- the latest 1000 processed action IDs per session
- stable server metadata

It does not store raw Private resume tokens or WebSocket connections. All
schema changes run through the `schema_migrations` table at startup. Existing
players are marked disconnected on startup and become connected again only
after a successful resume. A server binary refuses to open a database whose
schema version is newer than the binary supports.

`GET /health` keeps `status: "ok"` and also returns `serverId`, `serverName`, and
`protocolVersion`. It never exposes the database path or credentials.
