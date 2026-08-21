import { or } from '@optique/core/constructs';
import { runAsync } from '@optique/run';
import { join } from 'node:path';

import { boardsCmd, execBoards } from './commands/boards.ts';
import { countCmd, execCount } from './commands/count.ts';
import { downloadCmd, execDownload } from './commands/download.ts';
import { execIndexes, indexesCmd } from './commands/indexes.ts';
import { execIngestAll, ingestAllCmd } from './commands/ingest-all.ts';
import { execIngest, ingestCmd } from './commands/ingest.ts';
import { execList, listCmd } from './commands/list/list.ts';
import { execListManifests } from './commands/list/manifests.ts';
import {
  execPrepareRuntime,
  prepareRuntimeCmd,
} from './commands/prepare-runtime.ts';
import { execPrepare, prepareCmd } from './commands/prepare.ts';
import { execRefreshStats, refreshStatsCmd } from './commands/refresh-stats.ts';
import { execSearch, searchCmd } from './commands/search.ts';
import { execSurvey, surveyCmd } from './commands/survey.ts';
import { execWarcExtract, warcExtractCmd } from './commands/warc-extract.ts';
import { configContext, CONFIG_FILE } from './config.ts';
import { envContext } from './env.ts';
import { PROJECT_ROOT } from './utils/paths.ts';

export const cli = or(
  surveyCmd,
  downloadCmd,
  prepareCmd,
  prepareRuntimeCmd,
  warcExtractCmd,
  ingestCmd,
  ingestAllCmd,
  indexesCmd,
  boardsCmd,
  refreshStatsCmd,
  countCmd,
  searchCmd,
  listCmd
);

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
    await execList(args);
    break;
  default: {
    const never: never = args;
    throw new Error(`unhandled command: ${JSON.stringify(never)}`);
  }
}
