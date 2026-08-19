/**
 * A single Perma.cc capture of one complete /a/ thread (161 posts, no omitted replies).
 *
 * Perma.cc ships a WARC, so the pages are extracted from it here -- on the
 * machine holding the archive. The WARC is ~700MB; the previous arrangement
 * read it back to the other machine and tried to hold it in one string, which
 * fails outright above 512MB.
 */

import { extractWarcPages, stageNativeHtml } from 'staging-html';

const pages = extractWarcPages({
  warc: 'source/FRN8-45S5.warc.gz',
  out: 'extracted',
});
console.log(`    extracted ${pages} page(s) from the WARC`);

const s = stageNativeHtml({ from: 'extracted', to: 'out' });
console.log(`    staged ${s.staged} native page(s)`);
