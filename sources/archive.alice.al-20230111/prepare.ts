/**
 * archive.alice.al: 21 per-board dumps, bzip2-compressed.
 *
 * Already Asagi and already one board per file, and mysqlchump output --
 * statements span lines because comments carry literal unescaped newlines --
 * so these must NOT be routed through the line-oriented board split. Only the
 * filenames need normalising, from `archive.alice.al-<board>-<date>.sql` to
 * `<board>.sql`.
 *
 * The 21st board is `meta`, the archive's own discussion board rather than a
 * 4chan one; ingest.exclude-boards drops it.
 */

import { readdirSync } from 'node:fs';
import { expectFiles, sh } from 'staging-core';

sh(
  `mkdir -p extracted && find . -name '*.sql.bz2' -not -path './out/*' -not -path './extracted/*' | ` +
    `while read -r f; do b=$(basename "\${f%.bz2}"); ` +
    `[ -e "extracted/$b" ] || [ -e "out/$b" ] || bunzip2 -c "$f" > "extracted/$b"; done`
);

sh('rm -rf out && mkdir -p out');
for (const name of readdirSync('extracted')) {
  if (!name.endsWith('.sql')) {
    continue;
  }
  const board = name
    .replace(/\.sql$/, '')
    .replace(/^archive\.alice\.al-/, '')
    .replace(/-\d+$/, '');
  sh(
    `cp -al "extracted/${name}" "out/${board}.sql" 2>/dev/null || ` +
      `cp -a "extracted/${name}" "out/${board}.sql"`
  );
}
console.log(`    staged ${expectFiles('out', 'board dumps')} board file(s)`);
