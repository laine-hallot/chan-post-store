import type { Pool } from 'pg';

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

import { collectPending, PostInserter } from '../ingest.ts';
import { makeBar } from '../progress.ts';
import {
  CREATE_TABLE_RE,
  insertColumns,
  nyWallToUtc,
  parseTuples,
} from '../mysqldump.ts';

/**
 * Ingests the warosu.org database backups: one mysqldump per board, in the
 * original Perl-Fuuka schema (25 columns, a single table named after the
 * board). Not the same layout as the Asagi-era `fuuka-sql` adapter:
 *   - `parent` (0 for OPs) instead of `thread_num` + `op`
 *   - the poster's original filename is in `media`; `media_filename` holds
 *     the server's timestamp name
 * `timestamp` is New-York-shifted like all Fuuka descendants and is
 * normalized to true UTC on ingest.
 *
 * The statement layout is NOT stable across dumps: 2023-03-15 emits one
 * INSERT per row, 2025-08-15 uses extended inserts (many rows per statement).
 * The tuple parser handles both, but nothing that counts or sizes a dump may
 * assume either -- `grep -c '^INSERT INTO'` is a row count on the 2023 dump
 * and a statement count on the 2025 one, off by three orders of magnitude
 * (4,502,532 vs 1,393 for `cgl`), and file sizes are likewise not comparable
 * between the two.
 */

const REQUIRED_COLS = [
  'num',
  'subnum',
  'parent',
  'timestamp',
  'comment',
  'media',
];

interface IngestStats {
  posts: number;
  skippedDup: number;
  skippedGhost: number;
  badLines: number;
  tables: string[];
}

export const ingestWarosuSql = async (
  db: Pool,
  opts: {
    file: string;
    sourceId: number;
    site: string;
    boards?: string[];
    fileSize?: number;
  }
): Promise<IngestStats> => {
  const inserter = new PostInserter(db, opts.sourceId);
  const stats: IngestStats = {
    posts: 0,
    skippedDup: 0,
    skippedGhost: 0,
    badLines: 0,
    tables: [],
  };

  const input =
    opts.file === '-'
      ? process.stdin
      : createReadStream(opts.file, { highWaterMark: 4 * 1024 * 1024 });
  let bytesRead = 0;
  const bar = makeBar({ max: opts.fileSize });
  bar.start(`reading ${opts.file}`);
  input.on('data', (chunk: string | Buffer) => {
    bytesRead += chunk.length;
    bar.advance(
      chunk.length,
      `${(bytesRead / 1e6).toFixed(0)}MB read, ${stats.posts} posts,` +
        ` boards: ${stats.tables.join(',') || '-'}`
    );
  });
  const lines = createInterface({ input, crlfDelay: Infinity });

  const tableCols = new Map<string, string[]>();
  let creating: string | null = null;
  let accept: {
    board: string;
    idx: Record<string, number>;
    /** Last INSERT column list seen, and the order it implies. See below. */
    listKey?: string;
    listIdx?: Record<string, number> | null;
  } | null = null;
  let acceptFor = '';

  const COMMIT_EVERY = 50_000;
  let sinceCommit = 0;
  const pending: Promise<void>[] = [];

  for await (const line of lines) {
    if (creating !== null) {
      const col = /^\s*`([^`]+)`/.exec(line);
      if (col) {
        tableCols.get(creating)!.push(col[1]);
      } else if (line.startsWith(')')) {
        creating = null;
      }
      continue;
    }

    const create = CREATE_TABLE_RE.exec(line);
    if (create) {
      creating = create[1];
      tableCols.set(creating, []);
      continue;
    }

    if (!line.startsWith('INSERT INTO `')) continue;
    const tick = line.indexOf('`', 13);
    const table = line.slice(13, tick);

    if (table !== acceptFor) {
      acceptFor = table;
      accept = null;
      const cols = tableCols.get(table);
      if (
        cols &&
        REQUIRED_COLS.every((c) => cols.includes(c)) &&
        (!opts.boards || opts.boards.includes(table))
      ) {
        const idx: Record<string, number> = {};
        cols.forEach((c, i) => (idx[c] = i));
        accept = { board: table, idx };
        if (!stats.tables.includes(table)) stats.tables.push(table);
      }
    }
    if (!accept) continue;

    const { board } = accept;
    const valuesAt = line.indexOf(' VALUES ', tick);
    if (valuesAt < 0) continue;

    // An explicit column list on the INSERT overrides the CREATE TABLE order,
    // because it is what the tuples actually follow. Cached on the accept
    // entry: the list is identical on every statement for a table, so this
    // rebuilds the map once rather than millions of times.
    let idx = accept.idx;
    const listed = insertColumns(line, tick + 1, valuesAt);
    if (listed) {
      const key = listed.join(',');
      if (key !== accept.listKey) {
        const m: Record<string, number> = {};
        listed.forEach((c, i) => (m[c] = i));
        // A dump may omit a column we need outright. Skipping the statement
        // is better than reading a field that is not there, and badLines
        // makes it visible instead of looking like an empty dump.
        accept.listIdx = REQUIRED_COLS.every((c) => c in m) ? m : null;
        accept.listKey = key;
      }
      if (!accept.listIdx) {
        stats.badLines++;
        continue;
      }
      idx = accept.listIdx;
    }

    try {
      for (const vals of parseTuples(line, valuesAt + 8)) {
        if (Number(vals[idx.subnum]) !== 0) {
          stats.skippedGhost++; // ghost posts aren't real 4chan posts
          continue;
        }
        const num = Number(vals[idx.num]);
        const parent = Number(vals[idx.parent]);
        const ts = Number(vals[idx.timestamp]);
        collectPending(
          pending,
          inserter
            .insert({
              site: opts.site,
              board,
              threadNo: parent === 0 ? num : parent,
              postNo: num,
              isOp: parent === 0,
              tsUtc: ts > 0 ? nyWallToUtc(ts) : null,
              name: vals[idx.name] ?? null,
              tripcode: vals[idx.trip] ?? null,
              subject: vals[idx.title] ?? null,
              bodyText: vals[idx.comment] ?? null,
              mediaFilename: vals[idx.media] ?? null,
              mediaMd5: vals[idx.media_hash] ?? null,
            })
            .then((ok) => {
              if (ok) stats.posts++;
              else stats.skippedDup++;
            })
        );
        if (++sinceCommit >= COMMIT_EVERY) {
          // Flush the stats tallies inside the same transaction as the
          // posts they describe, so an interrupted run leaves post_stats
          // consistent with what actually landed rather than losing every
          // tally accumulated since the run began.
          await inserter.finish();
          await Promise.all(pending);
          pending.length = 0;
          sinceCommit = 0;
        }
      }
    } catch {
      stats.badLines++; // typically a truncated final line
    }
  }
  await inserter.finish();
  await Promise.all(pending);
  bar.stop(`${stats.posts} posts from boards [${stats.tables.join(', ')}]`);
  return stats;
};
