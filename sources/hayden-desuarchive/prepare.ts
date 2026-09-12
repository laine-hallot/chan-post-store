/**
 * Our own Hayden scrape of Desuarchive's /g/, filling the 2019-2026 gap that
 * no public dump covers.
 *
 * **There is no download step.** The scrape is not published anywhere yet, so
 * `source/` is filled by hand with tarballs of Hayden's download root
 * (`my-archive-1.tar.gz`, holding `my-archive-1/g/<threadno>/thread.json`).
 * A loose Hayden tree copied straight into `source/` works too.
 *
 * Extraction is stamped per tarball (`extracted/.<name>.extracted`) and
 * skipped while the stamp is newer than the tarball, so `--force` re-runs
 * the converter over what is already unpacked rather than re-reading every
 * archive; replacing a tarball with a newer one of the same name is caught
 * by the mtime. The scrape grows, so more tarballs may arrive: every root
 * found is read, in name order.
 *
 * Every board directory Hayden wrote is staged, not just /g/. The first sample
 * carried a handful of /his/ threads beside it; they are real posts, and a
 * partial capture never blocks a fuller one, so there is no reason to drop
 * them here. `ingest.exclude-boards` is the place to drop them if that changes.
 *
 * The output is built beside `out/` and renamed into place only after the
 * converter has finished and produced something. `prepare` decides whether
 * staging has run by whether `out/` exists, so a converter that died halfway
 * through must not leave one behind to be mistaken for a finished run.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { expectFiles, sh } from 'staging-core';
import { findHaydenRoots, haydenToNdjson } from 'staging-json';

if (!existsSync('source')) {
  console.error(
    'no source/ directory: copy tarballs of the Hayden download root there' +
      ' (or the tree itself, so that source/<board>/<threadno>/thread.json exists)'
  );
  process.exit(1);
}

mkdirSync('extracted', { recursive: true });
const tarballs = readdirSync('source')
  .filter((n) => /\.(tar\.gz|tgz|tar)$/i.test(n))
  .sort();
for (const t of tarballs) {
  const tarball = join('source', t);
  const stamp = join('extracted', `.${t}.extracted`);
  if (
    existsSync(stamp) &&
    statSync(stamp).mtimeMs >= statSync(tarball).mtimeMs
  ) {
    console.log(`    ${t} already extracted`);
    continue;
  }
  console.log(`    extracting ${t}`);
  // tar picks the compression from the file itself.
  sh(`tar -xf ${JSON.stringify(tarball)} -C extracted`);
  writeFileSync(stamp, '');
}

// Wherever the tarballs' wrapper directories put the trees, plus a tree
// dropped loose into source/.
const roots = [...findHaydenRoots('extracted'), ...findHaydenRoots('source')];
if (roots.length === 0) {
  console.error(
    `no Hayden download root found under extracted/ or source/` +
      ` (${tarballs.length} tarball(s) seen): expected <board>/<threadno>/thread.json`
  );
  process.exit(1);
}
console.log(`    reading ${roots.length} root(s): ${roots.join(', ')}`);

sh('rm -rf out out.partial');

const s = await haydenToNdjson({ from: roots, to: 'out.partial' });
console.log(
  `    ${s.posts} post(s) from ${s.threads} thread(s) across ${s.boards} board(s)\n` +
    `    ${s.deleted} flagged deleted (kept), ${s.ghost} ghost, ` +
    `${s.skipped} with no Asagi record, ${s.noTs} with no timestamp\n` +
    `    ${s.badFiles} unreadable thread file(s), ` +
    `${s.threadMismatch} record(s) disagreeing with their thread directory` +
    (s.ignoredDirs.length
      ? `\n    ignored (no threads): ${s.ignoredDirs.join(', ')}`
      : '')
);

expectFiles('out.partial', 'board files');
sh('mv out.partial out');
