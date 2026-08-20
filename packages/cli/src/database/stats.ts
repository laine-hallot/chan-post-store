import type { Pool } from 'pg';

/**
 * Rebuilds `post_stats` from `posts`.
 *
 * Ingest maintains the table incrementally, so this is only needed to
 * backfill rows that predate it (or after a manual edit). It is a single
 * full pass over the store — minutes on a large database — which is exactly
 * the cost the table exists to avoid paying per query.
 *
 * Runs on a single checked-out connection rather than the pool directly:
 * a Pool's separate `.query()` calls can each land on a different pooled
 * connection, so DELETE then INSERT via `pool.query()` would not be atomic.
 */
export const refreshPostStats = async (db: Pool): Promise<number> => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM post_stats');
    await client.query(`
      INSERT INTO post_stats (source_id, site, board, year, posts, min_ts, max_ts)
      SELECT source_id, site, board,
             EXTRACT(YEAR FROM to_timestamp(ts_utc) AT TIME ZONE 'UTC')::int AS year,
             COUNT(*), MIN(ts_utc), MAX(ts_utc)
        FROM posts
       GROUP BY source_id, site, board, year
    `);
    const { rows } = await client.query<{ n: number }>(
      'SELECT COUNT(*) AS n FROM post_stats'
    );
    await client.query('COMMIT');
    return rows[0]!.n;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
};

export interface BoardStat {
  site: string;
  board: string;
  posts: number;
  firstYear: number | null;
  lastYear: number | null;
}

/** Every board in the store, from the summary table rather than `posts`. */
export const boardList = async (db: Pool): Promise<BoardStat[]> => {
  const { rows } = await db.query<BoardStat>(`
    SELECT site, board,
           SUM(posts)::bigint AS posts,
           MIN(year)  AS "firstYear",
           MAX(year)  AS "lastYear"
      FROM post_stats
     GROUP BY site, board
     ORDER BY site, board
  `);
  return rows;
};

/** Posts per year for one board, summed across archives. */
export const boardYears = async (
  db: Pool,
  site: string,
  board: string
): Promise<{ year: number; posts: number }[]> => {
  const { rows } = await db.query<{ year: number; posts: number }>(
    `SELECT year, SUM(posts)::bigint AS posts
       FROM post_stats
      WHERE site = $1 AND board = $2 AND year IS NOT NULL
      GROUP BY year ORDER BY year`,
    [site, board]
  );
  return rows;
};

/** True when the summary table has been populated. */
export const hasStats = async (db: Pool): Promise<boolean> => {
  const { rows } = await db.query<{ n: number }>(
    'SELECT COUNT(*) AS n FROM post_stats'
  );
  return rows[0]!.n > 0;
};
