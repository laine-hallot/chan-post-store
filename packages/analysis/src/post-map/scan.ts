import { readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Deep imports, not '@chan-post-store/cli': see post-dates/scan.ts.
import { ingestHtml } from '@chan-post-store/cli/src/adapters/html.ts';
import { ingestJson } from '@chan-post-store/cli/src/adapters/json.ts';
import { ingestSql } from '@chan-post-store/cli/src/adapters/sql.ts';

import { BitsetBuilder, encodeScan } from './bitset.ts';

/**
 * The half of post-map that runs where the archives are, shipped and run
 * exactly as post-dates' scan is: the ingest readers in count-only mode, so
 * the post numbers mapped are the ones an ingest of these files would offer
 * the store. Writes a gzipped bitset per board beside the data.
 *
 * One pass covers every board, so mapping a whole source reads it once
 * rather than once per board.
 */

export interface ScanConfig {
  source: string;
  adapter: 'sql' | 'json' | 'html';
  /** The staged tree, relative to the dataset dir (cwd). */
  path: string;
  site: string;
  /** Only this board; every board the source holds when absent. */
  board?: string;
  excludeBoards: string[];
  /** Where to write the scan, relative to cwd. */
  out: string;
}

const cfg = JSON.parse(process.argv[2] ?? '') as ScanConfig;
const seen = new Map<string, BitsetBuilder>();
const common = {
  sourceId: 0,
  site: cfg.site,
  boards: cfg.board === undefined ? undefined : [cfg.board],
  excludeBoards: cfg.excludeBoards,
  countOnly: true,
  observe: (p: { board: string; postNo: number }): void => {
    // As in post-dates: a board filter that silently stopped working would
    // map the whole source as this board.
    if (cfg.board !== undefined && p.board !== cfg.board) {
      return;
    }
    let b = seen.get(p.board);
    if (b === undefined) {
      b = new BitsetBuilder();
      seen.set(p.board, b);
    }
    b.add(p.postNo);
  },
};

if (cfg.adapter === 'sql') {
  // One `<board>.sql` per board, so a single board is one file and the rest
  // are never read -- ~70GB for a warosu backup, to find no /g/. Listed here
  // rather than by ingestInputs, which would have to run on this host anyway.
  const files = !statSync(cfg.path).isDirectory()
    ? [cfg.path]
    : readdirSync(cfg.path)
        .filter((f) =>
          cfg.board === undefined
            ? f.toLowerCase().endsWith('.sql')
            : f === `${cfg.board}.sql`
        )
        .sort()
        .map((f) => join(cfg.path, f));
  for (const file of files) {
    console.log(`  ${file}`);
    await ingestSql(null, { ...common, file, fileSize: statSync(file).size });
  }
} else if (cfg.adapter === 'json') {
  await ingestJson(null, { ...common, root: cfg.path });
} else {
  await ingestHtml(null, { ...common, root: cfg.path });
}

writeFileSync(
  cfg.out,
  encodeScan(
    [...seen]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([board, b]) => ({
        source: cfg.source,
        site: cfg.site,
        board,
        rows: b.rows,
        maxNo: b.maxNo,
        bits: b.bits(),
      }))
  )
);
