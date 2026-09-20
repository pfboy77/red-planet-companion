import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { openDatabase } from "./database.js";
import { ActionRepository } from "./repositories/action-repository.js";
import { PlayerRepository } from "./repositories/player-repository.js";
import { SessionRepository } from "./repositories/session-repository.js";

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

export const hashResumeToken = (token) => createHash("sha256").update(token).digest("hex");

const validToken = (token, storedHash) => {
  if (typeof token !== "string" || typeof storedHash !== "string") return false;
  const actual = Buffer.from(hashResumeToken(token), "hex");
  const expected = Buffer.from(storedHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const fingerprint = (message) => JSON.stringify(Object.fromEntries(
  Object.entries(message)
    .filter(([key]) => key !== "requestId" && key !== "protocolVersion")
    .sort(([left], [right]) => left.localeCompare(right)),
));

class RepositorySessionView {
  constructor(manager) {
    this.manager = manager;
  }

  get size() { return this.manager.sessionRepository.count(); }
  has(sessionId) { return this.manager.sessionRepository.has(sessionId); }
  get(sessionId) { return this.manager.inspectSession(sessionId); }
}

export class SessionManager {
  constructor({ databasePath = ":memory:", serverName } = {}) {
    const opened = openDatabase({ databasePath, serverName });
    this.database = opened.database;
    this.databasePath = opened.databasePath;
    this.serverMetadata = opened.metadata;
    this.sessionRepository = new SessionRepository(this.database);
    this.playerRepository = new PlayerRepository(this.database, RESOURCE_IDS);
    this.actionRepository = new ActionRepository(this.database);
    this.stateProjections = new Map();
    this.sessions = new RepositorySessionView(this);
    this.closed = false;
  }

  createSession({ clientId, displayName, roomMode = "friends" }) {
    if (!validIdentity(clientId, displayName) || !ROOM_MODES.includes(roomMode)) {
      return { error: error("INVALID_MESSAGE", "A valid clientId, displayName, and roomMode are required") };
    }
    const timestamp = now();
    const host = createPlayer(displayName);
    const state = {
      protocolVersion: "v1",
      sessionId: randomUUID(),
      joinCode: joinCode(),
      roomMode,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      hostPlayerId: host.playerId,
      players: [host],
    };
    const resumeToken = roomMode === "private" ? newResumeToken() : undefined;
    this.database.transaction(() => {
      this.sessionRepository.insert(state);
      this.playerRepository.insert(
        state.sessionId,
        host,
        clientId,
        resumeToken ? hashResumeToken(resumeToken) : undefined,
        timestamp,
      );
    })();
    const committed = this.publishState(this.loadState(state.sessionId));
    return { state: committed, player: this.findPlayer(committed, host.playerId), resumeToken };
  }

  join({ sessionId, joinCode: code, clientId, displayName }) {
    if (!validIdentity(clientId, displayName)) {
      return { error: error("INVALID_MESSAGE", "clientId must be a UUID and displayName must contain 1 to 20 characters") };
    }
    const state = this.loadState(sessionId);
    if (!state) return { error: error("SESSION_NOT_FOUND", "Session does not exist") };
    if (state.joinCode !== code) return { error: error("INVALID_JOIN_CODE", "Join code is incorrect") };
    const existingPlayerId = this.playerRepository.findByClient(sessionId, clientId);
    if (existingPlayerId) {
      if (state.roomMode === "private") {
        return { error: error("AUTHENTICATION_FAILED", "Use the private resume token to reconnect this player") };
      }
      this.markConnected(sessionId, existingPlayerId);
      const committed = this.publishState(this.loadState(sessionId));
      return { state: committed, player: this.findPlayer(committed, existingPlayerId), rejoined: true };
    }
    if (state.players.length >= 10) return { error: error("SESSION_FULL", "A session can contain at most 10 players") };

    const timestamp = now();
    const joinedPlayer = createPlayer(displayName);
    const resumeToken = state.roomMode === "private" ? newResumeToken() : undefined;
    this.database.transaction(() => {
      this.playerRepository.insert(
        sessionId,
        joinedPlayer,
        clientId,
        resumeToken ? hashResumeToken(resumeToken) : undefined,
        timestamp,
      );
      this.sessionRepository.touch(sessionId, timestamp);
    })();
    const committed = this.publishState(this.loadState(sessionId));
    return {
      state: committed,
      player: this.findPlayer(committed, joinedPlayer.playerId),
      resumeToken,
      rejoined: false,
    };
  }

  resume({ sessionId, clientId, playerId, resumeToken }) {
    const state = this.loadState(sessionId);
    if (!state) return { error: error("SESSION_NOT_FOUND", "Session does not exist") };
    let authenticatedPlayerId;
    if (state.roomMode === "friends") {
      authenticatedPlayerId = this.playerRepository.findByClient(sessionId, clientId);
      if (!authenticatedPlayerId) return { error: error("PLAYER_NOT_FOUND", "Player is not in this session") };
    } else {
      if (!this.findPlayer(state, playerId)) return { error: error("PLAYER_NOT_FOUND", "Player is not in this session") };
      if (!validToken(resumeToken, this.playerRepository.credentialHash(playerId))) {
        return { error: error("AUTHENTICATION_FAILED", "Resume token is invalid") };
      }
      authenticatedPlayerId = playerId;
    }
    this.markConnected(sessionId, authenticatedPlayerId);
    const committed = this.publishState(this.loadState(sessionId));
    return { state: committed, player: this.findPlayer(committed, authenticatedPlayerId) };
  }

  disconnect(sessionId, playerId) {
    if (!sessionId || !playerId) return undefined;
    const state = this.loadState(sessionId);
    const player = this.findPlayer(state, playerId);
    if (!state || !player || !player.connected) return undefined;
    const timestamp = now();
    this.database.transaction(() => {
      this.playerRepository.setConnected(playerId, false, timestamp);
      this.sessionRepository.touch(sessionId, timestamp);
    })();
    const committed = this.publishState(this.loadState(sessionId));
    return { state: committed, player: this.findPlayer(committed, playerId) };
  }

  leave(sessionId, playerId) {
    const state = this.loadState(sessionId);
    const player = this.findPlayer(state, playerId);
    if (!state || !player) return undefined;
    let sessionDeleted = false;
    this.database.transaction(() => {
      if (state.players.length === 1) {
        this.sessionRepository.delete(sessionId);
        sessionDeleted = true;
        return;
      }
      this.playerRepository.delete(playerId);
      const nextHost = state.hostPlayerId === playerId
        ? this.playerRepository.firstPlayerId(sessionId)
        : undefined;
      this.sessionRepository.touch(sessionId, now(), nextHost);
    })();

    if (sessionDeleted) {
      this.stateProjections.delete(sessionId);
      return { player, sessionDeleted: true };
    }
    const committed = this.publishState(this.loadState(sessionId));
    return { state: committed, player, sessionDeleted: false };
  }

  mutate(message, authenticatedPlayerId) {
    const state = this.loadState(message.sessionId);
    if (!state) return { error: error("SESSION_NOT_FOUND", "Session does not exist") };
    const player = this.findPlayer(state, authenticatedPlayerId);
    if (!player) return { error: error("PLAYER_NOT_FOUND", "The bound player is not in this session") };
    if (!isUUID(message.actionId) || !Number.isSafeInteger(message.expectedRevision) || message.expectedRevision < 0) {
      return { error: error("INVALID_MESSAGE", "actionId must be a UUID and expectedRevision must be a non-negative safe integer") };
    }
    const actionFingerprint = fingerprint(message);
    const previous = this.actionRepository.find(message.sessionId, message.actionId);
    if (previous) {
      const committed = this.publishState(state);
      const committedPlayer = this.findPlayer(committed, authenticatedPlayerId);
      if (previous.playerId === authenticatedPlayerId && previous.fingerprint === actionFingerprint) {
        return { state: committed, player: committedPlayer, actionId: message.actionId, duplicate: true };
      }
      return { error: error("DUPLICATE_ACTION", "actionId was already used for another action"), state: committed };
    }
    if (message.expectedRevision !== player.revision) {
      return { error: error("STALE_REVISION", "Player revision has changed"), state: this.publishState(state) };
    }
    const result = this.apply(player, message);
    if (result.error) return { ...result, state: this.publishState(state) };

    const timestamp = now();
    player.revision += 1;
    player.lastSeenAt = timestamp;
    this.database.transaction(() => {
      this.playerRepository.update(player);
      this.sessionRepository.touch(message.sessionId, timestamp);
      this.actionRepository.insert(message.sessionId, message.actionId, authenticatedPlayerId, actionFingerprint, timestamp);
      this.actionRepository.prune(message.sessionId);
    })();
    const committed = this.publishState(this.loadState(message.sessionId));
    return {
      state: committed,
      player: this.findPlayer(committed, authenticatedPlayerId),
      actionId: message.actionId,
    };
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
      if (!Number.isSafeInteger(message.production) || message.production < minimum || message.production > 20) {
        return { error: error("INVALID_PRODUCTION", "Production is out of range") };
      }
      player.resources[message.resourceId].production = message.production;
    } else if (message.type === "updateTR") {
      if (!Number.isSafeInteger(message.tr) || message.tr < 0 || message.tr > 100) {
        return { error: error("INVALID_TR", "TR must be between 0 and 100") };
      }
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

  loadState(sessionId) {
    const session = this.sessionRepository.find(sessionId);
    if (!session) return undefined;
    return { protocolVersion: "v1", ...session, players: this.playerRepository.list(sessionId) };
  }

  publishState(next) {
    if (!next) return undefined;
    const existing = this.stateProjections.get(next.sessionId);
    if (!existing) {
      this.stateProjections.set(next.sessionId, next);
      return next;
    }
    const existingPlayers = new Map(existing.players.map((player) => [player.playerId, player]));
    Object.assign(existing, next);
    existing.players = next.players.map((nextPlayer) => {
      const current = existingPlayers.get(nextPlayer.playerId);
      if (!current) return nextPlayer;
      const currentResources = current.resources;
      Object.assign(current, nextPlayer);
      current.resources = Object.fromEntries(RESOURCE_IDS.map((resourceId) => {
        const resource = currentResources[resourceId] ?? {};
        Object.assign(resource, nextPlayer.resources[resourceId]);
        return [resourceId, resource];
      }));
      return current;
    });
    return existing;
  }

  inspectSession(sessionId) {
    const state = this.publishState(this.loadState(sessionId));
    if (!state) return undefined;
    return {
      state,
      clientPlayers: this.playerRepository.clientPlayers(sessionId),
      credentials: this.playerRepository.credentials(sessionId),
      actions: this.actionRepository.all(sessionId),
    };
  }

  findPlayer(state, playerId) {
    return state?.players.find((player) => player.playerId === playerId);
  }

  markConnected(sessionId, playerId) {
    const timestamp = now();
    this.database.transaction(() => {
      this.playerRepository.setConnected(playerId, true, timestamp);
      this.sessionRepository.touch(sessionId, timestamp);
    })();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stateProjections.clear();
    this.database.close();
  }
}
