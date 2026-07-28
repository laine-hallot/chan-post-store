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

-- Rolled-up post counts, maintained during ingest.
--
-- Deriving these from the posts table means walking the index for every
-- board: a plain "which boards exist" GROUP BY costs ~215s on a 288M-row
-- store, and a per-board year grid tens of seconds. Keyed by year as well
-- as board so one table answers both the board list and the coverage
-- charts.
--
-- year is the UTC calendar year; posts with no timestamp are counted under
-- year IS NULL so the totals still reconcile with the posts table.
CREATE TABLE IF NOT EXISTS post_stats (
  source_id INTEGER NOT NULL REFERENCES sources(id),
  site      TEXT NOT NULL,
  board     TEXT NOT NULL,
  year      INTEGER,
  posts     INTEGER NOT NULL DEFAULT 0,
  min_ts    INTEGER,
  max_ts    INTEGER,
  PRIMARY KEY (source_id, site, board, year)
);

CREATE INDEX IF NOT EXISTS idx_post_stats_board
  ON post_stats (site, board, year);
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
