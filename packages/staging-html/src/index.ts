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
export { stageNativeHtml } from './stage-native.ts';
export type { StageNativeOptions, StageNativeStats } from './stage-native.ts';
export { reconcileBoards } from './reconcile-boards.ts';
export type { ReconcileOptions, ReconcileStats } from './reconcile-boards.ts';
export { isDir, listHtmlPages } from './html-tree.ts';
export type { HtmlPageRef } from './html-tree.ts';
export { extractWarcPages, htmlPages, uriToFilename } from './warc.ts';
