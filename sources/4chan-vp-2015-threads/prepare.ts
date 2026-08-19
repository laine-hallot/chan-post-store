/**
 * A 2015 capture of /vp/ threads, four loose 7z volumes.
 *
 * The source tree is `<date>/vp/boards.4chan.org/vp/thread/<threadno>` with no
 * file extension and five levels of nesting, so it is flattened to
 * `out/vp/<date>_<threadno>.html`.
 *
 * The date prefix is deliberate: the same thread was captured on consecutive
 * days, and collapsing to `<threadno>.html` would keep only one capture. The
 * reader treats a digits-only filename as asserting the thread number and any
 * other name as deferring to the markup, so every capture resolves correctly
 * and the unique constraint unions their posts.
 */

import { expectFiles, sh } from 'staging-core';

sh(
  'mkdir -p extracted && for f in source/vp_*.7z; do [ -e "$f" ] || continue; ' +
    '7z x -aos -o./extracted "$f"; done'
);
sh(
  `rm -rf out && mkdir -p out/vp && find extracted -type f -path '*/thread/*' | ` +
    `while read -r f; do d=\${f#extracted/}; d=\${d%%/*}; n=$(basename "$f"); ` +
    `t="out/vp/\${d}_\${n}.html"; cp -al "$f" "$t" 2>/dev/null || cp -a "$f" "$t"; done`
);

console.log(`    staged ${expectFiles('out/vp', 'pages')} page(s)`);
