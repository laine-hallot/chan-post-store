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
 * would cut a record in half. See `readLines`.
 *
 * Called from a source's prepare script, which tsdown bundles into a single
 * file to run on the archive host.
 */

export interface AsagiExportOptions {
  /** The `.ndjson` export to read. */
  from: string;
  /** Where to build `<board>/posts.ndjson`. */
  to: string;
  /** Site label for every record; defaults to 4chan. */
  site?: string;
}

export interface AsagiExportStats {
  posts: number;
  boards: number;
  ghost: number;
  bad: number;
  noBoard: number;
  noTs: number;
}

import { createReadStream } from 'node:fs';
import { NdjsonWriter, readLines } from 'staging-core';

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

export const asagiExportToNdjson = async (
  opts: AsagiExportOptions
): Promise<AsagiExportStats> => {
  const { from, to, site = '4chan' } = opts;
  const out = new NdjsonWriter(to);
  const stats = { posts: 0, boards: 0, ghost: 0, bad: 0, noBoard: 0, noTs: 0 };
  let bytes = 0;
  let nextReport = 5e9;

  for await (const line of readLines(createReadStream(from), (n) => {
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

    out.write({
      site,
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
    });
    stats.posts++;
    if (bytes > nextReport) {
      console.log(
        `    ${(bytes / 1e9).toFixed(0)}GB read, ${stats.posts} posts`
      );
      nextReport += 5e9;
    }
  }

  await out.close();
  stats.boards = out.boards;
  return stats;
};
