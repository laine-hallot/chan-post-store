/**
 * The hyphenated `yotsuba-society-archives-part-2` item, which is a different
 * and much smaller upload than the underscored one -- 5 boards, 45 threads.
 * Kept because the two identifiers differ only by that separator, and this is
 * the only source whose dataset directory does not mirror its identifier.
 */

import { sh } from 'staging-core';
import { threadsJsonToNdjson } from 'staging-json';

sh(
  'mkdir -p extracted && for f in source/*.tar.gz; do [ -e "$f" ] || continue; ' +
    'tar xzf "$f" -C extracted; done'
);
sh('rm -rf out && (cp -al extracted out 2>/dev/null || cp -a extracted out)');

const s = await threadsJsonToNdjson({ from: 'out', to: 'out-ndjson' });
console.log(
  `    ${s.posts} post(s) from ${s.threads} thread(s) across ${s.boards} board(s)\n` +
    `    ${s.badFiles} unreadable file(s), ${s.skipped} post(s) with no number,` +
    ` ${s.noTs} with no timestamp`
);
