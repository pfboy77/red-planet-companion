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
For internet deployment, terminate TLS in a reverse proxy such as Caddy and
register its `wss://` URL in the clients.

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
after a successful resume.

`GET /health` keeps `status: "ok"` and also returns `serverId`, `serverName`, and
`protocolVersion`. It never exposes the database path or credentials.
