export class ActionRepository {
  constructor(database, limit = 1000) {
    this.database = database;
    this.limit = limit;
  }

  find(sessionId, actionId) {
    return this.database.prepare(`
      SELECT player_id AS playerId, fingerprint, created_at AS createdAt
      FROM processed_actions WHERE session_id = ? AND action_id = ?
    `).get(sessionId, actionId);
  }

  insert(sessionId, actionId, playerId, fingerprint, createdAt) {
    this.database.prepare(`
      INSERT INTO processed_actions(session_id, action_id, player_id, fingerprint, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, actionId, playerId, fingerprint, createdAt);
  }

  prune(sessionId) {
    this.database.prepare(`
      DELETE FROM processed_actions
      WHERE rowid IN (
        SELECT rowid FROM processed_actions
        WHERE session_id = ?
        ORDER BY created_at DESC, rowid DESC
        LIMIT -1 OFFSET ?
      )
    `).run(sessionId, this.limit);
  }

  all(sessionId) {
    return new Map(this.database.prepare(`
      SELECT action_id AS actionId, player_id AS playerId, fingerprint
      FROM processed_actions WHERE session_id = ? ORDER BY created_at, rowid
    `).all(sessionId).map(({ actionId, playerId, fingerprint }) => [actionId, { playerId, fingerprint }]));
  }
}
