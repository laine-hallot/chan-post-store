import type { Pool } from 'pg';

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { type BoardFilter, makeBoardFilter } from '../boards.ts';
import { stripHtml } from '../html.ts';
import { collectPending, PostInserter } from '../ingest.ts';
import {
  CREATE_TABLE_RE,
  insertColumns,
  nyWallToUtc,
  parseTuples,
  takeCompleteTuples,
} from '../mysqldump.ts';
import { makeBar } from '../progress.ts';

/**
 * Ingests the pre-Fuuka archives that store one flat `posts` table joined to a
 * `threads` table, rather than one table per board.
 *
 * Two archives share this shape and neither is Fuuka/Asagi in any respect:
 *
 *   archive_ten_billion_patched  (chanarchive, 2005-2008, 162M posts)
 *   4archive                     (4archive.org, 2014-2015, 9.75M posts, incl /b/)
 *
 * They are structurally identical and lexically different -- chanarchive says
 * commentid/threadid/number/postdate where 4archive says
 * id/threads_id/chan_id/chan_post_date -- so the difference lives in a DIALECT
 * table rather than in two adapters. Which dialect applies is detected from the
 * CREATE TABLE columns, never declared in the manifest, so a manifest cannot
 * disagree with the file it points at.
 *
 * WHY THE BOARD NEEDS A JOIN. In every other SQL source here the board is the
 * table name. Here `posts` carries only a LOCAL foreign key to `threads`, and
 * the board lives over there -- as a plain column in 4archive, and only inside
 * the thread's URL in chanarchive. A post row on its own cannot say what board
 * it is from, which is why this adapter reads the file TWICE: mysqldump emits
 * `posts` before `threads` (alphabetical), so the index cannot be built on the
 * way past. The first pass reads threads only.
 *
 * The thread index is typed arrays indexed by the local id, not a Map. Both
 * dumps use dense AUTO_INCREMENT keys (chanarchive reaches 10,849,597 threads),
 * and a Map of that many number->object entries costs hundreds of MB where two
 * typed arrays cost ~54MB.
 *
 * NOT EVERY POST IS FROM 4CHAN. chanarchive's thread URLs include
 * may.not4chan.org alongside img/cgi/orz/zip.4chan.org, which is the "handful
 * are from outside 4Chan" its uploader warned about. `site` is therefore taken
 * per-thread from the URL, NOT from manifest.site -- stamping everything
 * "4chan" would both misattribute those posts and let them collide with real
 * 4chan post numbers under UNIQUE (site, board, post_no), silently displacing
 * genuine rows.
 *
 * TIMESTAMPS ARE A DATETIME STRING, not an epoch: '2006-05-25 01:44:00', at
 * minute precision (seconds are always :00 -- the boards of that era displayed
 * no seconds, so they are recorded rather than invented). They are read as
 * America/New_York wall time and converted with nyWallToUtc, consistent with
 * every other 4chan-era archive here.
 *
 * That could not be checked the way desuarchive-sql's was, by diffing posts
 * shared with another source: this corpus is 2005-2008 and the store holds
 * almost nothing from before 2008, so a 4,000-post sample found zero overlap.
 * The diurnal curve corroborates it instead. With the conversion applied,
 * activity peaks at 23:00-00:00 UTC and bottoms out at 11:00 UTC -- i.e. 18:00
 * and 06:00 US Eastern, an evening peak and a pre-dawn trough, which is the
 * expected shape for this userbase. Had the stored values already been UTC,
 * the conversion would have shifted that to a 13:00 Eastern peak and a 01:00
 * trough, which is not a plausible curve. Corroborating, not conclusive:
 * re-check against a 2008 overlap once the full dump is ingested.
 *
 * Bodies carry HTML entities ('&gt;&gt;17816') and go through stripHtml, which
 * also turns <br> into newlines and drops tags.
 */

interface Dialect {
  name: string;
  /** Columns that must all be present for this dialect to match. */
  threadCols: string[];
  postCols: string[];
  threads: { key: string; threadNo: string; board?: string; url?: string };
  posts: {
    threadRef: string;
    postNo: string;
    date: string;
    body: string;
    name?: string;
    trip?: string;
    subject?: string;
    media?: string;
  };
}

