// Part of a prepare payload: this file is uploaded to whichever machine holds
// the archives and run there. It may import only `node:` builtins and its own
// siblings -- nothing from this repo is resolvable at that point.
//
// Node strips the types at load; no build step, so no syntax that emits code.

/**
 * Turns a crawl of rendered third-party archive pages into the standard
 * NDJSON layout, `<to>/<board>/posts.ndjson`.
 *
 * fybertech's 638 thread pages span three markup generations -- 420 classic
 * Futaba, 190 in its own later template, and 20 in 4chan's own. This handles
 * the first two; the native ones are staged as HTML by `stage-html` and read
 * directly by the `html` adapter, so a page carrying `.postContainer` is
 * skipped here rather than parsed twice.
 *
 * Runs HERE, on the archive host, rather than over the mount. The
 * yotsubasociety mirror is 23,295 pages, and walking that tree over NFS from
 * the other machine is what takes the mount down.
 *
 * Records use Asagi field names and a TRUE UTC `timestamp`, which is the
 * NDJSON half of the standard format: the displayed `04/08/08(Tue)03:16` is
 * New York wall time and is converted on the way out, so the reader never has
 * to know which archive a record came from.
 *
 * Usage: node html-to-ndjson.ts --from <dir> --to <dir> [--site <name>]
 */

import {
  readdirSync,
  readFileSync,
  mkdirSync,
  createWriteStream,
} from 'node:fs';
import { basename, join } from 'node:path';

import { parse, readAnyGeneration, type ParsedPost } from './markup.ts';

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

/** Asset directories these mirrors keep beside their pages. */
const ASSET_DIR = /(?:_files|^css|^js|^images|^thumbs)$/i;
/**
 * A staged page's own image directory, `a_10781807/` next to
 * `a_10781807.html`. Not an asset dir by name, but descending into it treats
 * the page id as a board -- harmless while those dirs hold only images, and
 * silently wrong the moment one holds a stray .html.
 */
const PAGE_ASSET_DIR = /^[a-z0-9]+_\d+$/i;
const PAGE = /\.html?$/i;

interface Page {
  path: string;
  name: string;
  /** Board from the parent directory, or null in a flat tree. */
  board: string | null;
}

/**
 * Both layouts at once, not as alternatives: the yotsubasociety mirror has 63
 * board directories AND board index pages sitting beside them, and treating
 * "the root has HTML in it" as proof of flatness found 53 pages where there
 * were 23,295.
 */
const listPages = (root: string): Page[] => {
  const out: Page[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (ASSET_DIR.test(e.name) || PAGE_ASSET_DIR.test(e.name)) {
        continue;
      }
      for (const f of readdirSync(join(root, e.name), {
        withFileTypes: true,
      })) {
        if (f.isFile() && PAGE.test(f.name)) {
          out.push({
            path: join(root, e.name, f.name),
            name: f.name,
            board: e.name,
          });
        }
      }
      continue;
    }
    if (e.isFile() && PAGE.test(e.name)) {
      out.push({ path: join(root, e.name), name: e.name, board: null });
    }
  }
  return out;
};

/**
 * Board and thread from a flat crawl's filename, `<board>_<threadno>.html`.
 * fybertech's directory also holds 23 `index.cgi` listing pages, which name
 * no board and are skipped.
 */
const flatIdentity = (
  name: string
): { board: string; threadNo: number } | null => {
  const m = /^([a-z0-9]+)_(\d+)\.html?$/i.exec(name);
  return m ? { board: m[1], threadNo: Number(m[2]) } : null;
};

/** Leading digits of a nested tree's filename; handmade archives annotate
 * names like `1000000 ban.html`. */
const nestedThreadNo = (name: string): number | null => {
  const m = /^(\d+)/.exec(name);
  return m ? Number(m[1]) : null;
};

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

const stats = {
  pages: 0,
  posts: 0,
  skippedNative: 0,
  unreadable: 0,
  noPosts: 0,
  noTimestamp: 0,
};

for (const page of listPages(FROM)) {
  let raw: string;
  try {
    raw = readFileSync(page.path, 'utf8');
  } catch {
    // Handmade archives carry filenames whose bytes are not valid UTF-8; such
    // a name survives readdir but cannot be handed back to open().
    stats.unreadable++;
    continue;
  }
  const doc = parse(raw);

  // 4chan's own markup is staged as HTML and read by the `html` adapter.
  if (doc.querySelector('.postContainer')) {
    stats.skippedNative++;
    continue;
  }

  let board: string;
  let threadNo: number | null;
  if (page.board !== null) {
    board = page.board;
    threadNo = nestedThreadNo(page.name);
  } else {
    const id = flatIdentity(page.name);
    if (!id) {
      stats.noPosts++;
      continue;
    }
    board = id.board;
    threadNo = id.threadNo;
  }

  const posts: ParsedPost[] = readAnyGeneration(doc, threadNo ?? 0);
  if (posts.length === 0) {
    // Neither generation matched: a listing page, an error page, or markup
    // this crawl did not actually contain posts in.
    stats.noPosts++;
    continue;
  }

  // The page's own OP beats the filename, which handmade archives annotate.
  const op = posts.find((p) => p.isOp);
  const thread = op?.postNo ?? threadNo ?? posts[0].postNo;

  const w = writerFor(board);
  for (const p of posts) {
    if (p.tsUtc == null) {
      stats.noTimestamp++;
    }
    w.write(
      JSON.stringify({
        site: SITE,
        board,
        num: p.postNo,
        subnum: 0,
        thread_num: thread,
        op: p.isOp ? 1 : 0,
        timestamp: p.tsUtc,
        name: p.name,
        trip: p.tripcode,
        title: p.subject,
        comment: p.bodyText,
        media_filename: p.mediaFilename,
        // These pages carry no hashes at all.
        media_hash: null,
      }) + '\n'
    );
    stats.posts++;
  }
  stats.pages++;
}

await Promise.all(
  [...writers.values()].map(
    (w) =>
      new Promise<void>((res, rej) => {
        w.end((err?: Error | null) => (err ? rej(err) : res()));
      })
  )
);

// Every post on these pages displays a date, so a null timestamp is a parse
// gap rather than missing data. Reported rather than assumed away: "parsed
// for nearly all" once passed at 5.4% missing.
console.log(
  `    ${stats.posts} post(s) from ${stats.pages} page(s) into ${writers.size} board file(s)\n` +
    `    skipped ${stats.skippedNative} in 4chan's own markup, ` +
    `${stats.noPosts} with no posts, ${stats.unreadable} unreadable\n` +
    `    ${stats.noTimestamp} post(s) with no timestamp`
);
