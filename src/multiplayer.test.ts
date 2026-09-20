import {
  clearResumeCredentials,
  normalizeWebSocketUrl,
  readResumeCredentialsForServer,
  readServerRegistry,
  resumeCredentialsKey,
  selectedServerIdKey,
  serverProfilesKey,
  ServerProfile,
  writeResumeCredentials,
  writeServerRegistry,
} from "./multiplayer";

beforeEach(() => localStorage.clear());

const profile = (values: Partial<ServerProfile> = {}): ServerProfile => ({
  id: "profile-1",
  name: "Home Server",
  webSocketURL: "wss://mars.example.com/ws",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...values,
});

test("server registry migrates a legacy server URL and remembers its selection", () => {
  localStorage.setItem("serverUrl", "ws://192.168.1.20:8080/ws");
  const registry = readServerRegistry(localStorage, () => "migrated-id", () => "2026-01-01T00:00:00.000Z");

  expect(registry).toEqual({
    profiles: [{
      id: "migrated-id",
      name: "Migrated Server",
      webSocketURL: "ws://192.168.1.20:8080/ws",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }],
    selectedServerId: "migrated-id",
  });
  expect(JSON.parse(localStorage.getItem(serverProfilesKey)!)).toEqual(registry.profiles);
  expect(localStorage.getItem(selectedServerIdKey)).toBe("migrated-id");
});

test("legacy resume credentials select and migrate to their matching profile", () => {
  const other = profile({ id: "other", webSocketURL: "ws://other.local/ws" });
  const matching = profile();
  writeServerRegistry({ profiles: [other, matching], selectedServerId: null });
  localStorage.setItem(resumeCredentialsKey, JSON.stringify({
    serverUrl: matching.webSocketURL,
    sessionId: "session-id",
    clientId: "client-id",
    playerId: "player-id",
    roomMode: "private",
    resumeToken: "secret",
  }));

  const registry = readServerRegistry();
  expect(registry.selectedServerId).toBe(matching.id);
  expect(readResumeCredentialsForServer(matching)).toEqual(expect.objectContaining({ serverProfileId: matching.id }));
  expect(readResumeCredentialsForServer(other)).toBeNull();
});

test("resume credentials are isolated by server profile and URL", () => {
  const home = profile();
  const development = profile({ id: "profile-2", name: "Dev", webSocketURL: "ws://localhost:8080/ws" });
  writeResumeCredentials({
    serverUrl: home.webSocketURL,
    serverProfileId: home.id,
    sessionId: "session-id",
    clientId: "client-id",
    playerId: "player-id",
    roomMode: "friends",
  });

  expect(readResumeCredentialsForServer(home)?.playerId).toBe("player-id");
  expect(readResumeCredentialsForServer(development)).toBeNull();
  expect(readResumeCredentialsForServer({ ...home, webSocketURL: "wss://new.example.com/ws" })).toBeNull();
  clearResumeCredentials(home.id);
  expect(readResumeCredentialsForServer(home)).toBeNull();
});

test.each(["ws://localhost:8080/ws", "WSS://MARS.EXAMPLE.COM/ws"])("normalizes valid WebSocket URL %s", value => {
  expect(normalizeWebSocketUrl(value)).toMatch(/^wss?:\/\//);
});
