/**
 * Turns a Hayden scrape of a FoolFuuka archive into the standard NDJSON
 * layout, `<to>/<board>/posts.ndjson`.
 *
 * Hayden (https://github.com/bbepis/Hayden) writes one directory per thread:
 *
 *     <from>/<board>/<threadno>/thread.json
 *     <from>/<board>/<threadno>/thumbs/
 *     <from>/hayden/imagequeue.db          its own bookkeeping, not a board
 *
 * `thread.json` is Hayden's envelope -- `Thread.Posts[]`, each post carrying
 * Hayden's normalised fields (`PostNumber`, `TimePosted`, `Author`,
 * `ContentRaw`...) AND the upstream record verbatim in `OriginalObject`.
 * When the upstream is a FoolFuuka archive (Desuarchive), `OriginalObject`
 * is an Asagi-shaped post: `num`, `subnum`, `thread_num`, `timestamp`,
 * `name`, `trip`, `title`, `comment_sanitized`, nested `media`.
 *
 * **This reads `OriginalObject`, not Hayden's own fields.** Hayden's envelope
 * has no `Subject` -- the 15,010 titled posts in the first sample carried
 * their title only in the upstream record -- and its `ContentRaw` trims
 * trailing whitespace, so the upstream record is the fuller one and the one
 * whose names already match `NdjsonPost`. The envelope supplies the thread
 * list and nothing else. A post whose `OriginalObject` is not Asagi-shaped
 * (Hayden pointed at 4chan directly would produce read-API records) is
 * counted under `skipped`, never guessed at.
 *
 * `timestamp` is TRUE UTC and is copied across untouched. Measured, not
 * assumed: for every one of the 377,508 media posts in the sample, 4chan's
 * own `tim` upload time (UTC milliseconds, preserved in `media.exif`) matched
 * `timestamp` to within one second. New York wall time would have been off
 * by four or five hours.
 *
 * `comment_sanitized` is Asagi plain text -- `>` is a literal, `[code]` and
 * `[spoiler]` are Asagi's own tags -- the same convention the SQL sources
 * stage, so nothing is stripped here.
 *
 * Board and thread come from the path, as with every other reader here: the
 * `<threadno>` directory asserts the thread number, and the OP is the post
 * whose number equals it. `thread_num` in the record is checked against the
 * directory and any disagreement is counted, not resolved.
 *
 * Deleted posts (`deleted: 1`) are kept and counted. They are real posts
 * that a moderator later removed, which is exactly what the SQL sources'
 * `<board>_deleted` companions hold.
 *
 * Runs HERE, on the archive host: a multi-year board is over a million tiny
 * files, and collapsing them into one file per board is most of the point.
 *
 * Called from a source's prepare script, which tsdown bundles into a single
 * file to run on the archive host.
 */

export interface HaydenToNdjsonOptions {
  /**
   * The Hayden download root, holding one directory per board -- or several
   * of them, read in order. A scrape that arrives as a series of tarballs
   * extracts to one root per tarball; the writer appends, so a board split
   * across roots still ends up in one file. Ingest collapses any thread both
   * roots hold to one row per post.
   */
  from: string | string[];
  /** Where to build `<board>/posts.ndjson`. */
  to: string;
  /** Site label for every record; defaults to 4chan. */
  site?: string;
}

export interface HaydenToNdjsonStats {
  threads: number;
  posts: number;
  boards: number;
  /** Unreadable, or readable but not a Hayden thread file. */
  badFiles: number;
  /** Posts whose `OriginalObject` carried no numeric `num`. */
  skipped: number;
  /** Archive-side replies (`subnum != 0`), which are not 4chan posts. */
  ghost: number;
  noTs: number;
  /** Kept, but worth seeing: posts the upstream flagged deleted. */
  deleted: number;
  /** Records whose `thread_num` disagreed with the directory they sat in. */
  threadMismatch: number;
  /** Directories under `from` holding no numbered thread directories. */
  ignoredDirs: string[];
}

import { existsSync, opendirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NdjsonWriter } from 'staging-core';

/** The FoolFuuka API record Hayden preserves as `OriginalObject`. */
interface FuukaPost {
  num?: unknown;
  subnum?: unknown;
  thread_num?: unknown;
  timestamp?: unknown;
  name?: unknown;
  trip?: unknown;
  title?: unknown;
  comment_sanitized?: unknown;
  deleted?: unknown;
  media?: { media_filename?: unknown; media_hash?: unknown } | unknown;
}

interface HaydenPost {
  OriginalObject?: unknown;
}

interface HaydenThreadFile {
  Thread?: { Posts?: unknown };
}

const num = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

const str = (v: unknown): string | null =>
  typeof v === 'string' && v !== '' ? v : null;

