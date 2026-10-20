/**
 * Our own Hayden scrape of Desuarchive's /g/, 2019-01-01 to 2026-09-07,
 * published on archive.org as one tarball of per-year tarballs:
 *
 *   source/desu-archive-scrape-jan-01-2019-sept-07-2026.tar.gz
 *     desu-archive-scrape-jan-01-2019-sept-07-2026/
 *       g-2019.tar.gz ... g-2026.tar.gz   -> g-<year>/g/<threadno>/thread.json
 *       logs/
 *
 * So extraction is two levels deep: the downloaded tarball is unpacked into
 * `extracted/`, and every tarball that turns up there (one directory down at
 * most -- the year trees below hold millions of entries and are not walked)
 * is unpacked beside it. Each yields one Hayden root, `extracted/g-<year>`.
 *
 * Extraction is stamped per tarball (`extracted/.<name>.extracted`) and
 * skipped while the stamp is newer than the tarball, so `--force` re-runs
 * the converter over what is already unpacked rather than re-reading every
 * archive; replacing a tarball with a newer one of the same name is caught
 * by the mtime.
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

const TARBALL = /\.(tar\.gz|tgz|tar)$/i;

/** Tarballs directly in `dir`, and in its immediate subdirectories. */
const tarballsIn = (dir: string): string[] => {
  const found: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && TARBALL.test(e.name)) {
      found.push(join(dir, e.name));
    } else if (e.isDirectory()) {
      for (const n of readdirSync(join(dir, e.name))) {
        if (TARBALL.test(n)) {
          found.push(join(dir, e.name, n));
        }
      }
    }
  }
  return found.sort();
};

/** Unpacks `tarball` into extracted/ unless its stamp says that's done. */
const extract = (tarball: string): void => {
  const name = tarball.split('/').pop() as string;
  const stamp = join('extracted', `.${name}.extracted`);
  if (
    existsSync(stamp) &&
    statSync(stamp).mtimeMs >= statSync(tarball).mtimeMs
  ) {
    console.log(`    ${name} already extracted`);
    return;
  }
  console.log(`    extracting ${name}`);
  // tar picks the compression from the file itself.
  sh(`tar -xf ${JSON.stringify(tarball)} -C extracted`);
  writeFileSync(stamp, '');
};

if (!existsSync('source')) {
  console.error('no source/ directory: run `download` first');
  process.exit(1);
}
mkdirSync('extracted', { recursive: true });

const outer = tarballsIn('source');
if (outer.length === 0) {
  console.error('no tarball in source/: run `download` first');
  process.exit(1);
}
outer.forEach(extract);
const inner = tarballsIn('extracted');
inner.forEach(extract);

const roots = findHaydenRoots('extracted');
if (roots.length === 0) {
  console.error(
    `no Hayden download root found under extracted/` +
      ` (${outer.length} + ${inner.length} tarball(s) seen):` +
      ` expected <board>/<threadno>/thread.json`
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
