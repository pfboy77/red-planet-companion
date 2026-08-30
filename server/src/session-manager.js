import { randomBytes, randomUUID } from "node:crypto";

export const RESOURCE_IDS = ["MC", "Steel", "Titanium", "Plants", "Energy", "Heat"];
export const ROOM_MODES = ["friends", "private"];

const now = () => new Date().toISOString();
const resources = () => Object.fromEntries(RESOURCE_IDS.map((id) => [id, { amount: 0, production: 0 }]));
const joinCode = () => Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
const newResumeToken = () => randomBytes(32).toString("base64url");
const error = (code, message) => ({ code, message });
const isUUID = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const validIdentity = (clientId, displayName) => isUUID(clientId)
  && typeof displayName === "string"
  && displayName.trim().length >= 1
  && displayName.trim().length <= 20;
const createPlayer = (displayName) => ({
  playerId: randomUUID(),
  displayName: displayName.trim(),
  connected: true,
  lastSeenAt: now(),
  revision: 0,
  tr: 20,
  resources: resources(),
});

export class SessionManager {
  constructor() { this.sessions = new Map(); }

  createSession({ clientId, displayName, roomMode = "friends" }) {
    if (!validIdentity(clientId, displayName) || !ROOM_MODES.includes(roomMode)) {
      return { error: error("INVALID_MESSAGE", "A valid clientId, displayName, and roomMode are required") };
    }
    const timestamp = now();
    const host = createPlayer(displayName);
    const state = {
      protocolVersion: "v1", sessionId: randomUUID(), joinCode: joinCode(), roomMode,
      revision: 0, createdAt: timestamp, updatedAt: timestamp, hostPlayerId: host.playerId, players: [host],
    };
    const session = {
      state, actions: new Map(), clientPlayers: new Map([[clientId, host.playerId]]), credentials: new Map(),
    };
    const resumeToken = roomMode === "private" ? newResumeToken() : undefined;
    if (resumeToken) session.credentials.set(host.playerId, resumeToken);
    this.sessions.set(state.sessionId, session);
    return { state, player: host, resumeToken };
  }

  join({ sessionId, joinCode: code, clientId, displayName }) {
    if (!validIdentity(clientId, displayName)) return { error: error("INVALID_MESSAGE", "clientId must be a UUID and displayName must contain 1 to 20 characters") };
    const session = this.sessions.get(sessionId);
    if (!session) return { error: error("SESSION_NOT_FOUND", "Session does not exist") };
    if (session.state.joinCode !== code) return { error: error("INVALID_JOIN_CODE", "Join code is incorrect") };
    const existingPlayerId = session.clientPlayers.get(clientId);
    if (existingPlayerId) {
      if (session.state.roomMode === "private") return { error: error("AUTHENTICATION_FAILED", "Use the private resume token to reconnect this player") };
      const existing = this.findPlayer(session, existingPlayerId);
      this.markConnected(session, existing);
      return { state: session.state, player: existing, rejoined: true };
    }
    if (session.state.players.length >= 10) return { error: error("SESSION_FULL", "A session can contain at most 10 players") };
    const joinedPlayer = createPlayer(displayName);
    session.state.players.push(joinedPlayer);
    session.clientPlayers.set(clientId, joinedPlayer.playerId);
    const resumeToken = session.state.roomMode === "private" ? newResumeToken() : undefined;
    if (resumeToken) session.credentials.set(joinedPlayer.playerId, resumeToken);
    this.touchSession(session);
    return { state: session.state, player: joinedPlayer, resumeToken, rejoined: false };
  }

  resume({ sessionId, clientId, playerId, resumeToken }) {
    const session = this.sessions.get(sessionId);
    if (!session) return { error: error("SESSION_NOT_FOUND", "Session does not exist") };
    let authenticatedPlayerId;
    if (session.state.roomMode === "friends") {
      authenticatedPlayerId = session.clientPlayers.get(clientId);
      if (!authenticatedPlayerId) return { error: error("PLAYER_NOT_FOUND", "Player is not in this session") };
    } else {
      if (!playerId || !resumeToken || session.credentials.get(playerId) !== resumeToken) return { error: error("AUTHENTICATION_FAILED", "Resume token is invalid") };
      authenticatedPlayerId = playerId;
    }
    const player = this.findPlayer(session, authenticatedPlayerId);
    if (!player) return { error: error("PLAYER_NOT_FOUND", "Player is not in this session") };
    this.markConnected(session, player);
    return { state: session.state, player };
  }

  disconnect(sessionId, playerId) {
    const session = this.sessions.get(sessionId);
    const player = this.findPlayer(session, playerId);
    if (!session || !player || !player.connected) return undefined;
    player.connected = false;
    player.lastSeenAt = now();
    this.touchSession(session);
    return { state: session.state, player };
  }