const DIALECTS: Dialect[] = [
  {
    name: 'chanarchive',
    threadCols: ['threadid', 'threadurl', 'number'],
    postCols: ['commentid', 'threadid', 'number', 'postdate', 'body'],
    threads: { key: 'threadid', threadNo: 'number', url: 'threadurl' },
    posts: {
      threadRef: 'threadid',
      postNo: 'number',
      date: 'postdate',
      body: 'body',
      name: 'name',
      trip: 'tripcode',
      subject: 'subject',
    },
  },
  {
    name: '4archive',
    threadCols: ['id', 'thread_id', 'board'],
    postCols: ['id', 'chan_id', 'threads_id', 'chan_post_date', 'body'],
    threads: { key: 'id', threadNo: 'thread_id', board: 'board' },
    posts: {
      threadRef: 'threads_id',
      postNo: 'chan_id',
      date: 'chan_post_date',
      body: 'body',
      name: 'name',
      trip: 'tripcode',
      subject: 'subject',
      media: 'original_image_name',
    },
  },
];

/**
 * 'YYYY-MM-DD HH:MM:SS' as New-York wall time, in epoch seconds.
 * Returns null for MySQL's zero date and anything unparseable.
 */
const parseDateTime = (s: string | null): number | null => {
  if (!s) {
    return null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) {
    return null;
  }
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y === 0) {
    return null;
  } // '0000-00-00 00:00:00'
  const wall = Date.UTC(y, mo - 1, d, h, mi, se) / 1000;
  return Number.isFinite(wall) ? nyWallToUtc(wall) : null;
};

/**
 * Board and site from a chanarchive thread URL.
 * 'http://orz.4chan.org/d/res/177990.html' -> { board: 'd', site: '4chan' }
 *
 * 4chan served this era from several hostnames -- img, cgi, orz and zip, all
 * under 4chan.org -- which MUST collapse to the single site "4chan", or its
 * posts stop deduplicating against every other source in the store.
 *
 * Everything else keeps its full hostname. The obvious shortcut, taking the
 * second-level domain, is wrong: orly.yi.org was an early imageboard hosted on
 * the yi.org dynamic-DNS service, so that rule labels it "yi" after the DNS
 * provider and would silently merge it with any other yi.org board. Since
 * UNIQUE (site, board, post_no) means a wrong site label lets unrelated boards
 * collide and displace each other, the safe default is to never merge hosts
 * that have not been shown to be the same site.
 */
const fromUrl = (
  url: string | null
): { board: string; site: string } | null => {
  if (!url) {
    return null;
  }
  const m = /^[a-z]+:\/\/([^/]+)\/([^/]+)\//i.exec(url);
  if (!m) {
    return null;
  }
  const host = m[1].toLowerCase();
  const site =
    host === '4chan.org' || host.endsWith('.4chan.org') ? '4chan' : host;
  return { board: m[2], site };
};

interface IngestStats {
  posts: number;
  skippedDup: number;
  threads: number;
  noThread: number;
  /** Posts dropped because their thread's board is excluded by the manifest. */
  excludedPosts: number;
  badLines: number;
  tables: string[];
}

/**
 * Growable typed-array store for the thread index.
 *
 * Board exclusion is resolved HERE rather than at the post loop, for two
 * reasons. Cost: labels are interned, so `reject` runs once per distinct
 * (site, board) -- a handful of calls -- instead of once per post, which
 * would put a `toLowerCase` and a Set probe on the hot path for every one of
 * hundreds of millions of rows. Correctness: an excluded thread must still be
 * *found* by the post loop. Dropping it from the index instead would make its
 * posts indistinguishable from genuine orphans, and `noThread` is a real
 * diagnostic here (3.0% on the ten-billion archive) that must not be polluted
 * by rows we chose to discard.
 */
class ThreadIndex {
  #no = new Uint32Array(1 << 20);
  #key = new Uint16Array(1 << 20);
  #names: string[] = [];
  #byName = new Map<string, number>();
  /** Parallel to #names: is this interned (site, board) excluded? */
  #excluded: boolean[] = [];
  #filter: BoardFilter;
  max = 0;

  constructor(filter: BoardFilter) {
    this.#filter = filter;
  }

