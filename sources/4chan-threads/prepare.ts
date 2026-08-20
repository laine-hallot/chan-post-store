/**
 * 470,000+ threads scraped from 4chan's read API, May 2017 - Sep 2018.
 *
 * The dumps are JSON with a .txt extension, so they are renamed before the
 * converter walks them. Collapsing them into one NDJSON file per board is
 * most of the point here: half a million tiny files is exactly the tree that
 * must never be walked over a network mount.
 *
 * **This item does not use `source/`.** The .7z sits at the dataset root and
 * an already-extracted copy sits beside it as `4chan threads/`. The manifest
 * used to name `source/4chan threads.7z`, which never existed -- the source
 * was only ever ingestible because `ingest.path` pointed straight at the
 * extracted tree and skipped staging altogether.
 */

import { existsSync } from 'node:fs';
import { sh } from 'staging-core';
import { threadsJsonToNdjson } from 'staging-json';

// Prefer the tree that is already unpacked; only expand the .7z if it is gone.
if (!existsSync('4chan threads')) {
  sh(`mkdir -p extracted && 7z x -aos -o./extracted '4chan threads.7z'`);
}
const src = existsSync('4chan threads') ? '4chan threads' : 'extracted';

// Hardlinked, so renaming inside out/ leaves the original tree untouched.
sh(
  `rm -rf out && (cp -al ${JSON.stringify(src)} out 2>/dev/null || cp -a ${JSON.stringify(src)} out)`
);
sh(
  `find out -name '*.txt' -exec sh -c 'mv -- "$1" "\${1%.txt}.json"' _ {} ';'`
);

const s = await threadsJsonToNdjson({ from: 'out', to: 'out-ndjson' });
console.log(
  `    ${s.posts} post(s) from ${s.threads} thread(s) across ${s.boards} board(s)\n` +
    `    ${s.badFiles} unreadable file(s), ${s.skipped} post(s) with no number,` +
    ` ${s.noTs} with no timestamp`
);
