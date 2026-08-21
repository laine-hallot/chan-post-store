import { object, or } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { optional, withDefault } from '@optique/core/modifiers';
import { flag, option } from '@optique/core/primitives';
import { string } from '@optique/core/valueparser';

import { boardsCmd } from './commands/boards.ts';
import { countCmd } from './commands/count.ts';
import { downloadCmd } from './commands/download.ts';
import { indexesCmd } from './commands/indexes.ts';
import { ingestAllCmd } from './commands/ingest-all.ts';
import { ingestCmd } from './commands/ingest.ts';
import { listCmd } from './commands/list/list.ts';
import { prepareRuntimeCmd } from './commands/prepare-runtime.ts';
import { prepareCmd } from './commands/prepare.ts';
import { refreshStatsCmd } from './commands/refresh-stats.ts';
import { searchCmd } from './commands/search.ts';
import { surveyCmd } from './commands/survey.ts';
import { warcExtractCmd } from './commands/warc-extract.ts';

/**
 * The command-line grammar, as one composed parser.
 *
 * Replaces twelve separate `parseArgs` calls and a dispatch `switch`. The
 * win is not brevity -- it is that the option set, the parsed type, and the
 * help text can no longer disagree, which they previously could and did:
 * USAGE advertised `--db` on every `list` subcommand, while `list manifests`
 * rejected it.
 *
 * Prose that used to live in the hand-written USAGE banner is attached to
 * the parser it describes, so `--help` on a subcommand shows the reasoning
 * that applies to it rather than one wall of text covering everything.
 */

// ---- commands ------------------------------------------------------------

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
