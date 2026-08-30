import { v4 as uuidv4 } from "uuid";

export const resourceIds = ["MC", "Steel", "Titanium", "Plants", "Energy", "Heat"] as const;
export type ResourceId = typeof resourceIds[number];
export type RoomMode = "friends" | "private";
export type ConnectionState = "disconnected" | "connecting" | "joining" | "connected" | "reconnecting";
export type SharedPlayer = { playerId: string; displayName: string; connected: boolean; lastSeenAt: string; revision: number; tr: number; resources: Record<ResourceId, { amount: number; production: number }> };
export type SessionState = { sessionId: string; joinCode: string; roomMode: RoomMode; revision: number; hostPlayerId: string; players: SharedPlayer[] };
export type ResumeCredentials = { serverUrl: string; sessionId: string; clientId: string; playerId: string; roomMode: RoomMode; resumeToken?: string };
export const resumeCredentialsKey = "multiplayerResumeCredentials";
export const id = () => uuidv4();

export function readResumeCredentials(): ResumeCredentials | null {
  try {
    const value = JSON.parse(localStorage.getItem(resumeCredentialsKey) || "null");
    const valid = value
      && typeof value.serverUrl === "string"
      && typeof value.sessionId === "string"
      && typeof value.clientId === "string"
      && typeof value.playerId === "string"
      && ["friends", "private"].includes(value.roomMode)
      && (value.roomMode === "friends" || typeof value.resumeToken === "string");
    return valid ? value : null;
  } catch {
    localStorage.removeItem(resumeCredentialsKey);
    return null;
  }
}

export function writeResumeCredentials(credentials: ResumeCredentials) {
  localStorage.setItem(resumeCredentialsKey, JSON.stringify(credentials));
}

export function clearResumeCredentials() {
  localStorage.removeItem(resumeCredentialsKey);
}
