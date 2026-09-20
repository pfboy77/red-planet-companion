import { v4 as uuidv4 } from "uuid";

export const resourceIds = ["MC", "Steel", "Titanium", "Plants", "Energy", "Heat"] as const;
export type ResourceId = typeof resourceIds[number];
export type RoomMode = "friends" | "private";
export type ConnectionState = "disconnected" | "connecting" | "joining" | "connected" | "reconnecting";
export type SharedPlayer = { playerId: string; displayName: string; connected: boolean; lastSeenAt: string; revision: number; tr: number; resources: Record<ResourceId, { amount: number; production: number }> };
export type SessionState = { sessionId: string; joinCode: string; roomMode: RoomMode; revision: number; hostPlayerId: string; players: SharedPlayer[] };
export type ServerProfile = { id: string; name: string; webSocketURL: string; createdAt: string; updatedAt: string };
export type ServerRegistry = { profiles: ServerProfile[]; selectedServerId: string | null };
export type ResumeCredentials = { serverUrl: string; serverProfileId?: string; sessionId: string; clientId: string; playerId: string; roomMode: RoomMode; resumeToken?: string };
export const CONNECTION_REPLACED_CLOSE_CODE = 4001;

export function validateWebSocketUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "ws:" || url.protocol === "wss:") && Boolean(url.hostname);
  } catch {
    return false;
  }
}

export function normalizeWebSocketUrl(value: string): string | null {
  if (!validateWebSocketUrl(value.trim())) return null;
  const url = new URL(value.trim());
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  return url.toString();
}

export const serverProfilesKey = "redPlanetServers";
export const selectedServerIdKey = "redPlanetSelectedServerId";
const resumeCredentialsByServerKey = "redPlanetResumeCredentials";
const defaultServerUrl = "ws://localhost:8080/ws";

const validServerProfile = (value: unknown): value is ServerProfile => {
  const profile = value as Partial<ServerProfile> | null;
  return Boolean(profile
    && typeof profile.id === "string"
    && typeof profile.name === "string"
    && profile.name.trim()
    && typeof profile.webSocketURL === "string"
    && normalizeWebSocketUrl(profile.webSocketURL)
    && typeof profile.createdAt === "string"
    && typeof profile.updatedAt === "string");
};

const parseResumeCredentials = (raw: string | null): ResumeCredentials | null => {
  try {
    const value = JSON.parse(raw || "null");
    const valid = value
      && typeof value.serverUrl === "string"
      && validateWebSocketUrl(value.serverUrl)
      && (value.serverProfileId === undefined || typeof value.serverProfileId === "string")
      && typeof value.sessionId === "string"
      && typeof value.clientId === "string"
      && typeof value.playerId === "string"
      && ["friends", "private"].includes(value.roomMode)
      && (value.roomMode === "friends" || typeof value.resumeToken === "string");
    return valid ? value : null;
  } catch {
    return null;
  }
};

export function readServerRegistry(
  storage: Storage = localStorage,
  createId: () => string = id,
  currentDate: () => string = () => new Date().toISOString(),
): ServerRegistry {
  let profiles: ServerProfile[] = [];
  try {
    const saved = JSON.parse(storage.getItem(serverProfilesKey) || "[]");
    if (Array.isArray(saved)) profiles = saved.filter(validServerProfile);
  } catch {
    storage.removeItem(serverProfilesKey);
  }

  if (profiles.length === 0) {
    const resume = parseResumeCredentials(storage.getItem(resumeCredentialsKey));
    const legacyUrl = [storage.getItem("serverUrl"), resume?.serverUrl, defaultServerUrl]
      .find((value): value is string => typeof value === "string" && validateWebSocketUrl(value)) ?? defaultServerUrl;
    const timestamp = currentDate();
    profiles = [{
      id: createId(),
      name: legacyUrl === defaultServerUrl ? "Local Server" : "Migrated Server",
      webSocketURL: normalizeWebSocketUrl(legacyUrl)!,
      createdAt: timestamp,
      updatedAt: timestamp,
    }];
    storage.setItem(serverProfilesKey, JSON.stringify(profiles));
  }

  const savedSelection = storage.getItem(selectedServerIdKey);
  const resume = parseResumeCredentials(storage.getItem(resumeCredentialsKey));
  const matchingResumeProfile = resume
    ? profiles.find((profile) => normalizeWebSocketUrl(profile.webSocketURL) === normalizeWebSocketUrl(resume.serverUrl))
    : undefined;
  const selectedServerId = profiles.some(({ id: profileId }) => profileId === savedSelection)
    ? savedSelection
    : matchingResumeProfile?.id ?? profiles[0]?.id ?? null;
  if (selectedServerId) storage.setItem(selectedServerIdKey, selectedServerId);
  else storage.removeItem(selectedServerIdKey);
  return { profiles, selectedServerId };
}

