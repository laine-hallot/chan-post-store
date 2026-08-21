import { runAsync } from '@optique/run';
import { join } from 'node:path';

import { execBoards } from './commands/boards.ts';
import { execCount } from './commands/count.ts';
import { execDownload } from './commands/download.ts';
import { execIndexes } from './commands/indexes.ts';
import { execIngestAll } from './commands/ingest-all.ts';
import { execIngest } from './commands/ingest.ts';
import { execList } from './commands/list/list.ts';
import { execListManifests } from './commands/list/manifests.ts';
import { execPrepareRuntime } from './commands/prepare-runtime.ts';
import { execPrepare } from './commands/prepare.ts';
import { execRefreshStats } from './commands/refresh-stats.ts';
import { execSearch } from './commands/search.ts';
import { execSurvey } from './commands/survey.ts';
import { execWarcExtract } from './commands/warc-extract.ts';
import { configContext, CONFIG_FILE } from './config.ts';
import { envContext } from './env.ts';
import { cli } from './parsers.ts';
import { fail } from './utils/console.ts';
import { PROJECT_ROOT } from './utils/paths.ts';

/** Parse a date bound; returns epoch seconds. End bounds are advanced by one
 * unit of their precision so they can be used as an exclusive upper bound. */
const parseBound = (s: string, end: boolean): number => {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s);
  if (!m) {
    fail(`invalid date: ${s}`);
  }
  let [year, month, day] = [
    Number(m[1]),
    m[2] ? Number(m[2]) : null,
    m[3] ? Number(m[3]) : null,
  ];
  if (end) {
    if (day != null) {
      day++;
    } else if (month != null) {
      month++;
    } else {
      year++;
    }
  }
  return Date.UTC(year, (month ?? 1) - 1, day ?? 1) / 1000;
};

export const FILTER_OPTIONS = {
  db: { type: 'string' },
  phrase: { type: 'string' },
  board: { type: 'string' },
  site: { type: 'string', default: '4chan' },
  from: { type: 'string' },
  to: { type: 'string' },
} as const;

export interface FilterValues {
  phrase?: string;
  board?: string;
  site: string;
  from?: string;
  to?: string;
}

/** WHERE clauses + params shared by `count` and `search`. */
export const phraseFilters = (
  o: FilterValues
): {
  where: string;
  params: (string | number)[];
} => {
  const where: string[] = [
    "p.search_vector @@ phraseto_tsquery('simple', $1)",
    'p.site = $2',
  ];
  const params: (string | number)[] = [o.phrase!, o.site];
  if (o.board) {
    params.push(o.board);
    where.push(`p.board = $${params.length}`);
  }
  if (o.from) {
    params.push(parseBound(o.from, false));
    where.push(`p.ts_utc >= $${params.length}`);
  }
  if (o.to) {
    params.push(parseBound(o.to, true));
    where.push(`p.ts_utc < $${params.length}`);
  }
  return { where: where.join(' AND '), params };
};

export const args = await runAsync(cli, {
  contexts: [envContext, configContext],
  contextOptions: { getConfigPath: () => join(PROJECT_ROOT, CONFIG_FILE) },
  programName: 'cli.ts',
  // Both spellings: `cli.ts --help` and `cli.ts help indexes`. Without this
  // Optique registers neither and --help is just an unknown option.
  help: 'both',
});

// Exhaustive over the grammar's discriminant: a command added to parsers.ts
// without a case here is a compile error, not a silent no-op.
switch (args.action) {
  case 'download':
    await execDownload(args);
    break;
  case 'prepare':
    await execPrepare(args);
    break;
  case 'prepare-runtime':
    await execPrepareRuntime(args);
    break;
  case 'warc-extract':
    await execWarcExtract(args);
    break;
  case 'survey':
    await execSurvey(args);
    break;
  case 'ingest':
    await execIngest(args);
    break;
  case 'ingest-all':
    await execIngestAll(args);
    break;
  case 'indexes':
    await execIndexes(args);
    break;
  case 'boards':
    await execBoards(args);
    break;
  case 'refresh-stats':
    await execRefreshStats(args);
    break;
  case 'count':
    await execCount(args);
    break;
  case 'search':
    await execSearch(args);
    break;
  case 'list-manifests':
    await execListManifests(args);
    break;
  case 'list-boards':
  case 'list-sites':
  case 'list-sources':
    await execList(args);
    break;
  default: {
    const never: never = args;
    throw new Error(`unhandled command: ${JSON.stringify(never)}`);
  }
}
