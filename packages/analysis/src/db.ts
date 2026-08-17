import type { Pool } from 'pg';

import pg from 'pg';

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
  posts: number;
}

export interface YearSourceBucket {
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
