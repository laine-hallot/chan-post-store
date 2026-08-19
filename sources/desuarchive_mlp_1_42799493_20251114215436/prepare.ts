/**
 * Desuarchive's NDJSON export of /mlp/'s full history, 68.5GB uncompressed.
 *
 * Asagi-shaped and very nearly the standard format already, which is why it
 * gets a converter rather than the reader getting a second shape: the numbers
 * are strings, `board` is an object, and the media fields are nested.
 *
 * Its `timestamp` really is true UTC -- the opposite of the same archive's
 * 2019 mysqldump exports, which are New York wall time.
 */

import { sh } from 'staging-core';
import { asagiExportToNdjson } from 'staging-json';

sh(
  `mkdir -p extracted && find . -name '*.ndjson.gz' -not -path './out/*' -not -path './extracted/*' | ` +
    `while read -r f; do b=$(basename "\${f%.gz}"); ` +
    `[ -e "extracted/$b" ] || [ -e "out/$b" ] || gunzip -c "$f" > "extracted/$b"; done`
);
sh(
  `mkdir -p out && find extracted -name '*.ndjson' -exec sh -c ` +
    `'cp -al "$1" out/ 2>/dev/null || cp -a "$1" out/' _ {} ';'`
);

const s = await asagiExportToNdjson({
  from: 'out/base_1_42799493.ndjson',
  to: 'out-ndjson',
});
console.log(
  `    ${s.posts} post(s) into ${s.boards} board file(s)\n` +
    `    ${s.ghost} ghost, ${s.bad} unparsable, ` +
    `${s.noBoard} with no board, ${s.noTs} with no timestamp`
);
