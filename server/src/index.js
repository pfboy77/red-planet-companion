import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { SessionManager } from "./session-manager.js";

const manager = new SessionManager();
const peers = new Set();
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || "0.0.0.0";
const timestamped = (message) => ({ protocolVersion: "v1", timestamp: new Date().toISOString(), ...message });

function send(peer, message) {
  const body = Buffer.from(JSON.stringify(timestamped(message)));
  if (body.length > 65535) throw new Error("Message exceeds WebSocket frame limit");
  const header = body.length < 126 ? Buffer.from([0x81, body.length]) : Buffer.from([0x81, 126, body.length >> 8, body.length & 255]);
  peer.socket.write(Buffer.concat([header, body]));
}
function snapshot(state) { return { type: "stateSnapshot", revision: state.revision, sessionState: state }; }
function broadcast(state, message = snapshot(state)) { for (const peer of peers) if (peer.sessionId === state.sessionId) send(peer, message); }
function reject(peer, errors) { send(peer, { type: "error", errors: Array.isArray(errors) ? errors : [errors] }); }

function handle(peer, message) {
  if (!message || message.protocolVersion !== "v1" || typeof message.type !== "string") return reject(peer, { code: "INVALID_MESSAGE", message: "A v1 message type is required" });
  if (message.type === "ping") return send(peer, { type: "pong" });
  if (message.type === "createSession") {
    const state = manager.createSession();
    return send(peer, { type: "sessionCreated", sessionId: state.sessionId, joinCode: state.joinCode, hostClientId: "", sessionState: state });
  }
  if (message.type === "joinSession") {
    if (!message.clientId || !message.displayName?.trim()) return reject(peer, { code: "INVALID_MESSAGE", message: "clientId and displayName are required" });
    const result = manager.join(message); if (result.error) return reject(peer, result.error);
    peer.sessionId = result.state.sessionId; peer.clientId = message.clientId;
    send(peer, { type: "sessionJoined", sessionId: result.state.sessionId, playerId: result.player.playerId, playerIndex: result.state.players.indexOf(result.player) });
    broadcast(result.state, { type: "playerJoined", playerId: result.player.playerId, displayName: result.player.displayName, playerCount: result.state.players.length });
    return broadcast(result.state);
  }
  if (message.type === "resumeSession") {
    const result = manager.resume(message); if (result.error) return reject(peer, result.error);
    peer.sessionId = message.sessionId; peer.clientId = message.clientId; return send(peer, snapshot(result.state));
  }
  if (message.type === "leaveSession") {
    const result = manager.disconnect(message.sessionId, message.clientId);
    peer.sessionId = undefined;
    if (result) broadcast(result.state, { type: "playerLeft", playerId: result.player.playerId, displayName: result.player.displayName, playerCount: result.state.players.length });
    if (result) broadcast(result.state);
    return;
  }
  const result = manager.mutate(message);
  if (result.error) { reject(peer, result.error); if (result.state) send(peer, snapshot(result.state)); return; }
  broadcast(result.state, { type: "actionAccepted", actionId: result.actionId, revision: result.state.revision, sessionState: result.state });
}

function parseFrames(peer, chunk) {
  peer.buffer = Buffer.concat([peer.buffer, chunk]);
  while (peer.buffer.length >= 2) {
    const opcode = peer.buffer[0] & 15;
    const indicator = peer.buffer[1] & 127;
    if (indicator === 127) return peer.socket.end();
    const offset = indicator === 126 ? 4 : 2;
    if (peer.buffer.length < offset + 4) return;
    const size = indicator === 126 ? peer.buffer.readUInt16BE(2) : indicator;
    if (peer.buffer.length < offset + 4 + size) return;
    const mask = peer.buffer.subarray(offset, offset + 4); const payload = Buffer.from(peer.buffer.subarray(offset + 4, offset + 4 + size)); peer.buffer = peer.buffer.subarray(offset + 4 + size);
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    if (opcode === 8) return peer.socket.end();
    try { handle(peer, JSON.parse(payload.toString("utf8"))); } catch { reject(peer, { code: "INVALID_MESSAGE", message: "Message must be valid JSON" }); }
  }
}

const server = createServer((request, response) => {
  if (request.url === "/health") { response.writeHead(200, { "content-type": "application/json" }); return response.end(JSON.stringify({ status: "ok" })); }
  response.writeHead(404); response.end();
});
server.on("upgrade", (request, socket) => {
  if (request.url !== "/ws" || request.headers.upgrade?.toLowerCase() !== "websocket" || !request.headers["sec-websocket-key"]) return socket.destroy();
  const accept = createHash("sha1").update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const peer = { socket, buffer: Buffer.alloc(0) }; peers.add(peer); send(peer, { type: "connectionState", state: "connected", message: null });
  socket.on("data", (chunk) => parseFrames(peer, chunk)); socket.on("close", () => { const result = manager.disconnect(peer.sessionId, peer.clientId); peers.delete(peer); if (result) broadcast(result.state); }); socket.on("error", () => socket.destroy());
});
server.listen(port, host, () => console.log(`Red Planet local server listening on ws://${host}:${port}/ws`));
