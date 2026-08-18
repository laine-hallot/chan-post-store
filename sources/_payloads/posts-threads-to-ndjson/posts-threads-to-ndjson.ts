// Part of a prepare payload: this file is uploaded to whichever machine holds
// the archives and run there. It may import only `node:` builtins and its own
// siblings -- nothing from this repo is resolvable at that point.
//
// Node strips the types at load; no build step, so no syntax that emits code.

/**
 * Turns the pre-Fuuka archives -- one flat `posts` table joined to a
 * `threads` table -- into the standard NDJSON layout,
 * `<to>/<board>/posts.ndjson`.
 *
 *     archive_ten_billion_patched  (chanarchive, 2005-2008, 162M posts)
 *     4archive                     (4archive.org, 2014-2015, 9.75M posts)
 *
 * These are the only sources that cannot be one file per board on their own.
 * In every other SQL dump the board IS the table name; here `posts` carries
 * only a local foreign key into `threads`, and the board lives over there --
 * a plain column in 4archive, and only inside the thread's URL in chanarchive.
 * A post row cannot say what board it is from, so the join has to happen
 * somewhere. Doing it here means the sql reader has exactly one shape to know.
 *
 * **One pass over the big part.** mysqldump emits `posts` before `threads`
 * alphabetically, so the original adapter read the whole file twice. But
 * `threads` is one contiguous block at the END -- 6.6MB after 2.92GB in
 * 4archive, 660MB after 28.8GB in ten-billion -- so scanning backwards for
 * its CREATE TABLE and reading that block first builds the index without
 * touching the rest. `posts` is then streamed once. 64.6GB of reads becomes
 * 32.3GB.
 *
 * The offset is FOUND, not hardcoded: the step self-locates and fails loudly
 * if the marker is absent, so it cannot silently half-work on a dump whose
 * layout differs.
 *
 * Which dialect applies is detected from the CREATE TABLE columns, never
 * declared, so a manifest cannot disagree with the file it points at.
 *
 * Timestamps are a DATETIME string at minute precision ('2006-05-25 01:44:00'
 * -- the boards of that era displayed no seconds, so :00 is recorded rather
 * than invented), read as America/New_York wall time and converted, because
 * NDJSON's contract is true UTC.
 *
 * Non-4chan hosts are dropped. chanarchive's thread URLs include
 * may.not4chan.org and orly.yi.org alongside img/cgi/orz/zip.4chan.org; those
 * are other imageboards, and mixing them in under site=4chan would both
 * misattribute the posts and let them collide with real 4chan post numbers.
 * If they are ever wanted they get their own manifest and their own site.
 * The count is reported separately from `noThread`, which is a real
 * diagnostic (3.0% on ten-billion) that must not absorb rows we chose to
 * discard.
 */

import {
  createReadStream,
  createWriteStream,
  mkdirSync,
  openSync,
  readSync,
  closeSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';

import { DIALECTS, ThreadIndex, fromUrl, parseDateTime } from './dialects.ts';
import { readLines } from './lines.ts';
import {
  CREATE_TABLE_RE,
  insertColumns,
  parseTuples,
  takeCompleteTuples,
} from './sqldump.ts';
import { stripHtml } from './text.ts';

const arg = (name: string, fallback?: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) {
    return process.argv[i + 1];
  }
  if (fallback !== undefined) {
    return fallback;
  }
  console.error(`missing required --${name}`);
  process.exit(2);
};

const FROM = arg('from');
const TO = arg('to');
const SITE = arg('site', '4chan');

/**
 * Byte offset of the `threads` CREATE TABLE, found by reading backwards.
 *
 * Backwards because the block is at the end and the file is up to 29GB: a
 * forward scan to find it would be the very pass this exists to avoid.
 */
const findThreadsOffset = (file: string): number => {
  const { size } = statSync(file);
  const CHUNK = 8 << 20;
  const OVERLAP = 64; // a marker split across two reads
  const fd = openSync(file, 'r');
  try {
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const len = end - start;
      const buf = Buffer.allocUnsafe(len);
      readSync(fd, buf, 0, len, start);
      const at = buf.lastIndexOf('CREATE TABLE `threads`');
      if (at >= 0) {
        return start + at;
      }
      if (start === 0) {
        break;
      }
      end = start + OVERLAP;
    }
  } finally {
    closeSync(fd);
  }
  console.error(`no "CREATE TABLE \`threads\`" in ${file}`);
  process.exit(1);
};

/**
 * Stream one region of a dump, yielding tuples of the wanted table.
 *
 * `cols` is shared with the caller and RESET at each CREATE TABLE: appending
 * instead doubles the column list on a second call and turns every field into
 * undefined.
 */
