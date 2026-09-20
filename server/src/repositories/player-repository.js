export class PlayerRepository {
  constructor(database, resourceIds) {
    this.database = database;
    this.resourceIds = resourceIds;
    this.insertPlayer = database.prepare(`
      INSERT INTO players(player_id, session_id, display_name, connected, last_seen_at, revision, tr, created_at)
      VALUES (@playerId, @sessionId, @displayName, @connected, @lastSeenAt, @revision, @tr, @createdAt)
    `);
    this.insertResource = database.prepare(`
      INSERT INTO player_resources(player_id, resource_id, amount, production) VALUES (?, ?, ?, ?)
    `);
  }

  insert(sessionId, player, clientId, resumeTokenHash, createdAt) {
    this.insertPlayer.run({
      playerId: player.playerId,
      sessionId,
      displayName: player.displayName,
      connected: player.connected ? 1 : 0,
      lastSeenAt: player.lastSeenAt,
      revision: player.revision,
      tr: player.tr,
      createdAt,
    });
    for (const resourceId of this.resourceIds) {
      const resource = player.resources[resourceId];
      this.insertResource.run(player.playerId, resourceId, resource.amount, resource.production);
    }
    this.database.prepare("INSERT INTO client_players(session_id, client_id, player_id) VALUES (?, ?, ?)")
      .run(sessionId, clientId, player.playerId);
    if (resumeTokenHash) {
      this.database.prepare("INSERT INTO player_credentials(player_id, resume_token_hash, created_at) VALUES (?, ?, ?)")
        .run(player.playerId, resumeTokenHash, createdAt);
    }
  }

  list(sessionId) {
    const players = this.database.prepare(`
      SELECT player_id AS playerId, display_name AS displayName, connected,
             last_seen_at AS lastSeenAt, revision, tr
      FROM players WHERE session_id = ? ORDER BY rowid
    `).all(sessionId);
    const resourceStatement = this.database.prepare(`
      SELECT resource_id AS resourceId, amount, production
      FROM player_resources WHERE player_id = ?
    `);
    return players.map((player) => ({
      ...player,
      connected: Boolean(player.connected),
      resources: Object.fromEntries(resourceStatement.all(player.playerId).map(({ resourceId, amount, production }) => [resourceId, { amount, production }])),
    }));
  }

  find(sessionId, playerId) {
    return this.list(sessionId).find((player) => player.playerId === playerId);
  }

  count(sessionId) {
    return this.database.prepare("SELECT COUNT(*) AS count FROM players WHERE session_id = ?").get(sessionId).count;
  }

  firstPlayerId(sessionId) {
    return this.database.prepare("SELECT player_id AS playerId FROM players WHERE session_id = ? ORDER BY rowid LIMIT 1").get(sessionId)?.playerId;
  }

  findByClient(sessionId, clientId) {
    return this.database.prepare("SELECT player_id AS playerId FROM client_players WHERE session_id = ? AND client_id = ?")
      .get(sessionId, clientId)?.playerId;
  }

  clientPlayers(sessionId) {
    return new Map(this.database.prepare("SELECT client_id AS clientId, player_id AS playerId FROM client_players WHERE session_id = ?")
      .all(sessionId).map(({ clientId, playerId }) => [clientId, playerId]));
  }

  credentialHash(playerId) {
    return this.database.prepare("SELECT resume_token_hash AS resumeTokenHash FROM player_credentials WHERE player_id = ?")
      .get(playerId)?.resumeTokenHash;
  }

  credentials(sessionId) {
    return new Map(this.database.prepare(`
      SELECT p.player_id AS playerId, c.resume_token_hash AS resumeTokenHash
      FROM players p JOIN player_credentials c ON c.player_id = p.player_id
      WHERE p.session_id = ?
    `).all(sessionId).map(({ playerId, resumeTokenHash }) => [playerId, resumeTokenHash]));
  }

  setConnected(playerId, connected, lastSeenAt) {
    this.database.prepare("UPDATE players SET connected = ?, last_seen_at = ? WHERE player_id = ?")
      .run(connected ? 1 : 0, lastSeenAt, playerId);
  }

  update(player) {
    this.database.prepare(`
      UPDATE players SET connected = ?, last_seen_at = ?, revision = ?, tr = ? WHERE player_id = ?
    `).run(player.connected ? 1 : 0, player.lastSeenAt, player.revision, player.tr, player.playerId);
    const updateResource = this.database.prepare(`
      UPDATE player_resources SET amount = ?, production = ? WHERE player_id = ? AND resource_id = ?
    `);
    for (const resourceId of this.resourceIds) {
      const resource = player.resources[resourceId];
      updateResource.run(resource.amount, resource.production, player.playerId, resourceId);
    }
  }

  delete(playerId) {
    this.database.prepare("DELETE FROM players WHERE player_id = ?").run(playerId);
  }
}
