import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Deep imports, not '@chan-post-store/cli': the package index pulls in
// env.ts and paths.ts, and paths.ts throws at load time on a machine with no
// checkout -- which is exactly where this runs.
import { ingestHtml } from '@chan-post-store/cli/src/adapters/html.ts';
import { ingestJson } from '@chan-post-store/cli/src/adapters/json.ts';
import { ingestSql } from '@chan-post-store/cli/src/adapters/sql.ts';

import { PostDateHistogram, type ScanResult } from './histogram.ts';

/**
 * The half of post-dates that runs where the archives are.
 *
 * Bundled to dist/post-dates-scan.mjs and copied to the archive host the same
 * way a prepare script is, then run with the dataset directory as cwd. It
 * reads the staged tree with the ingest readers themselves, in count-only
 * mode, so the rows charted are exactly the rows an ingest of these files
 * would offer the store -- not a second parser that could disagree with it.
 *
 * Only the summary crosses the network: a few thousand buckets, written to a
 * file beside the data because the readers print their own progress to
 * stdout and a result on stdout would have to be picked out of it.
 */

export interface ScanConfig {
  source: string;
  adapter: 'sql' | 'json' | 'html';
  /** The staged tree, relative to the dataset dir (cwd). */
  path: string;
  site: string;
  board: string;
  excludeBoards: string[];
  buckets: number;
  /** Where to write the ScanResult, relative to cwd. */
  out: string;
}

const cfg = JSON.parse(process.argv[2] ?? '') as ScanConfig;
const hist = new PostDateHistogram(cfg.buckets);
const observe = (p: {
  board: string;
  postNo: number;
  tsUtc: number | null;
}): void => {
  // The readers already honour `boards`, but a board filter that silently
  // stopped working would chart the whole source as this board.
  if (p.board === cfg.board) {
    hist.add(p.postNo, p.tsUtc);
  }
};
const common = {
  sourceId: 0,
  site: cfg.site,
  boards: [cfg.board],
  excludeBoards: cfg.excludeBoards,
  countOnly: true,
  observe,
};

if (cfg.adapter === 'sql') {
  // The staged layout is one `<board>.sql` holding the board and its
  // `_deleted` companion, so when that file exists it is all there is to
  // read. Otherwise every file is read and the reader filters by table.
  const own = join(cfg.path, `${cfg.board}.sql`);
  const files = existsSync(own)
    ? [own]
    : readdirSync(cfg.path)
        .filter((f) => f.toLowerCase().endsWith('.sql'))
        .sort()
        .map((f) => join(cfg.path, f));
  for (const file of files) {
    await ingestSql(null, { ...common, file, fileSize: statSync(file).size });
  }
} else if (cfg.adapter === 'json') {
  await ingestJson(null, { ...common, root: cfg.path });
} else {
  await ingestHtml(null, { ...common, root: cfg.path });
}

const result: ScanResult = {
  source: cfg.source,
  site: cfg.site,
  board: cfg.board,
  width: hist.width,
  buckets: hist.buckets(),
};
writeFileSync(cfg.out, JSON.stringify(result));