  #grow(need: number): void {
    if (need < this.#no.length) {
      return;
    }
    let n = this.#no.length;
    while (n <= need) {
      n *= 2;
    }
    const no = new Uint32Array(n);
    no.set(this.#no);
    const key = new Uint16Array(n);
    key.set(this.#key);
    this.#no = no;
    this.#key = key;
  }

  set(id: number, threadNo: number, board: string, site: string): void {
    this.#grow(id);
    const label = `${site}\0${board}`;
    let k = this.#byName.get(label);
    if (k === undefined) {
      k = this.#names.length;
      this.#names.push(label);
      this.#byName.set(label, k);
      // Once per distinct board, not once per thread or post.
      this.#excluded.push(this.#filter.reject(board));
    }
    this.#no[id] = threadNo;
    this.#key[id] = k;
    if (id > this.max) {
      this.max = id;
    }
  }

  get(id: number): {
    threadNo: number;
    board: string;
    site: string;
    excluded: boolean;
  } | null {
    if (id <= 0 || id >= this.#no.length || this.#no[id] === 0) {
      return null;
    }
    const k = this.#key[id];
    const [site, board] = this.#names[k].split('\0');
    return { threadNo: this.#no[id], board, site, excluded: this.#excluded[k] };
  }
}

/** Stream a dump, yielding [table, columnOrder, tuple] for accepted tables. */
const scan = async (
  file: string,
  wanted: string,
  cols: Map<string, string[]>,
  onRow: (
    vals: (string | null)[],
    idx: Record<string, number>
  ) => Promise<void> | void,
  onBytes?: (n: number) => void
): Promise<void> => {
  const input = createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
  if (onBytes) {
    input.on('data', (c: string | Buffer) => onBytes(c.length));
  }
  const lines = createInterface({ input, crlfDelay: Infinity });

  let creating: string | null = null;
  let idx: Record<string, number> | null = null;
  /** Unconsumed text of an accepted statement whose last tuple is still open. */
  let buf = '';

  /** Emit every complete tuple in `buf`, keeping the trailing fragment. */
  const drain = async (): Promise<void> => {
    if (!idx) {
      return;
    }
    const { tuples, rest } = takeCompleteTuples(buf);
    buf = rest;
    for (const t of tuples) {
      const vals = parseTuples(t, 0).next().value;
      if (vals) {
        await onRow(vals, idx);
      }
    }
  };

  for await (const line of lines) {
    if (creating !== null) {
      const col = /^\s*`([^`]+)`/.exec(line);
      if (col) {
        cols.get(creating)!.push(col[1]);
      } else if (line.startsWith(')')) {
        creating = null;
      }
      continue;
    }

    // Mid-statement: a post body may contain a LITERAL newline, so a single
    // INSERT can span lines and a tuple's extent is only knowable with quote
    // state carried across them. 4archive has statements 416KB long that end
    // mid-string. An unbalanced buffer proves we are inside a literal, so a
    // line can only start a new statement when the buffer is empty.
    if (buf.length > 0) {
      buf += '\n' + line;
      await drain();
      continue;
    }

    const create = CREATE_TABLE_RE.exec(line);
    if (create) {
      creating = create[1];
      // Always reset. `cols` is shared across the two passes, and each pass
      // re-reads every CREATE TABLE -- appending instead would double the
      // column list on pass 2, shifting every index and turning each field
      // into undefined.
      cols.set(creating, []);
      continue;
    }
    if (!line.startsWith('INSERT INTO `')) {
      continue;
    }
    const tick = line.indexOf('`', 13);
    if (line.slice(13, tick) !== wanted) {
      continue;
    }
    const valuesAt = line.indexOf(' VALUES', tick);
    if (valuesAt < 0) {
      continue;
    }

    const listed = insertColumns(line, tick + 1, valuesAt);
    const order = listed ?? cols.get(wanted);
    if (!order || order.length === 0) {
      continue;
    }
    if (!idx || listed) {
      idx = {};
      order.forEach((c, i) => (idx![c] = i));
    }
    buf = line.slice(valuesAt + 7);
    await drain();
  }

  // Anything still buffered at EOF is a statement the dump truncated.
  if (buf.trim().length > 0) {
    console.error(
      `  warning: ${buf.length} bytes left unparsed at end of ${file}`
    );
  }
};

