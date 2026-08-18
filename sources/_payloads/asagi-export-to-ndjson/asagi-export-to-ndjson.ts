// Part of a prepare payload: this file is uploaded to whichever machine holds
// the archives and run there. It may import only `node:` builtins and its own
// siblings -- nothing from this repo is resolvable at that point.
//
// Node strips the types at load; no build step, so no syntax that emits code.

/**
 * Normalises a Desuarchive NDJSON export into the standard layout,
 * `<to>/<board>/posts.ndjson`.
 *
 * The export is Asagi-shaped and very nearly the standard format already,
 * which is exactly why it is worth a converter rather than a tolerant reader.
 * Three differences, none visible from the field names:
 *
 *   - **The numbers are strings.** `"num":"1"`, `"op":"1"`, `"subnum":"0"` --
 *     but `timestamp` is a real number. A reader that accepted both would be
 *     accepting two shapes forever.
 *   - **`board` is an object**, `{"name":"Pony","shortname":"mlp"}`, not the
 *     slug. The slug is `shortname`.
 *   - **`media_filename` and `media_hash` are nested** inside a `media`
 *     object, alongside a dozen fields describing the archive's own copy of
 *     the image.
 *
 * `timestamp` is already true UTC here and is copied across untouched -- which
 * is the opposite of the same archive's 2019 mysqldump exports, where it is
 * New York wall time. That is why the convention belongs to the staged format
 * rather than being inferred per source.
 *
 * Lines are split on "\n" alone: `JSON.stringify` leaves U+2028 raw in its
 * output and post bodies contain it, so anything that also breaks on U+2028
 * would cut a record in half. See lines.ts.
 */

import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { readLines } from './lines.ts';

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

/** These exports quote their integers; a reader should not have to guess. */
const num = (v: unknown): number | null => {
  if (typeof v === 'number') {
    return Number.isFinite(v) ? v : null;
  }
  if (typeof v === 'string' && v !== '' && /^-?\d+$/.test(v)) {
    return Number(v);
  }
  return null;
};

const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

interface Record_ {
  num?: unknown;
  subnum?: unknown;
  thread_num?: unknown;
  op?: unknown;
  timestamp?: unknown;
  name?: unknown;
  trip?: unknown;
  title?: unknown;
  comment?: unknown;
  board?: { shortname?: unknown } | unknown;
  media?: { media_filename?: unknown; media_hash?: unknown } | unknown;
}

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

const stats = { posts: 0, ghost: 0, bad: 0, noBoard: 0, noTs: 0 };
let bytes = 0;
let nextReport = 5e9;

for await (const line of readLines(createReadStream(FROM), (n) => {
  bytes += n;
})) {
  if (line === '') {
    continue;
  }
  let r: Record_;
  try {
    r = JSON.parse(line) as Record_;
  } catch {
    stats.bad++;
    continue;
  }
  const n = num(r.num);
  if (n == null) {
    stats.bad++;
    continue;
  }
  // Ghost posts: replies made on the archive site rather than on 4chan.
  if ((num(r.subnum) ?? 0) !== 0) {
    stats.ghost++;
    continue;
  }
  const board = str((r.board as { shortname?: unknown } | null)?.shortname);
  if (!board) {
    stats.noBoard++;
    continue;
  }
  const thread = num(r.thread_num) || n;
  const ts = num(r.timestamp);
  if (ts == null) {
    stats.noTs++;
  }
  const media = (r.media ?? null) as {
    media_filename?: unknown;
    media_hash?: unknown;
  } | null;

  writerFor(board).write(
    JSON.stringify({
      site: SITE,
      board,
      num: n,
      subnum: 0,
      thread_num: thread,
      op: (num(r.op) ?? 0) === 1 ? 1 : 0,
      timestamp: ts,
      name: str(r.name),
      trip: str(r.trip),
      title: str(r.title),
      comment: str(r.comment),
      media_filename: str(media?.media_filename),
      media_hash: str(media?.media_hash),
    }) + '\n'
  );
  stats.posts++;
  if (bytes > nextReport) {
    console.log(`    ${(bytes / 1e9).toFixed(0)}GB read, ${stats.posts} posts`);
    nextReport += 5e9;
  }
}

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
    `    ${stats.ghost} ghost, ${stats.bad} unparsable, ` +
    `${stats.noBoard} with no board, ${stats.noTs} with no timestamp`
);
