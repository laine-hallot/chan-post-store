/**
 * The least-investigated item in the registry: no capture notes, no
 * short-desc, adapter still null.
 *
 * Generic unpack so the tree can be surveyed. Until somebody looks at what
 * came out and writes an ingest block, nothing downstream reads this.
 */

import { expectFiles, sh } from 'staging-core';

sh(
  'mkdir -p extracted && for f in source/*.tar.gz source/*.tgz source/*.7z source/*.zip; do ' +
    '[ -e "$f" ] || continue; case "$f" in ' +
    '*.tar.gz|*.tgz) tar xzf "$f" -C extracted;; ' +
    '*) 7z x -aos -o./extracted "$f";; esac; done; true'
);
sh('rm -rf out && (cp -al extracted out 2>/dev/null || cp -a extracted out)');

console.log(`    staged ${expectFiles('out', 'entries')} entr(ies) for survey`);
