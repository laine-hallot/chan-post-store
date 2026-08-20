import type { Pool } from 'pg';

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

/**
 * Per-board totals for the whole run, kept separately from `#stats` because
 * that map is CLEARED by every `finish()` and adapters call `finish()`
 * periodically. These are what `--count-only` reports, and they are the three
 * numbers a staged source has to be checked on: rows read, OPs among them,
 * and rows whose timestamp did not parse.
 */
export interface BoardTotals {
  site: string;
  board: string;
  posts: number;
  ops: number;
  /** Rows whose timestamp did not parse; they land in no month bucket. */
  nullTs: number;
  minPostNo: number;
  maxPostNo: number;
  minTs: number | null;
  maxTs: number | null;
  /** Dated posts per calendar month, keyed `YYYY-MM` (UTC). */
  months: Map<string, number>;
}

// 2000 rows * 13 columns = 26000 bound params, comfortably under Postgres's
// 65535-param ceiling (floor(65535/13) = 5041 is the hard cap) while cutting
// per-row round trips to a NAS-hosted server by 2000x.
const BATCH_SIZE = 2000;

const COLUMNS = [
  'source_id',
  'site',
  'board',
  'thread_no',
  'post_no',
  'is_op',
  'ts_utc',
  'name',
  'tripcode',
  'subject',
  'body_text',
  'media_filename',
  'media_md5',
];

const keyOf = (site: string, board: string, postNo: number): string =>
  `${site}\t${board}\t${postNo}`;

/** `YYYY-MM` in UTC. Built from the Date parts rather than slicing an ISO
 * string so a negative epoch (which formats as `-000001-…`) cannot shift the
 * field positions. */
