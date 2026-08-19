/**
 * The ~10% of the yotsubasociety mirror that is in 4chan's OWN markup.
 *
 * Staged from the tree the `archives-yotsubasociety-org` source unpacks and
 * reconciles, so the board directories are already trustworthy by the time
 * this runs.
 */

import { stageNativeHtml } from 'staging-html';

const s = stageNativeHtml({ from: 'out/4chan', to: 'out-native' });
console.log(`    staged ${s.staged} native page(s)`);
