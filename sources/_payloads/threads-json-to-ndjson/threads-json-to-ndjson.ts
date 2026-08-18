// Part of a prepare payload: this file is uploaded to whichever machine holds
// the archives and run there. It may import only `node:` builtins and its own
// siblings -- nothing from this repo is resolvable at that point.
//
// Node strips the types at load; no build step, so no syntax that emits code.

/**
 * Turns 4chan read-API thread dumps into the standard NDJSON layout,
 * `<to>/<board>/posts.ndjson`.
 *
 * The input is one `{ "posts": [...] }` object per thread
 * (https://github.com/4chan/4chan-API), in whichever of the shapes the
 * archives actually use:
 *
 *     <from>/<board>/[<board> ]<threadno>.(json|txt)
 *     <from>/<board>/[<board> ]<threadno>/<same>.(json|txt)
 *
 * The board-prefixed filename and the nested form are both real; so is `.txt`
 * for a file containing JSON. Collapsing all of that here means the reader
 * knows one layout instead of four.
 *
 * Runs HERE, on the archive host. 4chan-threads alone is 470,000+ tiny files,
 * and walking that over NFS from the other machine is what takes the mount
 * down -- concatenating them into one file per board is most of the point.
 *
 * `time` in this format is already a true UTC epoch, so it is copied across
 * untouched. That is the NDJSON half of the standard format's contract; the
 * SQL half is New York wall time.
 */

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  opendirSync,
  readFileSync,
} from 'node:fs';
import { join } from 'node:path';

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

interface ApiPost {
  no?: number;
  resto?: number;
  time?: number;
  name?: string;
  trip?: string;
  sub?: string;
  com?: string;
  filename?: string;
  ext?: string;
  md5?: string;
}

/** Every thread file under one board directory, in either shape. */
const threadFiles = function* (
  boardDir: string,
  board: string
): Generator<{ path: string; threadNo: number }> {
  const filePat = new RegExp(`^(?:${board} )?(\\d+)\\.(?:json|txt)$`);
  const dirPat = new RegExp(`^(?:${board} )?(\\d+)$`);
  // opendir rather than readdir: these directories hold hundreds of thousands
  // of entries and there is no reason to hold them all in memory at once.
  const dir = opendirSync(boardDir);
  try {
    let entry;
    while ((entry = dir.readSync()) !== null) {
      const path = join(boardDir, entry.name);
      if (entry.isDirectory()) {
        const m = dirPat.exec(entry.name);
        if (!m) {
          continue;
        }
        for (const ext of ['.json', '.txt']) {
          const nested = join(path, entry.name + ext);
          if (existsSync(nested)) {
            yield { path: nested, threadNo: Number(m[1]) };
            break;
          }
        }
      } else if (entry.isFile()) {
        const m = filePat.exec(entry.name);
        if (m) {
          yield { path, threadNo: Number(m[1]) };
        }
      }
    }
  } finally {
    dir.closeSync();
  }
};

const boards: string[] = [];
{
  const dir = opendirSync(FROM);
  try {
    let e;
    while ((e = dir.readSync()) !== null) {
      if (e.isDirectory()) {
        boards.push(e.name);
      }
    }
  } finally {
    dir.closeSync();
  }
}
boards.sort();

const stats = { threads: 0, posts: 0, badFiles: 0, skipped: 0, noTs: 0 };

for (const board of boards) {
  let wrote = false;
  let out: ReturnType<typeof createWriteStream> | null = null;

  for (const { path, threadNo } of threadFiles(join(FROM, board), board)) {
    let posts: ApiPost[];
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        posts?: unknown;
      };
      if (!Array.isArray(parsed.posts)) {
        // A well-formed file that is not a thread is not exceptional; only an
        // unreadable one is. Same outcome, reached without throwing.
        stats.badFiles++;
        continue;
      }
      posts = parsed.posts as ApiPost[];
    } catch {
      stats.badFiles++;
      continue;
    }

    if (!out) {
      mkdirSync(join(TO, board), { recursive: true });
      out = createWriteStream(join(TO, board, 'posts.ndjson'));
      wrote = true;
    }

    for (const p of posts) {
      if (typeof p.no !== 'number') {
        stats.skipped++;
        continue;
      }
      if (p.time == null) {
        stats.noTs++;
      }
      out.write(
        JSON.stringify({
          site: SITE,
          board,
          num: p.no,
          subnum: 0,
          thread_num: threadNo,
          op: p.resto === 0 || p.no === threadNo ? 1 : 0,
          // Already a true UTC epoch in this format.
          timestamp: p.time ?? null,
          name: p.name ?? null,
          trip: p.trip ?? null,
          title: p.sub != null ? stripHtml(p.sub) : null,
          comment: p.com != null ? stripHtml(p.com) : null,
          media_filename:
            p.filename != null ? `${p.filename}${p.ext ?? ''}` : null,
          media_hash: p.md5 ?? null,
        }) + '\n'
      );
      stats.posts++;
    }
    stats.threads++;
  }

  if (out) {
    await new Promise<void>((res, rej) => {
      out!.end((err?: Error | null) => (err ? rej(err) : res()));
    });
  }
  if (!wrote) {
    console.error(`    /${board}/ held no readable threads`);
  }
}

console.log(
  `    ${stats.posts} post(s) from ${stats.threads} thread(s) across ${boards.length} board(s)\n` +
    `    ${stats.badFiles} unreadable file(s), ${stats.skipped} post(s) with no number,` +
    ` ${stats.noTs} with no timestamp`
);
