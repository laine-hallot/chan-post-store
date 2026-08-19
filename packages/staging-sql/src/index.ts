/**
 * SQL staging: mysqldump tuple parsing, and the join the two pre-Fuuka
 * archives need before their posts can be attributed to a board.
 *
 * Separate from `staging-html` so a SQL source's prepare script never pulls
 * in a 212KB HTML parser.
 */

export { postsThreadsToNdjson } from './posts-threads-to-ndjson.ts';
export type {
  PostsThreadsOptions,
  PostsThreadsStats,
} from './posts-threads-to-ndjson.ts';
export {
  CREATE_TABLE_RE,
  insertColumns,
  parseTuples,
  takeCompleteTuples,
} from './sqldump.ts';
export { sqlNormalize } from './sql-normalize.ts';
export type {
  SqlNormalizeOptions,
  SqlNormalizeStats,
} from './sql-normalize.ts';
