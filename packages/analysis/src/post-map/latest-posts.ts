import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { PROJECT_ROOT } from '@chan-post-store/cli';

/**
 * Each board's newest post number on 4chan right now, for post-map's --last:
 * maps of one board from different sources are only comparable when they
 * share an upper bound, and the highest post any archive holds is not one.
 *
 * The newest post is the last post of the most recently bumped-or-replied
 * thread in threads.json. `last_modified` also moves when a post is deleted,
 * so this can land a few posts short; for a bound on a map of hundreds of
 * millions of cells that does not matter.
 */

const API = 'https://a.4cdn.org';
// The API asks for no more than one request a second.
const GAP_MS = 1000;
const OUT = join(PROJECT_ROOT, 'artifacts', '4chan-latest-posts.json');

export interface LatestPost {
  /** The newest post number seen. */
  last: number;
  /** The thread it was read from. */
  thread: number;
  /** That thread's last_modified, unix seconds. */
  lastModified: number;
}

export interface LatestPosts {
  fetchedAt: string;
  boards: Record<string, LatestPost>;
  /** Boards whose requests failed, with why. */
  failed: Record<string, string>;
}

let lastRequest = 0;
const get = async <T>(path: string): Promise<T> => {
  const wait = lastRequest + GAP_MS - Date.now();
  if (wait > 0) {
    await new Promise((r) => setTimeout(r, wait));
  }
  lastRequest = Date.now();
  const res = await fetch(`${API}${path}`);
  if (!res.ok) {
    throw new Error(`${path}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
};

const { boards } = await get<{ boards: { board: string }[] }>('/boards.json');
const out: LatestPosts = {
  fetchedAt: new Date().toISOString(),
  boards: {},
  failed: {},
};

for (const [i, { board }] of boards.entries()) {
  const tag = `[${i + 1}/${boards.length}] /${board}/`;
  try {
    const pages = await get<
      { threads: { no: number; last_modified: number }[] }[]
    >(`/${board}/threads.json`);
    const newest = pages
      .flatMap((p) => p.threads)
      .reduce((a, b) => (b.last_modified > a.last_modified ? b : a));
    const { posts } = await get<{ posts: { no: number }[] }>(
      `/${board}/thread/${newest.no}.json`
    );
    const last = Math.max(...posts.map((p) => p.no));
    out.boards[board] = {
      last,
      thread: newest.no,
      lastModified: newest.last_modified,
    };
    console.log(`${tag}: ${last.toLocaleString('en-US')}`);
  } catch (e) {
    // A thread can 404 between the two requests if it is pruned; one board
    // failing should not lose the rest.
    const msg = (e as Error).message;
    out.failed[board] = msg;
    console.error(`${tag}: FAILED -- ${msg}`);
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(out, null, 2)}\n`);
console.log(
  `wrote ${Object.keys(out.boards).length} boards to ${OUT}` +
    (Object.keys(out.failed).length > 0
      ? `; ${Object.keys(out.failed).length} failed`
      : '')
);
if (Object.keys(out.failed).length > 0) {
  process.exitCode = 1;
}
