import { randomUUID } from "node:crypto";

export const RESOURCE_IDS = ["MC", "Steel", "Titanium", "Plants", "Energy", "Heat"];

const now = () => new Date().toISOString();
const resources = () => Object.fromEntries(RESOURCE_IDS.map((id) => [id, { amount: 0, production: 0 }]));
const joinCode = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const error = (code, message) => ({ code, message });

export class SessionManager {
  constructor() { this.sessions = new Map(); }

  createSession() {
    const timestamp = now();
    const state = { protocolVersion: "v1", sessionId: randomUUID(), joinCode: joinCode(), revision: 0, createdAt: timestamp, updatedAt: timestamp, hostClientId: "", players: [] };
    this.sessions.set(state.sessionId, { state, actions: new Map() });
    return state;
  }

  join({ sessionId, joinCode: code, clientId, displayName }) {
    const session = this.sessions.get(sessionId);
    if (!session) return { error: error("SESSION_NOT_FOUND", "Session does not exist") };
    if (session.state.joinCode !== code) return { error: error("INVALID_JOIN_CODE", "Join code is incorrect") };
    const existing = session.state.players.find((player) => player.clientId === clientId);
    if (existing) { existing.connected = true; existing.lastSeenAt = now(); return { state: session.state, player: existing, rejoined: true }; }
    if (session.state.players.length >= 10) return { error: error("SESSION_FULL", "A session can contain at most 10 players") };
    const player = { playerId: randomUUID(), clientId, displayName: displayName.trim(), connected: true, lastSeenAt: now(), tr: 20, resources: resources() };
    session.state.players.push(player);
    if (!session.state.hostClientId) session.state.hostClientId = clientId;
    session.state.updatedAt = now();
    return { state: session.state, player, rejoined: false };
  }

  resume({ sessionId, clientId }) {
    const session = this.sessions.get(sessionId);
    const player = session?.state.players.find((item) => item.clientId === clientId);
    if (!player) return { error: error("PLAYER_NOT_FOUND", "Player is not in this session") };
    player.connected = true; player.lastSeenAt = now();
    return { state: session.state, player };
  }

  disconnect(sessionId, clientId) {
    const player = this.sessions.get(sessionId)?.state.players.find((item) => item.clientId === clientId);
    if (player) { player.connected = false; player.lastSeenAt = now(); return { state: this.sessions.get(sessionId).state, player }; }
    return undefined;
  }

  mutate(message) {
    const session = this.sessions.get(message.sessionId);
    if (!session) return { error: error("SESSION_NOT_FOUND", "Session does not exist") };
    const player = session.state.players.find((item) => item.clientId === message.clientId);
    if (!player) return { error: error("PLAYER_NOT_FOUND", "Player is not in this session") };
    const fingerprint = JSON.stringify(message);
    const previous = session.actions.get(message.actionId);
    if (previous) return previous.fingerprint === fingerprint ? previous.result : { error: error("DUPLICATE_ACTION", "actionId was already used for another action") };
    if (message.expectedRevision !== session.state.revision) return { error: error("STALE_REVISION", "Revision has changed"), state: session.state };
    const result = this.apply(player, message);
    if (result.error) return result;
    session.state.revision += 1; session.state.updatedAt = now(); player.lastSeenAt = session.state.updatedAt;
    const accepted = { state: session.state, actionId: message.actionId };
    session.actions.set(message.actionId, { fingerprint, result: accepted });
    if (session.actions.size > 1000) session.actions.delete(session.actions.keys().next().value);
    return accepted;
  }

  apply(player, message) {
    if (message.type === "updateResource") {
      if (!RESOURCE_IDS.includes(message.resourceId) || !Number.isInteger(message.amount) || message.amount < 0) return { error: error("INVALID_AMOUNT", "Amount must be a non-negative integer") };
      const resource = player.resources[message.resourceId];
      const amount = message.operation === "add" ? resource.amount + message.amount : message.amount;
      if (!Number.isSafeInteger(amount)) return { error: error("INVALID_AMOUNT", "Amount is too large") };
      resource.amount = amount;
    } else if (message.type === "updateProduction") {
      const minimum = message.resourceId === "MC" ? -5 : 0;
      if (!RESOURCE_IDS.includes(message.resourceId) || !Number.isInteger(message.production) || message.production < minimum || message.production > 20) return { error: error("INVALID_PRODUCTION", "Production is out of range") };
      player.resources[message.resourceId].production = message.production;
    } else if (message.type === "updateTR") {
      if (!Number.isInteger(message.tr) || message.tr < 0 || message.tr > 100) return { error: error("INVALID_TR", "TR must be between 0 and 100") };
      player.tr = message.tr;
    } else if (message.type === "runProduction") {
      player.resources.Heat.amount += player.resources.Energy.amount;
      player.resources.Energy.amount = 0;
      for (const id of RESOURCE_IDS) player.resources[id].amount += player.resources[id].production + (id === "MC" ? player.tr : 0);
    } else if (message.type === "resetPlayer") {
      player.tr = 20; player.resources = resources();
    } else return { error: error("INVALID_MESSAGE", "Unsupported action") };
    return {};
  }
}
