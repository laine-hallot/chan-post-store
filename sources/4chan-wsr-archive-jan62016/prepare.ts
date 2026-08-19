/**
 * BASC-Archiver output for /wsr/, 1,944 threads.
 *
 * The archiver saves both the rendered HTML and the API JSON response, so the
 * JSON is what gets read; the per-thread css/js/images/thumbs directories are
 * ignored. Some captures nest the tree under archive/4chan.
 */

import { existsSync } from 'node:fs';
import { sh } from 'staging-core';
import { threadsJsonToNdjson } from 'staging-json';

sh(
  'mkdir -p extracted && for f in source/*.tar; do [ -e "$f" ] || continue; ' +
    'tar xf "$f" -C extracted; done'
);
const src = existsSync('extracted/archive/4chan')
  ? 'extracted/archive/4chan'
  : 'extracted';
sh(
  `rm -rf out && (cp -al ${JSON.stringify(src)} out 2>/dev/null || cp -a ${JSON.stringify(src)} out)`
);

const s = await threadsJsonToNdjson({ from: 'out', to: 'out-ndjson' });
console.log(
  `    ${s.posts} post(s) from ${s.threads} thread(s) across ${s.boards} board(s)\n` +
    `    ${s.badFiles} unreadable file(s), ${s.skipped} post(s) with no number,` +
    ` ${s.noTs} with no timestamp`
);
