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
session creation is rejected until an existing session is explicitly left or
expired sessions are cleaned. This bounds persistent database growth. `DB_PATH` must be a normal
filesystem path; SQLite `file:` URI filenames are not supported.

## Internet deployment

Direct internet exposure of the Node process is **not recommended**. This server
is not a production anti-DDoS platform. Bind Node to loopback or a private network,
terminate TLS at a reverse proxy, and expose only its `wss://` endpoint. `ws://`
is intended for trusted local networks. Configure connection-count limits,
connection/request rates and WebSocket message rates at the proxy; limit unauthenticated
connections too. Use firewall/network controls and maintain the runtime and proxy.
`MAX_SESSIONS` and the 64 KiB message limit do not replace these controls.
Keep consistent SQLite backups (including WAL state, using SQLite backup tooling)
if persistent games matter; define access controls and retention for backups and
proxy logs. Never log raw private resume tokens or full authentication messages.

## Inactive-session retention

`SESSION_RETENTION_DAYS` defaults to **30**. It accepts an integer from 0 to 36500;
0 disables cleanup. Empty, fractional, negative and invalid values fail startup
with a configuration error. Example: `SESSION_RETENTION_DAYS=7 npm start`.

Cleanup runs at startup and before each valid session creation, including when
capacity has been reached. Sessions with `updated_at` strictly older than the
cutoff are removed only if no player is currently connected. Startup first marks
all old connections disconnected. Foreign-key cascades remove players, resources,
client associations, credential hashes and action history. Live state projections
are also removed. Recent sessions and sessions exactly at the cutoff remain.
There is no periodic timer, so shutdown has no cleanup timer to leak. On an idle
server with no new sessions, expired data remains until the next startup or create.

This retention limits accumulation; it is not a guarantee of deletion at an exact
time. Active sessions and sessions whose activity updates `updated_at` are retained.
Disabling cleanup keeps data until explicit leave or operator maintenance. Backups
and reverse-proxy logs require their own deletion policy. Device-local deletion
does not delete server data. Publish your operator-specific retention/privacy policy.

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
