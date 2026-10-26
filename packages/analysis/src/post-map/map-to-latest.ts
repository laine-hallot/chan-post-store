import type { LatestPosts } from './latest-posts.ts';

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECT_ROOT } from '@chan-post-store/cli';

/**
 * Runs post-map once per board in latest-posts' output, with that board's
 * newest 4chan post as --last, so every source's map of a board shares one
 * upper bound and they can be compared side by side. Anything after the
 * script name is passed through to each run (--source, --reuse-scan, ...).
 *
 * Boards an archive holds that 4chan no longer lists are not touched; their
 * maps keep whatever range the last plain post-map run gave them.
 */

const LATEST = join(PROJECT_ROOT, 'artifacts', '4chan-latest-posts.json');
const POST_MAP = fileURLToPath(new URL('./post-map.ts', import.meta.url));

const { boards, fetchedAt } = JSON.parse(
  readFileSync(LATEST, 'utf8')
) as LatestPosts;
const passThrough = process.argv.slice(2);
const entries = Object.entries(boards).sort(([a], [b]) => a.localeCompare(b));
console.log(`newest posts as of ${fetchedAt}, ${entries.length} boards`);

const failed: string[] = [];
for (const [i, [board, { last }]] of entries.entries()) {
  console.log(`=== [${i + 1}/${entries.length}] /${board}/ --last ${last} ===`);
  const r = spawnSync(
    process.execPath,
    [
      POST_MAP,
      '--no-serve',
      '--board',
      board,
      '--last',
      String(last),
      ...passThrough,
    ],
    { stdio: 'inherit' }
  );
  if (r.status !== 0) {
    failed.push(board);
  }
}

if (failed.length > 0) {
  console.error(
    `post-map failed for: ${failed.map((b) => `/${b}/`).join(' ')}`
  );
  process.exitCode = 1;
}