export const ingestPostsThreadsSql = async (
  db: Pool,
  opts: {
    file: string;
    sourceId: number;
    site: string;
    boards?: string[];
    excludeBoards?: string[];
    fileSize?: number;
  }
): Promise<IngestStats> => {
  const boardFilter = makeBoardFilter(opts.excludeBoards);
  const inserter = new PostInserter(db, opts.sourceId);
  const stats: IngestStats = {
    posts: 0,
    skippedDup: 0,
    threads: 0,
    noThread: 0,
    excludedPosts: 0,
    badLines: 0,
    tables: [],
  };

  // ---- pass 1: the thread index ----------------------------------------
  const cols = new Map<string, string[]>();
  const index = new ThreadIndex(boardFilter);
  let bar = makeBar({ max: opts.fileSize });
  bar.start(`indexing threads in ${opts.file}`);
  let read = 0;

  // Which dialect applies is not known until the CREATE TABLEs have been
  // seen, so resolve it lazily on the first threads row.
  let dialect: Dialect | null = null;

  await scan(
    opts.file,
    'threads',
    cols,
    (vals, idx) => {
      if (!dialect) {
        const have = Object.keys(idx);
        dialect =
          DIALECTS.find((d) => d.threadCols.every((c) => have.includes(c))) ??
          null;
        if (!dialect) {
          return;
        }
        stats.tables.push(`threads(${dialect.name})`);
      }
      const t = dialect.threads;
      const id = Number(vals[idx[t.key]]);
      const threadNo = Number(vals[idx[t.threadNo]]);
      if (!Number.isFinite(id) || !Number.isFinite(threadNo)) {
        stats.badLines++;
        return;
      }
      let board: string, site: string;
      if (t.board) {
        board = (vals[idx[t.board]] ?? '').trim();
        site = opts.site;
      } else {
        const u = fromUrl(vals[idx[t.url!]]);
        if (!u) {
          stats.badLines++;
          return;
        }
        ({ board, site } = u);
      }
      if (!board) {
        stats.badLines++;
        return;
      }
      index.set(id, threadNo, board, site);
      stats.threads++;
    },
    (n) => {
      read += n;
      bar.advance(
        n,
        `${(read / 1e6).toFixed(0)}MB, ${stats.threads} threads indexed`
      );
    }
  );
  bar.stop(`indexed ${stats.threads} threads`);

  if (!dialect) {
    return stats; // no recognised threads table; nothing joinable here
  }
  const D: Dialect = dialect;

  // ---- pass 2: the posts ------------------------------------------------
  const COMMIT_EVERY = 50_000;
  let sinceCommit = 0;
  const pending: Promise<void>[] = [];
  read = 0;
  bar = makeBar({ max: opts.fileSize });
  bar.start(`reading posts from ${opts.file}`);

  await scan(
    opts.file,
    'posts',
    cols,
    async (vals, idx) => {
      const p = D.posts;
      if (stats.tables.length === 1) {
        stats.tables.push(`posts(${D.name})`);
      }
      const ref = Number(vals[idx[p.threadRef]]);
      const postNo = Number(vals[idx[p.postNo]]);
      if (!Number.isFinite(ref) || !Number.isFinite(postNo)) {
        stats.badLines++;
        return;
      }
      const t = index.get(ref);
      if (!t) {
        // A post whose thread row is absent has no board and cannot be
        // attributed; counted rather than guessed at.
        stats.noThread++;
        return;
      }
      if (t.excluded) {
        stats.excludedPosts++;
        return;
      }
      if (opts.boards && !opts.boards.includes(t.board)) {
        return;
      }

      const body = vals[idx[p.body]];
      collectPending(
        pending,
        inserter
          .insert({
            site: t.site,
            board: t.board,
            threadNo: t.threadNo,
            postNo,
            isOp: postNo === t.threadNo,
            tsUtc: parseDateTime(vals[idx[p.date]]),
            name: p.name ? (vals[idx[p.name]] ?? null) : null,
            tripcode: p.trip ? (vals[idx[p.trip]] ?? null) : null,
            subject: p.subject ? (vals[idx[p.subject]] ?? null) : null,
            bodyText: body ? stripHtml(body) : null,
            mediaFilename: p.media ? (vals[idx[p.media]] ?? null) : null,
            mediaMd5: null,
          })
          .then((ok) => {
            if (ok) {
              stats.posts++;
            } else {
              stats.skippedDup++;
            }
          })
      );
      if (++sinceCommit >= COMMIT_EVERY) {
        await inserter.finish();
        await Promise.all(pending);
        pending.length = 0;
        sinceCommit = 0;
      }
    },
    (n) => {
      read += n;
      bar.advance(n, `${(read / 1e6).toFixed(0)}MB, ${stats.posts} posts`);
    }
  );

  await inserter.finish();
  await Promise.all(pending);
  bar.stop(
    `${stats.posts} posts from ${stats.threads} threads` +
      (stats.noThread ? ` (${stats.noThread} posts with no thread row)` : '') +
      (stats.excludedPosts
        ? `, ${stats.excludedPosts} posts dropped from` +
          ` [${[...boardFilter.counts.keys()].join(', ')}]`
        : '')
  );
  return stats;
};
