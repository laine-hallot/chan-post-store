/**
 * The 20 pages of fybertech's crawl that are in 4chan's OWN markup rather
 * than fybertech's template.
 *
 * Staged from the tree the `fybertech` source unpacks, into a directory of
 * its own, so neither reader has to skip the other's files.
 */

import { stageNativeHtml } from 'staging-html';

const s = stageNativeHtml({ from: 'out', to: 'out-native' });
console.log(`    staged ${s.staged} native page(s)`);
