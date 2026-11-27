import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Each game is one JSON document. Node handles requests on a single thread and
// these calls are synchronous, so load → mutate → save can't interleave.
export function openStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    CREATE TABLE IF NOT EXISTS games (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  const getStmt = db.prepare('SELECT data FROM games WHERE id = ?');
  const putStmt = db.prepare(
    'INSERT INTO games (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at',
  );
  const finishedStmt = db.prepare("SELECT data FROM games WHERE json_extract(data, '$.status') = 'finished'");
  return {
    db,
    /** Every finished game, for the leaderboard. */
    finished() {
      return finishedStmt.all().map((r) => JSON.parse(r.data));
    },
    get(id) {
      const row = getStmt.get(id);
      return row ? JSON.parse(row.data) : null;
    },
    put(game) {
      putStmt.run(game.id, JSON.stringify(game), game.updatedAt);
    },
    close() {
      db.close();
    },
  };
}
