import pg from 'pg';
import type { Pool } from 'pg';

const { Pool: PgPool } = pg;

// COUNT/MIN/MAX over bigint columns come back as strings by default, to avoid
// silent precision loss past Number.MAX_SAFE_INTEGER. The corpus is ~400M
// rows, far below that, so parsing them back keeps the chart code working
// with plain arithmetic. SUM(bigint) returns NUMERIC (1700), not bigint.
pg.types.setTypeParser(20, (v: string) => parseInt(v, 10));
pg.types.setTypeParser(1700, (v: string) => parseFloat(v));

/**
 * Aggregate queries over the post store.
 *
 * READ FROM post_stats WHERE POSSIBLE. The store is ~400M rows and the
 * query-time indexes on `posts` are NOT part of the connect-time schema --
 * they are dropped for bulk loads and rebuilt afterwards (`indexes
 * build|drop|status` in the CLI). An aggregate that assumes an index may
 * therefore find none and sequentially scan a 126GB heap. post_stats is a few
 * hundred rows, is maintained during ingest, and is the only thing that can
 * answer a board+source split at all.
 *
 * The direct-count fallbacks below remain for a store whose post_stats was
 * never built, but callers should check `hasQueryIndexes` first and say so:
 * without those indexes the fallback is not "slower", it is hours.
 */

export interface YearBucket {
  /** Calendar year, e.g. "2015". */
  year: string;
  /** Source name as stored in `sources`. */
  source: string;
  posts: number;
}

export interface Totals {
  /** Rows in `posts`, dated or not. */
  posts: number;
  minTs: number | null;
  maxTs: number | null;
}

/**
 * A read-only pool.
 *
 * Deliberately NOT the CLI's `openDb`: that applies the schema on connect
 * (CREATE TABLE, ALTER TABLE ... ADD COLUMN), which an analysis tool has no
 * business doing and which fails outright against a read-only role.
 */
export const openReadOnly = (connectionString: string): Pool => {
  const pool = new PgPool({
    connectionString,
    max: 4,
    connectionTimeoutMillis: 10_000,
    // Year bucketing is done in UTC; don't inherit the server's zone.
    options: '-c TimeZone=UTC',
  });
  pool.on('error', (err) => {
    console.error('unexpected error on idle postgres client', err);
  });
  return pool;
};

/** True when the post_stats summary table exists and is populated. */
export const hasPostStats = async (db: Pool): Promise<boolean> => {
  const { rows } = await db.query<{ reg: string | null }>(
    "SELECT to_regclass('public.post_stats')::text AS reg"
  );
  if (!rows[0]?.reg) return false;
  const { rows: n } = await db.query<{ n: number }>(
    'SELECT count(*)::bigint AS n FROM post_stats'
  );
  return (n[0]?.n ?? 0) > 0;
};

/**
 * Which query-time indexes on `posts` currently exist.
 *
 * Worth asking rather than assuming: they are routinely dropped for a bulk
 * ingest, and every fallback here depends on one of them.
 */
export const hasQueryIndexes = async (
  db: Pool
): Promise<{ srcTs: boolean; boardTs: boolean }> => {
  const { rows } = await db.query<{
    srcts: string | null;
    boardts: string | null;
  }>(
    `SELECT to_regclass('public.idx_posts_src_ts')::text   AS srcts,
            to_regclass('public.idx_posts_board_ts')::text AS boardts`
  );
  return { srcTs: rows[0]?.srcts != null, boardTs: rows[0]?.boardts != null };
};

/**
 * Year/source grid straight out of post_stats.
 *
 * The only way to get a board+source split at all: no index on `posts` serves
 * that combination, so deriving it from rows means a full scan per cell.
 */
export const bucketsFromStats = async (
  db: Pool,
  filter?: { site: string; board: string }
): Promise<YearBucket[]> => {
  const where = filter
    ? 'WHERE ps.site = $1 AND ps.board = $2 AND ps.year IS NOT NULL'
    : 'WHERE ps.year IS NOT NULL';
  const args = filter ? [filter.site, filter.board] : [];
  const { rows } = await db.query<YearBucket>(
    `SELECT s.name AS source, ps.year::text AS year, SUM(ps.posts)::bigint AS posts
       FROM post_stats ps
       JOIN sources s ON s.id = ps.source_id
      ${where}
      GROUP BY s.name, ps.year
      ORDER BY ps.year, s.name`,
    args
  );
  return rows;
};

/** Corpus totals from post_stats: a few hundred rows, not 400M. */
export const totalsFromStats = async (db: Pool): Promise<Totals> => {
  const { rows } = await db.query<{
    posts: number | null;
    lo: number | null;
    hi: number | null;
  }>(
    `SELECT SUM(posts)::bigint AS posts, MIN(min_ts)::bigint AS lo, MAX(max_ts)::bigint AS hi
       FROM post_stats`
  );
  const r = rows[0];
  return { posts: r?.posts ?? 0, minTs: r?.lo ?? null, maxTs: r?.hi ?? null };
};

/**
 * Earliest and latest post timestamps, taken per source and combined here.
 *
 * A single `MIN(ts_utc) ... WHERE ts_utc IS NOT NULL` cannot use
 * idx_posts_src_ts, which leads with source_id, so it scans. Written as
 * ORDER BY ... LIMIT 1 rather than MIN()/MAX() because that is the form
 * Postgres turns into an index scan that stops at the first row.
 *
 * Requires idx_posts_src_ts.
 */
