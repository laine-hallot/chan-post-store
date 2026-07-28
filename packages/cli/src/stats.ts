import type { DatabaseSync } from "node:sqlite";

/**
 * Rebuilds `post_stats` from `posts`.
 *
 * Ingest maintains the table incrementally, so this is only needed to
 * backfill rows that predate it (or after a manual edit). It is a single
 * full pass over the store — minutes on a large database — which is exactly
 * the cost the table exists to avoid paying per query.
 */
export function refreshPostStats(db: DatabaseSync): number {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM post_stats");
    db.exec(`
      INSERT INTO post_stats (source_id, site, board, year, posts, min_ts, max_ts)
      SELECT source_id, site, board,
             CAST(strftime('%Y', ts_utc, 'unixepoch') AS INTEGER) AS year,
             COUNT(*), MIN(ts_utc), MAX(ts_utc)
        FROM posts
       GROUP BY source_id, site, board, year
    `);
    const n = db.prepare("SELECT COUNT(*) AS n FROM post_stats").get() as { n: number };
    db.exec("COMMIT");
    return n.n;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export interface BoardStat {
  site: string;
  board: string;
  posts: number;
  firstYear: number | null;
  lastYear: number | null;
}

/** Every board in the store, from the summary table rather than `posts`. */
export function boardList(db: DatabaseSync): BoardStat[] {
  return db
    .prepare(
      `SELECT site, board,
              SUM(posts) AS posts,
              MIN(year)  AS firstYear,
              MAX(year)  AS lastYear
         FROM post_stats
        GROUP BY site, board
        ORDER BY site, board`,
    )
    .all() as unknown as BoardStat[];
}

/** Posts per year for one board, summed across archives. */
export function boardYears(
  db: DatabaseSync,
  site: string,
  board: string,
): { year: number; posts: number }[] {
  return db
    .prepare(
      `SELECT year, SUM(posts) AS posts
         FROM post_stats
        WHERE site = ? AND board = ? AND year IS NOT NULL
        GROUP BY year ORDER BY year`,
    )
    .all(site, board) as unknown as { year: number; posts: number }[];
}

/** True when the summary table has been populated. */
export function hasStats(db: DatabaseSync): boolean {
  const r = db.prepare("SELECT COUNT(*) AS n FROM post_stats").get() as { n: number };
  return r.n > 0;
}