const monthKey = (tsUtc: number): string => {
  const d = new Date(tsUtc * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};

// Postgres's text type flatly rejects a lone NUL code point (error: invalid
// byte sequence for encoding UTF8). Some archives' source data genuinely
// contains one -- a decoded JSON escape or an unescaped mysqldump literal
// can both produce it. Because a flush is one multi-row INSERT, a single row
// carrying a NUL fails the *entire* batch and, since nothing retries with
// the offending row removed, aborts the whole source deterministically: the
// same row fails identically on every retry. Stripped once here rather than
// per adapter, since any text field can carry one.
const NUL = String.fromCharCode(0);
const stripNulls = (s: string | null): string | null =>
  s == null ? s : s.split(NUL).join('');

/**
 * Collects one `insert()` call's completion promise into an adapter's
 * `pending` array for later `Promise.all` draining at its next checkpoint.
 *
 * Immediately attaches a no-op `.catch()` so a flush failure can't crash the
 * whole process: `pending.push(...)` alone doesn't attach a handler, and a
 * rejection sitting unhandled that long risks Node's unhandled-rejection
 * detector firing (which throws by default) before the adapter's own
 * `Promise.all(pending)` ever gets a chance to observe and report it. The
 * no-op here only protects this specific promise reference from being
 * flagged early; the rejection itself is untouched, so `Promise.all(pending)`
 * still sees and propagates it normally.
 */
export const collectPending = (
  pending: Promise<void>[],
  p: Promise<void>
): void => {
  p.catch(() => {});
  pending.push(p);
};

/** Writes normalized posts into `posts`, batching rows into a single
 * multi-row INSERT per flush rather than one round trip per row, and skips
 * any post already in the store -- whichever archive contributed it. */
export class PostInserter {
  /**
   * Null when counting rather than storing. `survey` reads staged files with
   * no database at all, and requiring a live connection to describe files on
   * disk would make the store's availability a precondition for reading them.
   * Every write path asserts it; `#countOnly` is what keeps them unreached.
   */
  #pool: Pool | null;
  #sourceId: number;
  #buffer: PostRow[] = [];
  #waiters: ((ok: boolean) => void)[] = [];
  #flushing: Promise<void> | null = null;
  /** Per-(site, board, year) tallies, flushed to post_stats by `finish()`. */
  #stats = new Map<string, StatCell>();
  /** Per-board run totals; unlike `#stats`, never cleared. */
  #totals = new Map<string, BoardTotals>();
  #countOnly: boolean;

  constructor(pool: Pool | null, sourceId: number, countOnly = false) {
    this.#pool = pool;
    this.#sourceId = sourceId;
    this.#countOnly = countOnly;
  }

  /** Per-board totals accumulated so far, board order. */
  report(): BoardTotals[] {
    return [...this.#totals.values()].sort(
      (a, b) => a.site.localeCompare(b.site) || a.board.localeCompare(b.board)
    );
  }

  /**
   * Buffers the row and returns a promise that resolves to whether it was
   * newly stored, once its batch actually flushes.
   *
   * Do NOT `await` this call inline inside a tight insert loop -- the
   * promise only resolves when the buffer reaches BATCH_SIZE (or `finish()`
   * is called), so awaiting each call one at a time would stop the buffer
   * from ever growing past 1 and the promise would never resolve. Collect
   * the returned promises in an array and resolve them together
   * (`Promise.all`) at whatever periodic checkpoint the caller already uses
   * for progress reporting / crash-safety.
   */
  async insert(p: PostRow): Promise<boolean> {
    const promise = new Promise<boolean>((resolve) =>
      this.#waiters.push(resolve)
    );
    this.#buffer.push({
      ...p,
      name: stripNulls(p.name),
      tripcode: stripNulls(p.tripcode),
      subject: stripNulls(p.subject),
      bodyText: stripNulls(p.bodyText),
      mediaFilename: stripNulls(p.mediaFilename),
      mediaMd5: stripNulls(p.mediaMd5),
    });
    if (this.#buffer.length >= BATCH_SIZE) {
      await this.#flush();
    }
    return promise;
  }

  /**
   * Drains the buffer, coalescing concurrent callers onto whichever drain is
   * already running instead of letting each run its own loop.
   *
   * Adapters fire thousands of un-awaited `insert()` calls between
   * checkpoints (the SQL ones go 50,000 rows before draining `pending`), and
   * every call past BATCH_SIZE lands here. An earlier version had each of
   * those callers spin its own `while (buffer.length || flushing)` loop, so
   * one 2000-row flush woke *every* waiting caller to re-check and re-await --
   * O(callers) wakeups per flush. Benchmarking put that at roughly a 2x cost,
   * not the orders of magnitude it looks like it should be, so this is a
   * modest win rather than a critical fix; it is kept because one drainer with
   * many cheap awaiters is also easier to reason about than N racing loops.
   */
  async #flush(): Promise<void> {
    if (this.#flushing) {
      await this.#flushing;
      return;
    }
    this.#flushing = this.#drain();
    try {
      await this.#flushing;
    } finally {
      this.#flushing = null;
    }
  }

  /** Flushes BATCH_SIZE-sized slices until the buffer is empty. Slicing (as
   * opposed to taking the whole buffer) is what keeps a batch under
   * Postgres's bind-parameter ceiling: draining everything that piled up
   * during an in-flight flush once produced a single oversized statement and
   * corrupted the wire protocol ("bind message has 51058 parameter formats
   * but 0 parameters"). */
  async #drain(): Promise<void> {
    while (this.#buffer.length > 0) {
      const batch = this.#buffer.splice(0, BATCH_SIZE);
      const waiters = this.#waiters.splice(0, BATCH_SIZE);
      await this.#runFlush(batch, waiters);
    }
  }

  async #runFlush(
    batch: PostRow[],
    waiters: ((ok: boolean) => void)[]
  ): Promise<void> {
    // Count-only: the readers are what is under test, so tally every row and
    // tell each waiter it was stored. Nothing is deduplicated, because
    // deduplicating means holding every key of a 278M-row source in memory --
    // the database is what normally does it, and it is not in play here. The
    // number reported is therefore ROWS READ, which is what the registry's
    // recorded survey figures are counts of.
    if (this.#countOnly) {
      for (let i = 0; i < batch.length; i++) {
        this.#tally(batch[i]!);
        waiters[i]!(true);
      }
      return;
    }

    const params: unknown[] = [];
    const values = batch
      .map((r, i) => {
        params.push(
          this.#sourceId,
          r.site,
          r.board,
          r.threadNo,
          r.postNo,
          r.isOp,
          r.tsUtc,
          r.name,
          r.tripcode,
          r.subject,
          r.bodyText,
          r.mediaFilename,
          r.mediaMd5
        );
        const base = i * COLUMNS.length;
        return `(${COLUMNS.map((_, j) => `$${base + j + 1}`).join(',')})`;
      })
      .join(',');

    const pool = this.#requirePool();
    const { rows } = await pool.query<{
      site: string;
      board: string;
      post_no: number;
    }>(
      `INSERT INTO posts (${COLUMNS.join(', ')})
       VALUES ${values}
       ON CONFLICT (site, board, post_no) DO NOTHING
       RETURNING site, board, post_no`,
      params
    );

    // RETURNING order isn't guaranteed to match the VALUES order, so
    // correlate by key rather than position. The same (site, board, post_no)
    // can legitimately appear twice in one batch (e.g. a board-index page
    // and a full thread page landing in the same flush) -- ON CONFLICT DO
    // NOTHING against the row this same statement just inserted silently
    // drops the second occurrence rather than erroring, so each key must be
    // claimed at most once, in buffer order, to avoid crediting both.
    const returned = new Set(
      rows.map((r) => keyOf(r.site, r.board, r.post_no))
    );
    const claimed = new Set<string>();
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i]!;
      const key = keyOf(row.site, row.board, row.postNo);
      const ok = returned.has(key) && !claimed.has(key);
      // Tally only rows confirmed stored -- tallying at buffer time (before
      // the flush confirms whether ON CONFLICT DO NOTHING skipped it) would
      // silently overcount post_stats for duplicates.
      if (ok) {
        claimed.add(key);
        this.#tally(row);
      }
      waiters[i]!(ok);
    }
  }

  /** The pool, or a loud failure. Unreachable while `#countOnly` holds. */
  #requirePool(): Pool {
    if (!this.#pool) {
      throw new Error(
        'PostInserter: a write was attempted with no database connection ' +
          '(count-only mode should have short-circuited before this)'
      );
    }
    return this.#pool;
  }

  #tally(p: PostRow): void {
    // Keyed by site AND board, not board alone: archive_ten_billion_patched
    // carries may.not4chan.org and orly.yi.org alongside 4chan, and several of
    // those share board names. Keying on the board would silently merge them.
    const tkey = `${p.site}\t${p.board}`;
    const total = this.#totals.get(tkey);
    if (total) {
      total.posts++;
      if (p.isOp) {
        total.ops++;
      }
      if (p.postNo < total.minPostNo) {
        total.minPostNo = p.postNo;
      }
      if (p.postNo > total.maxPostNo) {
        total.maxPostNo = p.postNo;
      }
      if (p.tsUtc == null) {
        total.nullTs++;
      } else {
        if (total.minTs == null || p.tsUtc < total.minTs) {
          total.minTs = p.tsUtc;
        }
        if (total.maxTs == null || p.tsUtc > total.maxTs) {
          total.maxTs = p.tsUtc;
        }
        const m = monthKey(p.tsUtc);
        total.months.set(m, (total.months.get(m) ?? 0) + 1);
      }
    } else {
      const months = new Map<string, number>();
      if (p.tsUtc != null) {
        months.set(monthKey(p.tsUtc), 1);
      }
      this.#totals.set(tkey, {
        site: p.site,
        board: p.board,
        posts: 1,
        ops: p.isOp ? 1 : 0,
        nullTs: p.tsUtc == null ? 1 : 0,
        minPostNo: p.postNo,
        maxPostNo: p.postNo,
        minTs: p.tsUtc,
        maxTs: p.tsUtc,
        months,
      });
    }

    const year =
      p.tsUtc == null ? null : new Date(p.tsUtc * 1000).getUTCFullYear();
    // Tab-separated: neither a site nor a board name contains one, so the
    // key round-trips unambiguously when it is split apart in finish().
    const key = `${p.site}\t${p.board}\t${year ?? ''}`;
    const cell = this.#stats.get(key);
    if (cell) {
      cell.posts++;
      if (p.tsUtc != null) {
        if (cell.minTs == null || p.tsUtc < cell.minTs) {
          cell.minTs = p.tsUtc;
        }
        if (cell.maxTs == null || p.tsUtc > cell.maxTs) {
          cell.maxTs = p.tsUtc;
        }
      }
    } else {
      this.#stats.set(key, { posts: 1, minTs: p.tsUtc, maxTs: p.tsUtc });
    }
  }

  /**
   * Flushes any partially-filled buffer, then folds the tallies accumulated
   * so far into `post_stats`.
   *
   * Counts are added to whatever is already stored, so this is safe to call
   * repeatedly: each call contributes only what has been counted since the
   * last one. Adapters call it periodically as well as at the end — a single
   * flush at the end means an interrupted run loses every tally it had
   * accumulated, leaving post_stats short of `posts` until a full rebuild.
   */
  async finish(): Promise<void> {
    // Loop, because a coalesced #flush() only guarantees the drain that was
    // already in flight finished -- rows buffered after that drain's last
    // buffer check are still pending, and returning with any of them
    // unflushed would leave their waiters uncalled and hang the caller's
    // `Promise.all(pending)` forever. Looping here is safe (and not the
    // thundering herd #flush() avoids): finish() is called once per
    // checkpoint, and its caller is awaiting it, so nothing new is arriving.
    while (this.#buffer.length > 0 || this.#flushing) {
      await this.#flush();
    }
    // A count-only run must leave post_stats exactly as it found it: the
    // tallies describe rows that were never inserted, and folding them in
    // would inflate every count for a source already in the store.
    if (this.#countOnly) {
      this.#stats.clear();
      return;
    }
    const pool = this.#requirePool();
    for (const [key, c] of this.#stats) {
      const [site, board, year] = key.split('\t');
      await pool.query(
        `INSERT INTO post_stats (source_id, site, board, year, posts, min_ts, max_ts)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source_id, site, board, COALESCE(year, -1)) DO UPDATE SET
           posts  = post_stats.posts + excluded.posts,
           min_ts = CASE
                      WHEN post_stats.min_ts IS NULL THEN excluded.min_ts
                      WHEN excluded.min_ts IS NULL THEN post_stats.min_ts
                      ELSE LEAST(post_stats.min_ts, excluded.min_ts) END,
           max_ts = CASE
                      WHEN post_stats.max_ts IS NULL THEN excluded.max_ts
                      WHEN excluded.max_ts IS NULL THEN post_stats.max_ts
                      ELSE GREATEST(post_stats.max_ts, excluded.max_ts) END`,
        [
          this.#sourceId,
          site,
          board,
          year === '' ? null : Number(year),
          c.posts,
          c.minTs,
          c.maxTs,
        ]
      );
    }
    this.#stats.clear();
  }
}
