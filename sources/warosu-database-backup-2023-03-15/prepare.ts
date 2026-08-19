/**
 * warosu.org database backup. Twelve per-board dumps, zstd-compressed, in the
 * ORIGINAL Perl-Fuuka 25-column schema: `parent` where Asagi says
 * `thread_num`, the poster's filename in `media` where Asagi says
 * `media_filename`.
 *
 * The rename happens in the CREATE TABLE header only. These dumps carry no
 * INSERT column list, so tuple order follows the table definition and
 * rewriting the header remaps every field without touching a data row.
 */

import { sh } from 'staging-core';
import { sqlNormalize } from 'staging-sql';

// The item is sometimes fetched as one zip of the per-board .sql.zst files.
sh(
  `mkdir -p extracted && if [ -z "$(ls out/*.sql 2>/dev/null)" ] && ` +
    `! ls extracted/*.sql.zst extracted/*.sql >/dev/null 2>&1 && ` +
    `[ -z "$(find . -maxdepth 3 -name '*.sql.zst' -not -path './extracted/*' -print -quit)" ]; then ` +
    `z=$(find . -maxdepth 3 -name '*.zip' -print -quit); [ -n "$z" ] && 7z x -aos -o./extracted "$z"; fi; true`
);
sh(
  `mkdir -p extracted && find . -name '*.sql.zst' -not -path './out/*' | ` +
    `while read -r f; do b=$(basename "\${f%.zst}"); ` +
    `[ -e "extracted/$b" ] || [ -e "out/$b" ] || unzstd -q -o "extracted/$b" "$f"; done`
);

const { boards, files } = sqlNormalize({
  from: 'extracted',
  to: 'out',
  rename: 'fuuka',
});
console.log(`    ${boards} board file(s) from ${files} dump(s)`);
