import { v4 as uuidv4 } from "uuid";

export const resourceIds = ["MC", "Steel", "Titanium", "Plants", "Energy", "Heat"] as const;
export type ResourceId = typeof resourceIds[number];
export type SharedPlayer = { playerId: string; clientId: string; displayName: string; connected: boolean; lastSeenAt: string; tr: number; resources: Record<ResourceId, { amount: number; production: number }> };
export type SessionState = { sessionId: string; joinCode: string; revision: number; players: SharedPlayer[] };
export const id = () => uuidv4();
