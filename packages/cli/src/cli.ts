import { or } from '@optique/core/constructs';
import { runAsync } from '@optique/run';
import { join } from 'node:path';

import { countCmd, execCount } from './commands/count.ts';
import { downloadCmd, execDownload } from './commands/download.ts';
import { execIndexes, indexesCmd } from './commands/indexes.ts';
import { execIngest, ingestCmd } from './commands/ingest.ts';
import * as list from './commands/list/list.ts';
import { execListManifests } from './commands/list/manifests.ts';
import { execPrepare, prepareCmd } from './commands/prepare.ts';
import { execRefreshStats, refreshStatsCmd } from './commands/refresh-stats.ts';
import {
  execInstallRemoteRuntime,
  remoteRuntimeCmd,
} from './commands/remote-runtime.ts';
import { execSearch, searchCmd } from './commands/search.ts';
import { execSources, sourcesCmd } from './commands/sources.ts';
import { execSurvey, surveyCmd } from './commands/survey.ts';
import { execWarcExtract, warcExtractCmd } from './commands/warc-extract.ts';
import { configContext, CONFIG_FILE } from './config.ts';
import { envContext } from './env.ts';
import { PROJECT_ROOT } from './utils/paths.ts';

export const cli = or(
  remoteRuntimeCmd,
  downloadCmd,
  prepareCmd,
  ingestCmd,
  indexesCmd,
  warcExtractCmd,
  refreshStatsCmd,
  countCmd,
  searchCmd,
  surveyCmd,
  sourcesCmd,
  list.listCmd
);

export const args = await runAsync(cli, {
  contexts: [envContext, configContext],
  contextOptions: { getConfigPath: () => join(PROJECT_ROOT, CONFIG_FILE) },
  programName: 'cli.ts',
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
  case 'install-remote-runtime':
    await execInstallRemoteRuntime(args);
    break;
  case 'warc-extract':
    await execWarcExtract(args);
    break;
  case 'survey':
    await execSurvey(args);
    break;
  case 'sources-delete':
    await execSources(args);
    break;
  case 'ingest':
    await execIngest(args);
    break;
  case 'ingest-sync':
    await execIngest(args);
    break;
  case 'indexes':
    await execIndexes(args);
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
    await list.execList(args);
    break;
  default: {
    const never: never = args;
    throw new Error(`unhandled command: ${JSON.stringify(never)}`);
  }
}
