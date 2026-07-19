import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE,
  link  TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS posts (
  id             INTEGER PRIMARY KEY,
  source_id      INTEGER NOT NULL REFERENCES sources(id),
  site           TEXT NOT NULL,
  board          TEXT NOT NULL,
  thread_no      INTEGER NOT NULL,
  post_no        INTEGER NOT NULL,
  is_op          INTEGER NOT NULL DEFAULT 0,
  ts_utc         INTEGER,
  name           TEXT,
  tripcode       TEXT,
  subject        TEXT,
  body_text      TEXT,
  media_filename TEXT,
  media_md5      TEXT,
  UNIQUE (source_id, site, board, post_no)
);

CREATE INDEX IF NOT EXISTS idx_posts_board_ts ON posts (site, board, ts_utc);

-- covering index for the list/stats queries: distinct post/thread counts and
-- date spans per board without touching the (body-text-heavy) table rows
CREATE INDEX IF NOT EXISTS idx_posts_stats
  ON posts (site, board, post_no, thread_no, ts_utc);

CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  subject, body_text,
  content='posts', content_rowid='id'
);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(SCHEMA);
  return db;
}

export function getOrCreateSource(
  db: DatabaseSync,
  name: string,
  link?: string,
): number {
  db.prepare("INSERT INTO sources (name, link) VALUES (?, ?) ON CONFLICT(name) DO NOTHING")
    .run(name, link ?? null);
  const row = db.prepare("SELECT id FROM sources WHERE name = ?").get(name) as
    | { id: number }
    | undefined;
  if (!row) throw new Error(`failed to create source ${name}`);
  return row.id;
}