  leave(sessionId, playerId) {
    const session = this.sessions.get(sessionId);
    const playerIndex = session?.state.players.findIndex((player) => player.playerId === playerId) ?? -1;
    if (!session || playerIndex < 0) return undefined;

    const [player] = session.state.players.splice(playerIndex, 1);
    for (const [clientId, mappedPlayerId] of session.clientPlayers) {
      if (mappedPlayerId === playerId) session.clientPlayers.delete(clientId);
    }
    session.credentials.delete(playerId);
    for (const [actionId, action] of session.actions) {
      if (action.playerId === playerId) session.actions.delete(actionId);
    }

    if (session.state.players.length === 0) {
      this.sessions.delete(sessionId);
      return { player, sessionDeleted: true };
    }
    if (session.state.hostPlayerId === playerId) session.state.hostPlayerId = session.state.players[0].playerId;
    this.touchSession(session);
    return { state: session.state, player, sessionDeleted: false };
  }

  mutate(message, authenticatedPlayerId) {
    const session = this.sessions.get(message.sessionId);
    if (!session) return { error: error("SESSION_NOT_FOUND", "Session does not exist") };
    const player = this.findPlayer(session, authenticatedPlayerId);
    if (!player) return { error: error("PLAYER_NOT_FOUND", "The bound player is not in this session") };
    if (!isUUID(message.actionId) || !Number.isSafeInteger(message.expectedRevision) || message.expectedRevision < 0) {
      return { error: error("INVALID_MESSAGE", "actionId must be a UUID and expectedRevision must be a non-negative safe integer") };
    }
    const fingerprint = JSON.stringify(message);
    const previous = session.actions.get(message.actionId);
    if (previous) {
      if (previous.playerId === authenticatedPlayerId && previous.fingerprint === fingerprint) return { state: session.state, player, actionId: message.actionId, duplicate: true };
      return { error: error("DUPLICATE_ACTION", "actionId was already used for another action"), state: session.state };
    }
    if (message.expectedRevision !== player.revision) return { error: error("STALE_REVISION", "Player revision has changed"), state: session.state };
    const result = this.apply(player, message);
    if (result.error) return { ...result, state: session.state };
    player.revision += 1;
    player.lastSeenAt = now();
    this.touchSession(session);
    session.actions.set(message.actionId, { playerId: authenticatedPlayerId, fingerprint });
    if (session.actions.size > 1000) session.actions.delete(session.actions.keys().next().value);
    return { state: session.state, player, actionId: message.actionId };
  }

  apply(player, message) {
    if (message.type === "updateResource") {
      if (!RESOURCE_IDS.includes(message.resourceId)) return { error: error("INVALID_RESOURCE", "Resource ID is not valid") };
      if (!["add", "set"].includes(message.operation)) return { error: error("INVALID_OPERATION", "Operation must be add or set") };
      if (!Number.isSafeInteger(message.amount) || message.amount < 0) return { error: error("INVALID_AMOUNT", "Amount must be a non-negative safe integer") };
      const resource = player.resources[message.resourceId];
      const amount = message.operation === "add" ? resource.amount + message.amount : message.amount;
      if (!Number.isSafeInteger(amount)) return { error: error("INVALID_AMOUNT", "Amount is too large") };
      resource.amount = amount;
    } else if (message.type === "updateProduction") {
      if (!RESOURCE_IDS.includes(message.resourceId)) return { error: error("INVALID_RESOURCE", "Resource ID is not valid") };
      const minimum = message.resourceId === "MC" ? -5 : 0;
      if (!Number.isSafeInteger(message.production) || message.production < minimum || message.production > 20) return { error: error("INVALID_PRODUCTION", "Production is out of range") };
      player.resources[message.resourceId].production = message.production;
    } else if (message.type === "updateTR") {
      if (!Number.isSafeInteger(message.tr) || message.tr < 0 || message.tr > 100) return { error: error("INVALID_TR", "TR must be between 0 and 100") };
      player.tr = message.tr;
    } else if (message.type === "runProduction") {
      const nextAmounts = Object.fromEntries(RESOURCE_IDS.map((id) => [id, player.resources[id].amount]));
      nextAmounts.Heat += nextAmounts.Energy;
      nextAmounts.Energy = 0;
      for (const id of RESOURCE_IDS) {
        nextAmounts[id] = Math.max(0, nextAmounts[id] + player.resources[id].production + (id === "MC" ? player.tr : 0));
        if (!Number.isSafeInteger(nextAmounts[id])) return { error: error("INVALID_AMOUNT", "Production result is too large") };
      }
      for (const id of RESOURCE_IDS) player.resources[id].amount = nextAmounts[id];
    } else if (message.type === "resetPlayer") {
      player.tr = 20;
      player.resources = resources();
    } else return { error: error("INVALID_MESSAGE", "Unsupported action") };
    return {};
  }

  findPlayer(session, playerId) { return session?.state.players.find((player) => player.playerId === playerId); }
  markConnected(session, player) { player.connected = true; player.lastSeenAt = now(); this.touchSession(session); }
  touchSession(session) { session.state.revision += 1; session.state.updatedAt = now(); }
}
