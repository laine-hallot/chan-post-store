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

/**
 * Earliest and latest post timestamps.
 *
 * Taken per source and combined here: a single
 * `MIN(ts_utc) ... WHERE ts_utc IS NOT NULL` can't use idx_posts_src_ts
 * (which leads with source_id) and scans the table, ~45s. Per source it is
 * an index seek at each end, under a second in total.
 */
export function timestampSpan(db: DatabaseSync): { minTs: number | null; maxTs: number | null } {
  const sources = db.prepare("SELECT id FROM sources").all() as unknown as { id: number }[];
  const ends = db.prepare(
    `SELECT (SELECT MIN(ts_utc) FROM posts WHERE source_id = ?1 AND ts_utc IS NOT NULL) AS lo,
            (SELECT MAX(ts_utc) FROM posts WHERE source_id = ?1 AND ts_utc IS NOT NULL) AS hi`,
  );
  let minTs: number | null = null;
  let maxTs: number | null = null;
  for (const s of sources) {
    const r = ends.get(s.id) as { lo: number | null; hi: number | null };
    if (r.lo != null) minTs = minTs == null ? r.lo : Math.min(minTs, r.lo);
    if (r.hi != null) maxTs = maxTs == null ? r.hi : Math.max(maxTs, r.hi);
  }
  return { minTs, maxTs };
}

/**
 * Posts per calendar year per source. Undated posts are excluded.
 *
 * Deliberately many small queries rather than one GROUP BY: each is a
 * bounded range over `idx_posts_src_ts (source_id, ts_utc)`, which SQLite
 * satisfies by seeking within the index. A single grouped query has to walk
 * all ~288M rows and run strftime() on each — measured at 230s against 16s
 * for the range counts, i.e. the aggregate is slower than merely counting
 * every row (33s), because the formatting dominates.
 */
export function postsByYearAndSource(db: DatabaseSync): YearBucket[] {
  const sources = db.prepare("SELECT id, name FROM sources ORDER BY name").all() as unknown as {
    id: number;
    name: string;
  }[];

  // Via the per-source form: a bare `WHERE ts_utc IS NOT NULL` MIN/MAX
  // can't use idx_posts_src_ts and costs ~45s on its own.
  const span = timestampSpan(db);
  if (span.minTs == null || span.maxTs == null) return [];

  const firstYear = new Date(span.minTs * 1000).getUTCFullYear();
  const lastYear = new Date(span.maxTs * 1000).getUTCFullYear();

  const count = db.prepare(
    "SELECT COUNT(*) AS n FROM posts WHERE source_id = ? AND ts_utc >= ? AND ts_utc < ?",
  );

  const out: YearBucket[] = [];
  for (const s of sources) {
    for (let y = firstYear; y <= lastYear; y++) {
      const lo = Date.UTC(y, 0, 1) / 1000;
      const hi = Date.UTC(y + 1, 0, 1) / 1000;
      const { n } = count.get(s.id, lo, hi) as { n: number };
      if (n > 0) out.push({ year: String(y), source: s.name, posts: n });
    }
  }
  return out;
}

export interface Totals {
  /** Rows in `posts`, dated or not. */
  posts: number;
  minTs: number | null;
  maxTs: number | null;
}

/**
 * Corpus totals and the timestamp span.
 *
 * MIN/MAX are taken per source and combined here rather than with a single
 * `WHERE ts_utc IS NOT NULL` aggregate: that predicate can't use
 * idx_posts_src_ts (which leads with source_id) and costs ~49s, whereas a
 * bounded MIN/MAX per source is an index seek at each end.
 */
export function totals(db: DatabaseSync): Totals {
  const all = db.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number };
  return { posts: all.n, ...timestampSpan(db) };
}
