/**
 * A hand-made archive of very early (possibly 2004-2006) threads, shipped as
 * a WARC.
 *
 * The adapter is deliberately still null. A rendered third-party archive is
 * NOT automatically 4chan's own markup: fybertech's 638 pages hid three
 * generations, so the whole tree wants surveying after extraction rather than
 * being assumed. Expect no data-utc, and any date that is not shown must stay
 * null rather than be guessed.
 */

import { expectFiles } from 'staging-core';
import { extractWarcPages } from 'staging-html';

const pages = extractWarcPages({ warc: 'source', out: 'extracted' });
console.log(`    extracted ${pages} page(s) from the WARC(s)`);

// Staged unclassified: which markup family these are is the open question.
import { sh } from 'staging-core';
sh(
  'rm -rf out && mkdir -p out && (cp -al extracted/. out/ 2>/dev/null || cp -a extracted/. out/)'
);
console.log(`    staged ${expectFiles('out', 'pages')} page(s) for survey`);
