import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Deep imports, not '@chan-post-store/cli': see post-dates/scan.ts.
import { ingestHtml } from '@chan-post-store/cli/src/adapters/html.ts';
import { ingestJson } from '@chan-post-store/cli/src/adapters/json.ts';
import { ingestSql } from '@chan-post-store/cli/src/adapters/sql.ts';

import { BitsetBuilder, encodeBitset } from './bitset.ts';

/**
 * The half of post-map that runs where the archives are, shipped and run
 * exactly as post-dates' scan is: the ingest readers in count-only mode, so
 * the post numbers mapped are the ones an ingest of these files would offer
 * the store. Writes a gzipped bitset beside the data.
 */

export interface ScanConfig {
  source: string;
  adapter: 'sql' | 'json' | 'html';
  /** The staged tree, relative to the dataset dir (cwd). */
  path: string;
  site: string;
  board: string;
  excludeBoards: string[];
  /** Where to write the bitset, relative to cwd. */
  out: string;
}

const cfg = JSON.parse(process.argv[2] ?? '') as ScanConfig;
const seen = new BitsetBuilder();
const common = {
  sourceId: 0,
  site: cfg.site,
  boards: [cfg.board],
  excludeBoards: cfg.excludeBoards,
  countOnly: true,
  observe: (p: { board: string; postNo: number }): void => {
    // As in post-dates: a board filter that silently stopped working would
    // map the whole source as this board.
    if (p.board === cfg.board) {
      seen.add(p.postNo);
    }
  },
};

if (cfg.adapter === 'sql') {
  // One `<board>.sql` per board; see post-dates/scan.ts for why the others
  // are not read.
  const files = statSync(cfg.path).isDirectory()
    ? [join(cfg.path, `${cfg.board}.sql`)].filter((f) => existsSync(f))
    : [cfg.path];
  for (const file of files) {
    await ingestSql(null, { ...common, file, fileSize: statSync(file).size });
  }
} else if (cfg.adapter === 'json') {
  await ingestJson(null, { ...common, root: cfg.path });
} else {
  await ingestHtml(null, { ...common, root: cfg.path });
}

writeFileSync(
  cfg.out,
  encodeBitset({
    source: cfg.source,
    site: cfg.site,
    board: cfg.board,
    rows: seen.rows,
    maxNo: seen.maxNo,
    bits: seen.bits(),
  })
);
