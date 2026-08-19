/**
 * laza's archive: one 21GB tables.sql holding every board.
 *
 * Called "Fuuka" but it is Asagi -- it has `thread_num` and `op` -- so no
 * column rename, only the split into one file per board. `<board>_deleted`
 * tables carry that board's deleted posts and are routed to the same file;
 * the _daily/_images/_threads/_users side tables have no post columns and are
 * dropped.
 */

import { sh } from 'staging-core';
import { sqlNormalize } from 'staging-sql';

sh(
  'mkdir -p extracted && for f in source/*.xz source/*.7z source/*.zip; do ' +
    '[ -e "$f" ] || continue; case "$f" in ' +
    '*.tar.xz) tar xJf "$f" -C extracted;; ' +
    '*.xz) cp -a "$f" extracted/ && (cd extracted && unxz -f "$(basename "$f")");; ' +
    '*) 7z x -aos -o./extracted "$f";; esac; done; true'
);
sh(
  `mkdir -p extracted && [ -e extracted/tables.sql ] || ` +
    `{ f=$(find source extracted -maxdepth 3 -name 'tables.sql' 2>/dev/null | head -1); ` +
    `[ -n "$f" ] && (cp -al "$f" extracted/ 2>/dev/null || cp -a "$f" extracted/); }`
);

const { boards, files } = sqlNormalize({
  from: 'extracted',
  to: 'out',
  rename: 'none',
});
console.log(`    ${boards} board file(s) from ${files} dump(s)`);
