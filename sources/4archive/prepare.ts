/**
 * 4archive.org's shutdown dump: one flat `posts` table joined to `threads`,
 * so a post row cannot say what board it is from without the join.
 *
 * The item ships the dump three ways; prefer the already-uncompressed .sql so
 * a duplicate is never unpacked.
 */

import { existsSync } from 'node:fs';
import { sh } from 'staging-core';
import { postsThreadsToNdjson } from 'staging-sql';

sh('mkdir -p extracted');
if (!existsSync('extracted/4archive_dump.sql')) {
  if (existsSync('source/4archive/4archive_dump.sql')) {
    sh(
      'cp -al source/4archive/4archive_dump.sql extracted/ 2>/dev/null || ' +
        'cp -a source/4archive/4archive_dump.sql extracted/'
    );
  } else {
    sh('tar xzf source/4archive/4archive_dump.sql.tar.gz -C extracted');
  }
}
sh(
  'mkdir -p out && (cp -al extracted/4archive_dump.sql out/ 2>/dev/null || ' +
    'cp -a extracted/4archive_dump.sql out/)'
);

const s = await postsThreadsToNdjson({
  from: 'out/4archive_dump.sql',
  to: 'out-ndjson',
});
console.log(
  `    ${s.posts} post(s) into ${s.boards} board file(s)\n` +
    `    ${s.noThread} with no thread row, ${s.foreign} dropped as not 4chan,\n` +
    `    ${s.bad} unparsable, ${s.noTs} with no timestamp`
);
