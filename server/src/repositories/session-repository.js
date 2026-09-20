export class SessionRepository {
  constructor(database) {
    this.database = database;
  }

  insert(state) {
    this.database.prepare(`
      INSERT INTO sessions(session_id, join_code, room_mode, revision, host_player_id, created_at, updated_at)
      VALUES (@sessionId, @joinCode, @roomMode, @revision, @hostPlayerId, @createdAt, @updatedAt)
    `).run(state);
  }

  find(sessionId) {
    return this.database.prepare(`
      SELECT session_id AS sessionId, join_code AS joinCode, room_mode AS roomMode,
             revision, host_player_id AS hostPlayerId, created_at AS createdAt, updated_at AS updatedAt
      FROM sessions WHERE session_id = ?
    `).get(sessionId);
  }

  touch(sessionId, updatedAt, hostPlayerId = undefined) {
    if (hostPlayerId === undefined) {
      this.database.prepare("UPDATE sessions SET revision = revision + 1, updated_at = ? WHERE session_id = ?")
        .run(updatedAt, sessionId);
    } else {
      this.database.prepare("UPDATE sessions SET revision = revision + 1, updated_at = ?, host_player_id = ? WHERE session_id = ?")
        .run(updatedAt, hostPlayerId, sessionId);
    }
  }

  delete(sessionId) {
    this.database.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  count() {
    return this.database.prepare("SELECT COUNT(*) AS count FROM sessions").get().count;
  }

  has(sessionId) {
    return Boolean(this.database.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(sessionId));
  }
}
