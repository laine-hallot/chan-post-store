/**
 * HTML staging: turning saved archive pages into the standard layouts.
 *
 * Separate from `staging-sql` so a SQL source's prepare script never pulls in
 * a 212KB HTML parser, and vice versa.
 */

export { htmlToNdjson } from './html-to-ndjson.ts';
export type {
  HtmlToNdjsonOptions,
  HtmlToNdjsonStats,
} from './html-to-ndjson.ts';
export { parse, readAnyGeneration } from './fybertech-markup.ts';
export type { ParsedPost } from './fybertech-markup.ts';
