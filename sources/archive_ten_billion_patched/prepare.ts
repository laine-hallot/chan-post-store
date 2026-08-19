/**
 * The repaired "Ten Billion" chanarchive dump, 2005-2008. Same flat
 * posts+threads shape as 4archive but different column names, so the dialect
 * is detected from the CREATE TABLE rather than declared.
 *
 * Its thread URLs include hosts that are not 4chan (may.not4chan.org,
 * orly.yi.org). Those are dropped: mixing them in under site=4chan would both
 * misattribute the posts and let them collide with real 4chan post numbers.
 */

import { sh } from 'staging-core';
import { postsThreadsToNdjson } from 'staging-sql';

sh(
  `mkdir -p extracted && find . -name '*.sql.gz' -not -path './out/*' -not -path './extracted/*' | ` +
    `while read -r f; do b=$(basename "\${f%.gz}"); ` +
    `[ -e "extracted/$b" ] || [ -e "out/$b" ] || gunzip -c "$f" > "extracted/$b"; done`
);
sh(
  `mkdir -p out && find extracted -name '*.sql' -exec sh -c ` +
    `'cp -al "$1" out/ 2>/dev/null || cp -a "$1" out/' _ {} ';'`
);

const s = await postsThreadsToNdjson({
  from: 'out/chanarchive_dump_v2.sql',
  to: 'out-ndjson',
});
console.log(
  `    ${s.posts} post(s) into ${s.boards} board file(s)\n` +
    `    ${s.noThread} with no thread row, ${s.foreign} dropped as not 4chan,\n` +
    `    ${s.bad} unparsable, ${s.noTs} with no timestamp`
);
