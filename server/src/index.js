import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { peerAuthorizationError } from "./peer-authorization.js";
import { SessionManager } from "./session-manager.js";
import { formatClientMessageValidationError, mutationTypes, validateClientMessage } from "./validator.js";

const timestamped = (message) => ({ protocolVersion: "v1", timestamp: new Date().toISOString(), ...message });
export const CONNECTION_REPLACED_CLOSE_CODE = 4001;

export function createLocalServer({ manager = new SessionManager() } = {}) {
  const peers = new Set();
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const send = (peer, message) => {
    if (peer.socket.readyState === WebSocket.OPEN) peer.socket.send(JSON.stringify(timestamped(message)));
  };
  const snapshot = (state) => ({ type: "stateSnapshot", revision: state.revision, sessionState: state });
  const broadcast = (state, message = snapshot(state)) => {
    for (const peer of peers) if (peer.sessionId === state.sessionId) send(peer, message);
  };
  const reject = (peer, errors) => send(peer, { type: "error", errors: Array.isArray(errors) ? errors : [errors] });
  const rejectAction = (peer, actionId, errors) => send(peer, { type: "actionRejected", actionId, errors: Array.isArray(errors) ? errors : [errors] });

  const bindPeer = (peer, result, clientId) => {
    peer.sessionId = result.state.sessionId;
    peer.playerId = result.player.playerId;
    peer.clientId = clientId;
    peer.replaced = false;
    for (const existingPeer of peers) {
      if (existingPeer === peer
        || existingPeer.sessionId !== peer.sessionId
        || existingPeer.playerId !== peer.playerId) continue;
      existingPeer.replaced = true;
      existingPeer.socket.close(CONNECTION_REPLACED_CLOSE_CODE, "Connection replaced");
    }
  };
  const isUUID = (value) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

  const handle = (peer, message) => {
    if (peer.replaced) return undefined;
    if (!validateClientMessage(message)) {
      const validationError = formatClientMessageValidationError();
      if (mutationTypes.has(message?.type) && isUUID(message.actionId)) return rejectAction(peer, message.actionId, validationError);
      return reject(peer, validationError);
    }
    if (message.type === "ping") return send(peer, { type: "pong" });

    if (message.type === "createSession") {
      const result = manager.createSession(message);
      if (result.error) return reject(peer, result.error);
      bindPeer(peer, result, message.clientId);
      return send(peer, {
        type: "sessionCreated",
        sessionId: result.state.sessionId,
        joinCode: result.state.joinCode,
        roomMode: result.state.roomMode,
        hostPlayerId: result.state.hostPlayerId,
        playerId: result.player.playerId,
        ...(result.resumeToken ? { resumeToken: result.resumeToken } : {}),
        sessionState: result.state,
      });
    }

    if (message.type === "joinSession") {
      const result = manager.join(message);
      if (result.error) return reject(peer, result.error);
      bindPeer(peer, result, message.clientId);
      send(peer, {
        type: "sessionJoined",
        sessionId: result.state.sessionId,
        playerId: result.player.playerId,
        playerIndex: result.state.players.indexOf(result.player),
        roomMode: result.state.roomMode,
        ...(result.resumeToken ? { resumeToken: result.resumeToken } : {}),
      });
      broadcast(result.state, { type: "playerJoined", playerId: result.player.playerId, displayName: result.player.displayName, playerCount: result.state.players.length });
      return broadcast(result.state);
    }

    if (message.type === "resumeSession") {
      const result = manager.resume(message);
      if (result.error) return reject(peer, result.error);
      bindPeer(peer, result, message.clientId);
      return broadcast(result.state);
    }

    if (message.type === "leaveSession") {
      const authorizationError = peerAuthorizationError(peer, message);
      if (authorizationError) return reject(peer, authorizationError);
      const sessionId = peer.sessionId;
      const playerId = peer.playerId;
      const result = manager.leave(sessionId, playerId);
      if (!result) return reject(peer, { code: "PLAYER_NOT_FOUND", message: "The bound player is not in this session" });
      send(peer, {
        type: "sessionLeft",
        sessionId,
        playerId,
        sessionDeleted: result.sessionDeleted === true,
      });
      peer.sessionId = undefined;
      peer.playerId = undefined;
      peer.clientId = undefined;
      if (result?.state) {
        broadcast(result.state, { type: "playerLeft", playerId: result.player.playerId, displayName: result.player.displayName, playerCount: result.state.players.length });
        broadcast(result.state);
      }
      return undefined;
    }

    if (mutationTypes.has(message.type)) {
      const authorizationError = peerAuthorizationError(peer, message);
      if (authorizationError) return rejectAction(peer, message.actionId, authorizationError);
      const result = manager.mutate(message, peer.playerId);
      if (result.error) {
        rejectAction(peer, message.actionId, result.error);
        if (result.state) send(peer, snapshot(result.state));
        return undefined;
      }
      return broadcast(result.state, {
        type: "actionAccepted",
        actionId: result.actionId,
        revision: result.state.revision,
        playerRevision: result.player.revision,
        sessionState: result.state,
      });
    }
    return reject(peer, { code: "INVALID_MESSAGE", message: "Unsupported message type" });
  };

  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => webSocketServer.emit("connection", webSocket, request));
  });

  webSocketServer.on("connection", (socket) => {
    const peer = { socket };
    peers.add(peer);
    send(peer, { type: "connectionState", state: "connected", message: null });
    socket.on("message", (payload, isBinary) => {
      if (isBinary) return reject(peer, { code: "INVALID_MESSAGE", message: "Messages must be UTF-8 JSON text" });
      let message;
      try {
        message = JSON.parse(payload.toString("utf8"));
      } catch {
        return reject(peer, { code: "INVALID_MESSAGE", message: "Message must be valid JSON" });
      }
      try {
        return handle(peer, message);
      } catch {
        return reject(peer, { code: "INTERNAL_ERROR", message: "The server could not process this request" });
      }
    });
    socket.on("close", () => {
      peers.delete(peer);
      if (peer.replaced) return;
      const result = manager.disconnect(peer.sessionId, peer.playerId);
      if (result) {
        broadcast(result.state);
      }
    });
    socket.on("error", () => undefined);
  });

  return { server, webSocketServer, manager, peers };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const port = Number(process.env.PORT || 8080);
  const host = process.env.HOST || "0.0.0.0";
  const { server } = createLocalServer();
  server.listen(port, host, () => console.log(`Red Planet local server listening on ws://${host}:${port}/ws`));
}
