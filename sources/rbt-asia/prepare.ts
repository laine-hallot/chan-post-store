/**
 * RebeccaBlackTech's archive backups. Original Perl-Fuuka schema.
 *
 * The daily_4klaani_* dumps are the interesting ones: each holds SEVEN boards
 * (cgl, con, g, mu, qa, soc, w), not the three an earlier note recorded --
 * /soc/ included, as ordinary mysqldump text rather than the raw MyISAM the
 * item also ships.
 */

import { sh } from 'staging-core';
import { sqlNormalize } from 'staging-sql';

sh(
  `mkdir -p extracted && find source -maxdepth 1 -name '*.sql.gz' | ` +
    `while read -r f; do b=$(basename "\${f%.gz}"); ` +
    `[ -e "extracted/$b" ] || [ -e "out/$b" ] || gunzip -c "$f" > "extracted/$b"; done`
);
// qa and con ship as xz tarballs instead.
sh(
  'mkdir -p extracted && for f in source/*.sql.tar.xz; do ' +
    '[ -e "$f" ] || continue; tar xf "$f" -C ./extracted; done'
);

const { boards, files } = sqlNormalize({
  from: 'extracted',
  to: 'out',
  rename: 'fuuka',
});
console.log(`    ${boards} board file(s) from ${files} dump(s)`);
