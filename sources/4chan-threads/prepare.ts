/**
 * 470,000+ threads scraped from 4chan's read API, May 2017 - Sep 2018.
 *
 * The dumps are JSON with a .txt extension, so they are renamed before the
 * converter walks them. Converting to one NDJSON file per board is most of
 * the point here: half a million tiny files is exactly the tree that must
 * never be walked over a network mount.
 */

import { sh } from 'staging-core';
import { threadsJsonToNdjson } from 'staging-json';

sh(`mkdir -p extracted && 7z x -aos -o./extracted 'source/4chan threads.7z'`);
sh(
  `find extracted -name '*.txt' -exec sh -c 'mv -- "$1" "\${1%.txt}.json"' _ {} ';'`
);
sh('rm -rf out && (cp -al extracted out 2>/dev/null || cp -a extracted out)');

const s = await threadsJsonToNdjson({ from: 'out', to: 'out-ndjson' });
console.log(
  `    ${s.posts} post(s) from ${s.threads} thread(s) across ${s.boards} board(s)\n` +
    `    ${s.badFiles} unreadable file(s), ${s.skipped} post(s) with no number,` +
    ` ${s.noTs} with no timestamp`
);
