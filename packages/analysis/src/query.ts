import { DatabaseSync } from "node:sqlite";

/**
 * Aggregate queries over the post store.
 *
 * The table is ~288M rows, so every query here is written to be served by an
 * index rather than a full scan: grouping by source needs
 * `idx_posts_src_ts (source_id, ts_utc)`, without which SQLite falls back to
 * a scan plus a temp b-tree and takes minutes rather than seconds.
 */

export interface YearBucket {
  /** Calendar year, e.g. "2015". */
  year: string;
  /** Source name as stored in `sources`. */
  source: string;
  posts: number;
}

export function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

/** True when the covering index for source+time grouping is present. */
export function hasSourceTimeIndex(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type='index' AND name='idx_posts_src_ts'")
    .get() as { ok?: number } | undefined;
  return row?.ok === 1;
}

/** Posts per calendar year per source. Undated posts are excluded. */
export function postsByYearAndSource(db: DatabaseSync): YearBucket[] {
  const rows = db
    .prepare(
      `SELECT s.name AS source,
              strftime('%Y', p.ts_utc, 'unixepoch') AS year,
              COUNT(*) AS posts
         FROM posts p
         JOIN sources s ON s.id = p.source_id
        WHERE p.ts_utc IS NOT NULL
        GROUP BY p.source_id, year
        ORDER BY year, source`,
    )
    .all() as unknown as YearBucket[];
  return rows;
}

export interface Totals {
  posts: number;
  dated: number;
  minTs: number | null;
  maxTs: number | null;
}

export function totals(db: DatabaseSync): Totals {
  const all = db.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number };
  const dated = db
    .prepare("SELECT COUNT(*) AS n, MIN(ts_utc) AS lo, MAX(ts_utc) AS hi FROM posts WHERE ts_utc IS NOT NULL")
    .get() as { n: number; lo: number | null; hi: number | null };
  return { posts: all.n, dated: dated.n, minTs: dated.lo, maxTs: dated.hi };
}
