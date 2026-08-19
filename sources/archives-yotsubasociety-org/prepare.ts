/**
 * The archives.yotsubasociety.org mirror: 23,295 saved pages across 63 board
 * directories, ~85% classic Futaba markup and ~10% 4chan's own.
 *
 * Three things about it worth knowing before changing anything here.
 *
 * The upstream tarball is TRUNCATED -- its md5 matches the item but `gzip -t`
 * fails, and tar stops around 22.7GB in. That is expected, not a failure, so
 * the untar is allowed to error.
 *
 * The board directories are NOT trustworthy: 530 pages contradict their own
 * links. `reconcileBoards` moves them to where their `<form action>` links
 * say they belong, using the board timeline as a guard rather than an
 * authority. Keeping the per-board directories is deliberate -- it is what
 * makes file management and per-board stats tractable later.
 *
 * The mirror also holds sibling imageboards (1chan, 4chon, auschan, bun,
 * kuvalauta) beside `4chan/`. Only `4chan/` is converted, so their posts are
 * never stamped site=4chan.
 */

import { boardSlugs } from 'site-config-4chan';
import { sh } from 'staging-core';
import { htmlToNdjson, reconcileBoards } from 'staging-html';

sh(
  'mkdir -p extracted && { tar xzf source/archives.yotsubasociety.org.tar.gz -C extracted || ' +
    `echo 'tar stopped at the corrupt point, keeping what extracted' >&2; }`
);
sh(
  'rm -rf out && (cp -al extracted/archives.yotsubasociety.org out 2>/dev/null || ' +
    'cp -a extracted/archives.yotsubasociety.org out)'
);

// A guard, not the authority: the board is decided by each page's own links,
// and the timeline only stops this acting on something no board has ever
// been called.
const r = reconcileBoards({ root: 'out/4chan', knownBoards: boardSlugs() });
console.log(
  `    scanned ${r.scanned}, relocated ${r.relocated + r.relocatedSnapshot}, ` +
    `removed ${r.duplicateRemoved} identical duplicate(s)\n` +
    `    ${r.undetermined} with no link evidence, ${r.unknownBoard} naming an ` +
    `unknown board`
);
// Never acted on. An entry here that is not a known joke rename -- /wc/ for
// /sp/ during the 2010 World Cup, /g9k/, /tr/, /cwc/ -- is the signal that
// something new needs looking at.
for (const [pair, n] of r.costumes) {
  console.log(`    display name ${pair}: ${n} page(s)`);
}

const s = await htmlToNdjson({ from: 'out/4chan', to: 'out-ndjson' });
console.log(
  `    ${s.posts} post(s) from ${s.pages} page(s) into ${s.boards} board file(s)\n` +
    `    skipped ${s.skippedNative} in 4chan's own markup, ` +
    `${s.noPosts} with no posts, ${s.unreadable} unreadable\n` +
    `    ${s.noTimestamp} post(s) with no timestamp`
);