/** Directory names under `dir`, unsorted. opendir: these can be huge. */
const subdirs = function* (dir: string): Generator<string> {
  const d = opendirSync(dir);
  try {
    let e;
    while ((e = d.readSync()) !== null) {
      if (e.isDirectory()) {
        yield e.name;
      }
    }
  } finally {
    d.closeSync();
  }
};

/** Does some `<board>/<digits>/thread.json` sit directly under `dir`? */
const isHaydenRoot = (dir: string): boolean => {
  for (const board of subdirs(dir)) {
    // Lazy on purpose: a board holds a million thread directories and the
    // first numbered one with a thread.json settles it.
    for (const name of subdirs(join(dir, board))) {
      if (
        /^\d+$/.test(name) &&
        existsSync(join(dir, board, name, 'thread.json'))
      ) {
        return true;
      }
    }
  }
  return false;
};

/**
 * Every Hayden download root at or under `dir`, sorted, to `depth` levels.
 *
 * A tarball of a scrape usually wraps the tree in a directory named for the
 * archive (`my-archive-1/g/...`), and where that wrapper lands depends on how
 * the tarball was made -- so the prepare script asks rather than assumes. A
 * directory that is itself a root is not searched further.
 */
export const findHaydenRoots = (dir: string, depth = 3): string[] => {
  if (!existsSync(dir)) {
    return [];
  }
  if (isHaydenRoot(dir)) {
    return [dir];
  }
  if (depth === 0) {
    return [];
  }
  const found: string[] = [];
  for (const name of [...subdirs(dir)].sort()) {
    found.push(...findHaydenRoots(join(dir, name), depth - 1));
  }
  return found;
};

export const haydenToNdjson = async (
  opts: HaydenToNdjsonOptions
): Promise<HaydenToNdjsonStats> => {
  const { from, to, site = '4chan' } = opts;
  const out = new NdjsonWriter(to);
  const stats: HaydenToNdjsonStats = {
    threads: 0,
    posts: 0,
    boards: 0,
    badFiles: 0,
    skipped: 0,
    ghost: 0,
    noTs: 0,
    deleted: 0,
    threadMismatch: 0,
    ignoredDirs: [],
  };
  let nextReport = 100_000;

  for (const root of Array.isArray(from) ? from : [from]) {
    for (const board of [...subdirs(root)].sort()) {
      const boardDir = join(root, board);
      let threadsInBoard = 0;

      for (const name of subdirs(boardDir)) {
        // A directory that is digits IN FULL asserts the thread number;
        // anything else under a board is not a thread.
        if (!/^\d+$/.test(name)) {
          continue;
        }
        const threadNo = Number(name);
        const path = join(boardDir, name, 'thread.json');

        let posts: HaydenPost[];
        try {
          const parsed = JSON.parse(
            readFileSync(path, 'utf8')
          ) as HaydenThreadFile;
          if (!Array.isArray(parsed.Thread?.Posts)) {
            // Well-formed but not a thread file. Counted, not thrown.
            stats.badFiles++;
            continue;
          }
          posts = parsed.Thread.Posts as HaydenPost[];
        } catch {
          // Missing or unreadable: a thread directory Hayden never finished.
          stats.badFiles++;
          continue;
        }

        for (const p of posts) {
          const o = (p.OriginalObject ?? null) as FuukaPost | null;
          const n = num(o?.num);
          if (o == null || n == null) {
            stats.skipped++;
            continue;
          }
          if ((num(o.subnum) ?? 0) !== 0) {
            stats.ghost++;
            continue;
          }
          const ts = num(o.timestamp);
          if (ts == null) {
            stats.noTs++;
          }
          if (num(o.thread_num) !== threadNo) {
            stats.threadMismatch++;
          }
          if (num(o.deleted) === 1) {
            stats.deleted++;
          }
          const media = (o.media ?? null) as {
            media_filename?: unknown;
            media_hash?: unknown;
          } | null;

          out.write({
            site,
            board,
            num: n,
            subnum: 0,
            thread_num: threadNo,
            op: n === threadNo ? 1 : 0,
            // Already a true UTC epoch; see the header.
            timestamp: ts,
            name: str(o.name),
            trip: str(o.trip),
            title: str(o.title),
            comment: str(o.comment_sanitized),
            media_filename: str(media?.media_filename),
            media_hash: str(media?.media_hash),
          });
          stats.posts++;
        }

        stats.threads++;
        threadsInBoard++;
        if (stats.threads >= nextReport) {
          console.log(
            `    ${stats.threads} thread(s) read, ${stats.posts} post(s)`
          );
          nextReport += 100_000;
        }
      }

      if (threadsInBoard === 0) {
        stats.ignoredDirs.push(join(root, board));
      }
    }
  }

  await out.close();
  stats.boards = out.boards;
  return stats;
};