const scan = async (
  file: string,
  wanted: string,
  cols: Map<string, string[]>,
  onRow: (vals: (string | null)[], idx: Record<string, number>) => void,
  range: { start?: number; end?: number }
): Promise<number> => {
  const input = createReadStream(file, {
    highWaterMark: 4 << 20,
    start: range.start,
    end: range.end,
  });
  let creating: string | null = null;
  let idx: Record<string, number> | null = null;
  let buf = '';
  let bad = 0;

  const drain = (): void => {
    if (!idx) {
      return;
    }
    const { tuples, rest } = takeCompleteTuples(buf);
    buf = rest;
    for (const t of tuples) {
      try {
        const vals = parseTuples(t, 0).next().value;
        if (vals) {
          onRow(vals, idx);
        }
      } catch {
        bad++;
      }
    }
  };

  for await (const line of readLines(input)) {
    if (creating !== null) {
      const col = /^\s*`([^`]+)`/.exec(line);
      if (col) {
        cols.get(creating)!.push(col[1]);
      } else if (line.startsWith(')')) {
        creating = null;
      }
      continue;
    }
    if (idx !== null) {
      if (buf.length === 0 && line.startsWith('INSERT INTO `')) {
        idx = null;
      } else {
        buf += (buf.length ? '\n' : '') + line;
        drain();
        continue;
      }
    }
    const create = CREATE_TABLE_RE.exec(line);
    if (create) {
      creating = create[1];
      cols.set(creating, []);
      continue;
    }
    if (!line.startsWith('INSERT INTO `')) {
      continue;
    }
    const tick = line.indexOf('`', 13);
    const table = line.slice(13, tick);
    if (table !== wanted) {
      continue;
    }
    const valuesAt = line.indexOf(' VALUES', tick);
    if (valuesAt < 0) {
      continue;
    }
    const order = insertColumns(line, tick + 1, valuesAt) ?? cols.get(table);
    if (!order) {
      continue;
    }
    const m: Record<string, number> = {};
    order.forEach((c, i) => (m[c] = i));
    idx = m;
    buf = line.slice(valuesAt + 7);
    drain();
  }
  if (buf.trim().length > 0) {
    bad++;
  }
  return bad;
};

const threadsAt = findThreadsOffset(FROM);
const cols = new Map<string, string[]>();
const index = new ThreadIndex();
const stats = {
  threads: 0,
  foreign: 0,
  posts: 0,
  noThread: 0,
  bad: 0,
  noTs: 0,
};

// ---- pass 1: the trailing threads block only -----------------------------
stats.bad += await scan(
  FROM,
  'threads',
  cols,
  (vals, idx) => {
    const dialect = DIALECTS.find((d) => d.threadCols.every((c) => c in idx));
    if (!dialect) {
      return;
    }
    const id = Number(vals[idx[dialect.threads.key]]);
    const threadNo = Number(vals[idx[dialect.threads.threadNo]]);
    if (!Number.isInteger(id) || id <= 0) {
      return;
    }
    let board: string | null = null;
    let site = SITE;
    if (dialect.threads.board) {
      board = vals[idx[dialect.threads.board]];
    } else if (dialect.threads.url) {
      const u = fromUrl(vals[idx[dialect.threads.url]]);
      if (u) {
        board = u.board;
        site = u.site;
      }
    }
    if (!board) {
      return;
    }
    if (site !== SITE) {
      // Another imageboard swept up by the same crawl.
      stats.foreign++;
      return;
    }
    index.set(id, threadNo, board, site);
    stats.threads++;
  },
  { start: threadsAt }
);

console.log(
  `    indexed ${stats.threads} thread(s), ${stats.foreign} not ${SITE}`
);

// ---- pass 2: posts, streamed once ---------------------------------------
const writers = new Map<string, ReturnType<typeof createWriteStream>>();
const writerFor = (board: string): ReturnType<typeof createWriteStream> => {
  let w = writers.get(board);
  if (!w) {
    mkdirSync(join(TO, board), { recursive: true });
    w = createWriteStream(join(TO, board, 'posts.ndjson'));
    writers.set(board, w);
  }
  return w;
};

cols.clear();
stats.bad += await scan(
  FROM,
  'posts',
  cols,
  (vals, idx) => {
    const dialect = DIALECTS.find((d) => d.postCols.every((c) => c in idx));
    if (!dialect) {
      return;
    }
    const p = dialect.posts;
    const t = index.get(Number(vals[idx[p.threadRef]]));
    if (!t) {
      // Its thread row is gone -- deleted from the archive, or dropped above
      // as another imageboard. A real diagnostic, ~18% on 4archive.
      stats.noThread++;
      return;
    }
    const postNo = Number(vals[idx[p.postNo]]);
    if (!Number.isInteger(postNo) || postNo <= 0) {
      return;
    }
    const ts = parseDateTime(vals[idx[p.date]]);
    if (ts == null) {
      stats.noTs++;
    }
    const body = vals[idx[p.body]];
    writerFor(t.board).write(
      JSON.stringify({
        site: t.site,
        board: t.board,
        num: postNo,
        subnum: 0,
        thread_num: t.threadNo,
        op: postNo === t.threadNo ? 1 : 0,
        timestamp: ts,
        name: p.name ? (vals[idx[p.name]] ?? null) : null,
        trip: p.trip ? (vals[idx[p.trip]] ?? null) : null,
        title: p.subject ? (vals[idx[p.subject]] ?? null) : null,
        // Bodies carry HTML entities ('&gt;&gt;17816').
        comment: body != null ? stripHtml(body) : null,
        media_filename: p.media ? (vals[idx[p.media]] ?? null) : null,
        media_hash: null,
      }) + '\n'
    );
    stats.posts++;
  },
  { end: threadsAt - 1 }
);

await Promise.all(
  [...writers.values()].map(
    (w) =>
      new Promise<void>((res, rej) => {
        w.end((err?: Error | null) => (err ? rej(err) : res()));
      })
  )
);

console.log(
  `    ${stats.posts} post(s) into ${writers.size} board file(s)\n` +
    `    ${stats.noThread} with no thread row, ${stats.foreign} thread(s) dropped as not ${SITE},\n` +
    `    ${stats.bad} unparsable, ${stats.noTs} with no timestamp`
);
