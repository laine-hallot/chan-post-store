import type { DatabaseSync } from "node:sqlite";

/**
 * Migrates a store built under `UNIQUE (source_id, site, board, post_no)` to
 * one row per post: `UNIQUE (site, board, post_no)`.
 *
 * The old constraint let every archive keep its own copy of a post, which is
 * good for provenance and bad for every aggregate query — a word-frequency
 * count over a period silently multiplies posts held by several archives. On
 * the corpus this was written for, 34.8% of rows were such copies.
 *
 * The surviving row is the one with the lowest `id`, i.e. whichever archive
 * supplied it first. Its `source_id` is kept and the overlap information is
 * discarded; recovering "which archives held this post" means diffing the
 * source datasets, not querying this table.
 *
 * Row `id`s are preserved throughout, because `posts_fts` is an
 * external-content FTS5 table keyed on `posts.id` — renumbering would point
 * every search hit at the wrong row.
 */

export interface DedupeProgress {
  (stage: string, detail?: string): void;
}

function tableSql(db: DatabaseSync, name: string): string | null {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { sql: string } | undefined;
  return row?.sql ?? null;
}

/** True when `posts` still carries source_id in its uniqueness constraint. */
export function needsDedupe(db: DatabaseSync): boolean {
  const sql = tableSql(db, "posts");
  if (!sql) return false;
  return /UNIQUE\s*\(\s*source_id\s*,/i.test(sql);
}

export interface DedupeResult {
  before: number;
  after: number;
  removed: number;
}

/**
 * Deletes duplicate posts, swaps the constraint, and rebuilds the derived
 * tables. Long-running: each stage is a full pass over the store.
 */
export function dedupePosts(
  db: DatabaseSync,
  onProgress: DedupeProgress,
): DedupeResult {
  const count = () =>
    (db.prepare("SELECT COUNT(*) c FROM posts").get() as { c: number }).c;

  onProgress("counting rows");
  const before = count();

  // Drop the duplicates in place rather than filtering them out during the
  // table rebuild below. Deleting first means the rebuild copies only the
  // surviving rows, and it keeps this step independently resumable: if the
  // process dies here, re-running deletes whatever is left.
  //
  // "A copy with a lower id exists" keeps the earliest-ingested row of each
  // post. Written as a correlated EXISTS rather than
  // `id NOT IN (SELECT MIN(id) ... GROUP BY ...)`: the NOT IN form
  // materializes one list entry per surviving post (370M values here, tens of
  // GB of RAM), while EXISTS resolves each row with an indexed lookup against
  // idx_posts_stats and holds nothing.
  onProgress("deleting duplicate posts", "(full scan, expect a long pass)");
  db.exec(`
    DELETE FROM posts
     WHERE EXISTS (
       SELECT 1 FROM posts p2
        WHERE p2.site    = posts.site
          AND p2.board   = posts.board
          AND p2.post_no = posts.post_no
          AND p2.id      < posts.id
     )
  `);
  const after = count();
  onProgress("deleted", `${(before - after).toLocaleString()} rows`);

  // SQLite cannot alter a UNIQUE constraint in place, so the table is rebuilt.
  // Column list is spelled out (not SELECT *) so id is copied verbatim.
  onProgress("rebuilding posts with the new constraint");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE posts_new (
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
        UNIQUE (site, board, post_no)
      )
    `);
    db.exec(`
      INSERT INTO posts_new (
        id, source_id, site, board, thread_no, post_no, is_op, ts_utc,
        name, tripcode, subject, body_text, media_filename, media_md5
      )
      SELECT
        id, source_id, site, board, thread_no, post_no, is_op, ts_utc,
        name, tripcode, subject, body_text, media_filename, media_md5
      FROM posts
    `);
    db.exec("DROP TABLE posts");
    db.exec("ALTER TABLE posts_new RENAME TO posts");
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  db.exec("PRAGMA foreign_keys = ON");

  onProgress("recreating indexes");
  db.exec("CREATE INDEX idx_posts_board_ts ON posts (site, board, ts_utc)");
  db.exec(
    "CREATE INDEX idx_posts_stats ON posts (site, board, post_no, thread_no, ts_utc)",
  );
  db.exec("CREATE INDEX idx_posts_src_ts ON posts (source_id, ts_utc)");

  // posts_fts reads through to posts.id, so dropping rows leaves it pointing
  // at ids that no longer exist. A full reindex is the only way back: there
  // are no sync triggers, PostInserter writes both tables by hand.
  onProgress("rebuilding the search index", "(slowest stage)");
  db.exec("INSERT INTO posts_fts(posts_fts) VALUES('rebuild')");

  return { before, after, removed: before - after };
}