export const timestampSpan = async (
  db: Pool
): Promise<{ minTs: number | null; maxTs: number | null }> => {
  const { rows: sources } = await db.query<{ id: number }>(
    'SELECT id FROM sources'
  );
  let minTs: number | null = null;
  let maxTs: number | null = null;
  for (const s of sources) {
    const { rows } = await db.query<{ lo: number | null; hi: number | null }>(
      `SELECT (SELECT ts_utc FROM posts WHERE source_id = $1 AND ts_utc IS NOT NULL
                ORDER BY ts_utc ASC  LIMIT 1) AS lo,
              (SELECT ts_utc FROM posts WHERE source_id = $1 AND ts_utc IS NOT NULL
                ORDER BY ts_utc DESC LIMIT 1) AS hi`,
      [s.id]
    );
    const r = rows[0];
    if (r?.lo != null) minTs = minTs == null ? r.lo : Math.min(minTs, r.lo);
    if (r?.hi != null) maxTs = maxTs == null ? r.hi : Math.max(maxTs, r.hi);
  }
  return { minTs, maxTs };
};

/**
 * Posts per calendar year per source. Undated posts are excluded.
 *
 * Many small bounded-range counts rather than one GROUP BY: each is a range
 * over idx_posts_src_ts (source_id, ts_utc) that Postgres can answer from the
 * index, whereas a single grouped query with date_trunc() must read every row
 * and format it.
 *
 * Requires idx_posts_src_ts. Prefer bucketsFromStats.
 */
export const postsByYearAndSource = async (db: Pool): Promise<YearBucket[]> => {
  const { rows: sources } = await db.query<{ id: number; name: string }>(
    'SELECT id, name FROM sources ORDER BY name'
  );

  const span = await timestampSpan(db);
  if (span.minTs == null || span.maxTs == null) return [];

  const firstYear = new Date(span.minTs * 1000).getUTCFullYear();
  const lastYear = new Date(span.maxTs * 1000).getUTCFullYear();

  const out: YearBucket[] = [];
  for (const s of sources) {
    for (let y = firstYear; y <= lastYear; y++) {
      const { rows } = await db.query<{ n: number }>(
        'SELECT count(*)::bigint AS n FROM posts WHERE source_id = $1 AND ts_utc >= $2 AND ts_utc < $3',
        [s.id, Date.UTC(y, 0, 1) / 1000, Date.UTC(y + 1, 0, 1) / 1000]
      );
      const n = rows[0]?.n ?? 0;
      if (n > 0) out.push({ year: String(y), source: s.name, posts: n });
    }
  }
  return out;
};

/** Timestamp range for one board. Requires idx_posts_board_ts. */
export const boardSpan = async (
  db: Pool,
  site: string,
  board: string
): Promise<{ minTs: number | null; maxTs: number | null }> => {
  const { rows } = await db.query<{ lo: number | null; hi: number | null }>(
    `SELECT (SELECT ts_utc FROM posts WHERE site = $1 AND board = $2 AND ts_utc IS NOT NULL
              ORDER BY ts_utc ASC  LIMIT 1) AS lo,
            (SELECT ts_utc FROM posts WHERE site = $1 AND board = $2 AND ts_utc IS NOT NULL
              ORDER BY ts_utc DESC LIMIT 1) AS hi`,
    [site, board]
  );
  return { minTs: rows[0]?.lo ?? null, maxTs: rows[0]?.hi ?? null };
};

/**
 * Posts per calendar year for one board, ignoring which archive supplied them.
 *
 * idx_posts_board_ts (site, board, ts_utc) covers this, so each year is
 * answered from the index without touching the heap. Adding a source filter
 * would break that -- no index leads with source and board together.
 *
 * Requires idx_posts_board_ts. Prefer bucketsFromStats with a filter.
 */
export const postsByYearForBoard = async (
  db: Pool,
  site: string,
  board: string
): Promise<{ year: string; posts: number }[]> => {
  const span = await boardSpan(db, site, board);
  if (span.minTs == null || span.maxTs == null) return [];

  const out: { year: string; posts: number }[] = [];
  const first = new Date(span.minTs * 1000).getUTCFullYear();
  const last = new Date(span.maxTs * 1000).getUTCFullYear();
  for (let y = first; y <= last; y++) {
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::bigint AS n FROM posts WHERE site = $1 AND board = $2 AND ts_utc >= $3 AND ts_utc < $4',
      [site, board, Date.UTC(y, 0, 1) / 1000, Date.UTC(y + 1, 0, 1) / 1000]
    );
    out.push({ year: String(y), posts: rows[0]?.n ?? 0 });
  }
  return out;
};

/**
 * Corpus totals and the timestamp span, counted from `posts`.
 *
 * `COUNT(*)` has no shortcut here: MVCC means Postgres cannot read it from
 * table metadata the way SQLite could, so it is a full scan of a 126GB heap
 * unless a small index happens to cover it. Prefer totalsFromStats.
 */
export const totals = async (db: Pool): Promise<Totals> => {
  const { rows } = await db.query<{ n: number }>(
    'SELECT count(*)::bigint AS n FROM posts'
  );
  return { posts: rows[0]?.n ?? 0, ...(await timestampSpan(db)) };
};