export function writeServerRegistry(registry: ServerRegistry, storage: Storage = localStorage) {
  storage.setItem(serverProfilesKey, JSON.stringify(registry.profiles));
  if (registry.selectedServerId) storage.setItem(selectedServerIdKey, registry.selectedServerId);
  else storage.removeItem(selectedServerIdKey);
}

export const resumeCredentialsKey = "multiplayerResumeCredentials";
export const id = () => uuidv4();

export function readResumeCredentials(): ResumeCredentials | null {
  const credentials = parseResumeCredentials(localStorage.getItem(resumeCredentialsKey));
  if (!credentials && localStorage.getItem(resumeCredentialsKey)) {
    localStorage.removeItem(resumeCredentialsKey);
  }
  return credentials;
}

export function readResumeCredentialsForServer(profile: ServerProfile): ResumeCredentials | null {
  let storedByServer: ResumeCredentials | null = null;
  try {
    const values = JSON.parse(localStorage.getItem(resumeCredentialsByServerKey) || "{}");
    storedByServer = parseResumeCredentials(JSON.stringify(values?.[profile.id] ?? null));
  } catch {
    localStorage.removeItem(resumeCredentialsByServerKey);
  }
  const credentials = storedByServer ?? readResumeCredentials();
  if (!credentials) return null;
  if (credentials.serverProfileId && credentials.serverProfileId !== profile.id) return null;
  if (normalizeWebSocketUrl(credentials.serverUrl) !== normalizeWebSocketUrl(profile.webSocketURL)) return null;
  if (!credentials.serverProfileId) writeResumeCredentials({ ...credentials, serverProfileId: profile.id });
  return { ...credentials, serverProfileId: profile.id };
}

export function writeResumeCredentials(credentials: ResumeCredentials) {
  localStorage.setItem(resumeCredentialsKey, JSON.stringify(credentials));
  if (!credentials.serverProfileId) return;
  let byServer: Record<string, ResumeCredentials> = {};
  try { byServer = JSON.parse(localStorage.getItem(resumeCredentialsByServerKey) || "{}"); }
  catch { /* Replace corrupt per-server credentials below. */ }
  byServer[credentials.serverProfileId] = credentials;
  localStorage.setItem(resumeCredentialsByServerKey, JSON.stringify(byServer));
}

export function clearResumeCredentials(serverProfileId?: string) {
  const current = readResumeCredentials();
  if (!serverProfileId || !current?.serverProfileId || current.serverProfileId === serverProfileId) {
    localStorage.removeItem(resumeCredentialsKey);
  }
  if (!serverProfileId) {
    localStorage.removeItem(resumeCredentialsByServerKey);
    return;
  }
  try {
    const byServer = JSON.parse(localStorage.getItem(resumeCredentialsByServerKey) || "{}");
    delete byServer[serverProfileId];
    localStorage.setItem(resumeCredentialsByServerKey, JSON.stringify(byServer));
  } catch {
    localStorage.removeItem(resumeCredentialsByServerKey);
  }
}
