# Red Planet local server

Run this on the computer hosting the game:

```bash
cd server
npm start
```

The server listens on port `8080` on the local network. On the host computer,
use `ws://localhost:8080/ws`; other players should replace `localhost` with the
host computer's LAN IP address, for example `ws://192.168.1.20:8080/ws`.

Open the web app on each device, enter a name and the server URL, then have one
player create a game. Share both the displayed session ID and six-character
code; the other players use them to join. Every successful action is broadcast
as the authoritative session snapshot, so the “Other players’ resources” panel
updates immediately.

`GET /health` returns `{ "status": "ok" }` for a basic health check.
