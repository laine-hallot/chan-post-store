/**
 * desuarchive_db_201909: 23 per-board mysqldumps, one .sql.bz2 each.
 *
 * Runs on whichever machine holds the archives, with the dataset directory as
 * the working directory.
 *
 * No conversion needed. These are already Asagi and already one board per
 * file, and they are mysqlchump output -- statements span lines because
 * comments carry literal unescaped newlines -- so they must NOT be routed
 * through the line-oriented board split. Decompress and link, nothing more.
 */

import { existsSync } from 'node:fs';
import { expectFiles, linkInto, sh } from 'staging-core';

sh(
  `mkdir -p extracted && find . -name '*.sql.bz2' -not -path './out/*' -not -path './extracted/*' | ` +
    `while read -r f; do b=$(basename "\${f%.bz2}"); ` +
    `[ -e "extracted/$b" ] || [ -e "out/$b" ] || bunzip2 -c "$f" > "extracted/$b"; done`
);

if (!existsSync('extracted')) {
  console.error('nothing decompressed: no *.sql.bz2 under this dataset');
  process.exit(1);
}

linkInto('extracted', 'out');
const n = expectFiles('out', 'board dumps');
console.log(`    staged ${n} board file(s)`);
