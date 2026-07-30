import type { DatabaseSync, StatementSync } from "node:sqlite";

export interface PostRow {
  site: string;
  board: string;
  threadNo: number;
  postNo: number;
  isOp: boolean;
  tsUtc: number | null;
  name: string | null;
  tripcode: string | null;
  subject: string | null;
  bodyText: string | null;
  mediaFilename: string | null;
  mediaMd5: string | null;
}

/** One accumulated `post_stats` row, before it is flushed. */
interface StatCell {
  posts: number;
  minTs: number | null;
  maxTs: number | null;
}

/** Writes normalized posts into `posts` + `posts_fts`, skipping any post
 * already in the store -- whichever archive contributed it. */
export class PostInserter {
  #post: StatementSync;
  #fts: StatementSync;
  #sourceId: number;
  #db: DatabaseSync;
  /** Per-(site, board, year) tallies, flushed to post_stats by `finish()`. */
  #stats = new Map<string, StatCell>();

  constructor(db: DatabaseSync, sourceId: number) {
    this.#db = db;
    this.#sourceId = sourceId;
    this.#post = db.prepare(`
      INSERT INTO posts (
        source_id, site, board, thread_no, post_no, is_op, ts_utc,
        name, tripcode, subject, body_text, media_filename, media_md5
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (site, board, post_no) DO NOTHING
      RETURNING id
    `);
    this.#fts = db.prepare(
      "INSERT INTO posts_fts (rowid, subject, body_text) VALUES (?, ?, ?)",
    );
  }

  /**
   * Returns true if the post was stored, false if it was already present.
   *
   * "Already present" spans archives, not just this source: `posts` is keyed
   * (site, board, post_no), so a post another archive supplied first is
   * skipped here. Adapters counting these as "duplicates" are counting
   * overlap with the rest of the corpus as well as with earlier runs of
   * themselves.
   */
  insert(p: PostRow): boolean {
    const row = this.#post.get(
      this.#sourceId,
      p.site,
      p.board,
      p.threadNo,
      p.postNo,
      p.isOp ? 1 : 0,
      p.tsUtc,
      p.name,
      p.tripcode,
      p.subject,
      p.bodyText,
      p.mediaFilename,
      p.mediaMd5,
    ) as { id: number } | undefined;
    if (!row) return false;
    this.#fts.run(row.id, p.subject, p.bodyText);

    // Tally in memory: an upsert per post would dominate the insert cost,
    // and a run only touches a handful of (board, year) combinations.
    const year =
      p.tsUtc == null ? null : new Date(p.tsUtc * 1000).getUTCFullYear();
    // Tab-separated: neither a site nor a board name contains one, so the
    // key round-trips unambiguously when it is split apart in finish().
    const key = `${p.site}\t${p.board}\t${year ?? ""}`;
    const cell = this.#stats.get(key);
    if (cell) {
      cell.posts++;
      if (p.tsUtc != null) {
        if (cell.minTs == null || p.tsUtc < cell.minTs) cell.minTs = p.tsUtc;
        if (cell.maxTs == null || p.tsUtc > cell.maxTs) cell.maxTs = p.tsUtc;
      }
    } else {
      this.#stats.set(key, { posts: 1, minTs: p.tsUtc, maxTs: p.tsUtc });
    }
    return true;
  }

  /**
   * Folds the tallies accumulated so far into `post_stats`.
   *
   * Counts are added to whatever is already stored, so this is safe to call
   * repeatedly: each call contributes only what has been counted since the
   * last one. Adapters call it periodically as well as at the end — a single
   * flush at the end means an interrupted run loses every tally it had
   * accumulated, leaving post_stats short of `posts` until a full rebuild.
   */
  finish(): void {
    const up = this.#db.prepare(`
      INSERT INTO post_stats (source_id, site, board, year, posts, min_ts, max_ts)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_id, site, board, year) DO UPDATE SET
        posts  = posts + excluded.posts,
        min_ts = CASE
                   WHEN min_ts IS NULL THEN excluded.min_ts
                   WHEN excluded.min_ts IS NULL THEN min_ts
                   ELSE MIN(min_ts, excluded.min_ts) END,
        max_ts = CASE
                   WHEN max_ts IS NULL THEN excluded.max_ts
                   WHEN excluded.max_ts IS NULL THEN max_ts
                   ELSE MAX(max_ts, excluded.max_ts) END
    `);
    for (const [key, c] of this.#stats) {
      const [site, board, year] = key.split("\t");
      up.run(
        this.#sourceId,
        site,
        board,
        year === "" ? null : Number(year),
        c.posts,
        c.minTs,
        c.maxTs,
      );
    }
    this.#stats.clear();
  }
}
