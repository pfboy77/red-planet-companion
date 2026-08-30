export function peerAuthorizationError(peer, message) {
  if (!peer.sessionId || !peer.playerId) return { code: "NOT_JOINED", message: "Join or resume a session before sending this message" };
  if (peer.sessionId !== message.sessionId) return { code: "SESSION_MISMATCH", message: "The message session does not match this connection" };
  return undefined;
}
