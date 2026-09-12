/**
 * JSON staging: the 4chan read-API thread dumps, Desuarchive's NDJSON
 * export and Hayden scrapes of FoolFuuka archives, normalised into the
 * standard `<board>/posts.ndjson` layout.
 *
 * Separate from `staging-html` so a source whose archive is already JSON
 * never pulls in an HTML parser.
 */

export { threadsJsonToNdjson } from './threads-json-to-ndjson.ts';
export type {
  ThreadsJsonToNdjsonOptions,
  ThreadsJsonToNdjsonStats,
} from './threads-json-to-ndjson.ts';
export { asagiExportToNdjson } from './asagi-export-to-ndjson.ts';
export type {
  AsagiExportOptions,
  AsagiExportStats,
} from './asagi-export-to-ndjson.ts';
export { findHaydenRoots, haydenToNdjson } from './hayden-to-ndjson.ts';
export type {
  HaydenToNdjsonOptions,
  HaydenToNdjsonStats,
} from './hayden-to-ndjson.ts';
