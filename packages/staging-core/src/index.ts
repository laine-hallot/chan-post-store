/**
 * Primitives every staging concern needs.
 *
 * Its own package because `staging-sql`, `staging-html` and `staging-json`
 * all need line splitting and text cleanup, and a copy each would be three
 * copies of the one function whose behaviour is most load-bearing --
 * `readLines`, which exists because `readline` cannot be used here.
 */

export { readLines } from './lines.ts';
export { cleanBodyText, stripHtml } from './text.ts';
export { nyWallToUtc } from './time.ts';
export type { NdjsonPost } from './record.ts';
export { NdjsonWriter } from './record.ts';
