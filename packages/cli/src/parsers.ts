import { bindConfig } from '@optique/config';
import { merge, object, or } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { multiple, optional, withDefault } from '@optique/core/modifiers';
import {
  argument,
  command,
  constant,
  flag,
  option,
} from '@optique/core/primitives';
import { choice, integer, string } from '@optique/core/valueparser';

import { configContext } from './config.ts';
import { dbOptions } from './env.ts';

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

// ---- shared option groups ------------------------------------------------

/**
 * Where staging commands run.
 *
 * The archives live on the NAS, and running staging over the mount pays a
 * network round-trip per file operation, so these route the work to the
 * machine holding the data instead.
 */
const runnerOptions = object({
  remote: optional(
    option('--remote', string(), {
      description: message`Run on this SSH host instead of locally.`,
    })
  ),
  local: withDefault(
    flag('--local', {
      description: message`Force local execution even when .env names a NAS host.`,
    }),
    false
  ),
  key: optional(
    option('--key', string(), {
      description: message`SSH key to use. Passed with IdentitiesOnly, because ~/.ssh/config routes these hosts through an agent whose key set is not stable between invocations.`,
    })
  ),
});

/** Search/count filters, shared by the two query commands. */
const filterOptions = object({
  phrase: option('--phrase', string(), {
    description: message`Text to match.`,
  }),
  board: optional(
    option('--board', string(), {
      description: message`Restrict to one board.`,
    })
  ),
  site: withDefault(
    option('--site', string(), {
      description: message`Site label; almost always 4chan.`,
    }),
    '4chan'
  ),
  from: optional(
    option('--from', string(), {
      description: message`Inclusive lower bound: YYYY, YYYY-MM or YYYY-MM-DD (UTC).`,
    })
  ),
  to: optional(
    option('--to', string(), {
      description: message`Inclusive upper bound. --to 2018-09 means through the end of September 2018.`,
    })
  ),
});

// ---- commands ------------------------------------------------------------

const downloadCmd = command(
  'download',
  merge(
    object({
      action: constant('download' as const),
      source: argument(string({ metavar: 'SOURCE' })),
      'dry-run': withDefault(
        flag('--dry-run', {
          description: message`List what would be fetched, including what download.exclude filters out.`,
        }),
        false
      ),
      force: withDefault(
        flag('--force', {
          description: message`Re-download files already present and verified.`,
        }),
        false
      ),
      all: withDefault(
        flag('--all', {
          description: message`Include files that download.exclude skips -- image and thumbnail payloads, which on some items dwarf the text by 100x.`,
        }),
        false
      ),
    }),
    runnerOptions
  ),
  {
    description: message`Stage an archive.org item into the source's files.source directory. Runs on the NAS when NAS_HOST/NAS_ROOT are set, so the transfer goes straight to the array rather than through this machine.`,
  }
);

const prepareCmd = command(
  'prepare',
  merge(
    object({
      action: constant('prepare' as const),
      source: argument(string({ metavar: 'SOURCE' })),
      'dry-run': withDefault(
        flag('--dry-run', {
          description: message`Print the steps without running them.`,
        }),
        false
      ),
      force: withDefault(
        flag('--force', {
          description: message`Re-run even though out/ already exists.`,
        }),
        false
      ),
    }),
    runnerOptions
  ),
  {
    description: message`Run a source's staging pipeline: source/ -> extracted/ -> out/. Steps must be idempotent, and are skipped when out/ already exists.`,
  }
);

const warcExtractCmd = command(
  'warc-extract',
  merge(
    object({
      action: constant('warc-extract' as const),
      warc: option('--warc', string(), {
        description: message`A .warc/.warc.gz file, or a directory of them.`,
      }),
      out: option('--out', string(), {
        description: message`Directory to write extracted pages into.`,
      }),
      host: withDefault(
        option('--host', string(), {
          description: message`Only extract records whose URL host matches this regex.`,
        }),
        'boards\\.4chan(?:nel)?\\.org'
      ),
    }),
    runnerOptions
  ),
  { description: message`Extract saved HTML pages out of a WARC capture.` }
);

const ingestCmd = command(
  'ingest',
  merge(
    object({
      action: constant('ingest' as const),
      source: argument(string({ metavar: 'SOURCE' })),
      board: multiple(
        option('--board', string(), {
          description: message`Read only these boards. Repeatable. Note this does NOT mark the source complete: it covers part of the source by construction.`,
        })
      ),
    }),
    dbOptions
  ),
  {
    description: message`Ingest one source. The manifest supplies the adapter, input path and site; posts are keyed UNIQUE (site, board, post_no), so re-running adds only what is missing and ingesting the same post from two archives stores it once.`,
  }
);

const ingestAllCmd = command(
  'ingest-all',
  merge(
    object({
      action: constant('ingest-all' as const),
      'dry-run': withDefault(
        flag('--dry-run', {
          description: message`List the sources that would run, touching neither the database nor the archives.`,
        }),
        false
      ),
      exclude: multiple(
        option('--exclude', string(), {
          description: message`Skip this source on this run. Repeatable. Unrelated to whether it finished.`,
        })
      ),
      redo: multiple(
        option('--redo', string(), {
          description: message`Re-ingest this source even though it completed. Repeatable.`,
        })
      ),
      force: withDefault(
        flag('--force', {
          description: message`Re-ingest every source, completed or not.`,
        }),
        false
      ),
    }),
    dbOptions
  ),
  {
    description: message`Ingest every ready source in turn, skipping those whose last run finished cleanly, so an interrupted pass resumes instead of re-reading tens of GB that ON CONFLICT would discard. completed_at records COMPLETION, not progress: a source can get a long way in and still abort, so only a clean adapter return marks it. Re-staging an archive, or fixing an adapter bug that silently dropped rows, invalidates that mark -- use --redo or --force. A failure in one source does not abort the rest of the run.`,
  }
);

const indexesCmd = command(
  'indexes',
  merge(
    object({
      action: constant('indexes' as const),
      subcommand: argument(choice(['build', 'drop', 'status'] as const)),
      memory: bindConfig(
        withDefault(
          option('--memory', string(), {
            description: message`maintenance_work_mem for the build session.`,
          }),
          '4GB'
        ),
        {
          context: configContext,
          key: (c) => c.indexes?.memory ?? '4GB',
          default: '4GB',
        }
      ),
      tablespace: bindConfig(
        optional(
          option('--tablespace', string(), {
            description: message`Tablespace to build into. On this store the query indexes belong on the NVMe; the posts heap stays on the array.`,
          })
        ),
        {
          context: configContext,
          key: (c) => c.indexes?.tablespace,
          // Explicitly defaulted: bindConfig without a default REQUIRES a
          // value, so with no config file and no --tablespace, `indexes
          // status` failed outright rather than falling back to the
          // database default tablespace.
          default: undefined,
        }
      ),
      tempTablespace: bindConfig(
        optional(
          option('--temp-tablespace', string(), {
            description: message`Tablespace for the build's sort spill. Postgres writes temp files to the database's default tablespace, which here is the data-dir disk -- the smallest of the three, and the one WAL shares. A parallel build sorts every index entry through it.`,
          })
        ),
        {
          context: configContext,
          key: (c) => c.indexes?.tempTablespace,
          default: undefined,
        }
      ),
      only: multiple(
        option('--only', string(), {
          description: message`Build just this index. Repeatable. The GIN full-text index is the bulk of the total and scales with text volume rather than row count, so building the cheap btrees first tells you what space is left before the expensive one commits to it.`,
        })
      ),
    }),
    dbOptions
  ),
  {
    description: message`Build, drop or report the query-time indexes on posts. These are NOT created on connect: ingest needs only the UNIQUE constraint, and maintaining the rest per-insert costs far more than sorting them once at the end -- on the last full pass, GIN pending-list merges alone were 99.4% of all index blocks read from disk. A bulk load is therefore: indexes drop, ingest-all, indexes build.`,
  }
);

const boardsCmd = command(
  'boards',
  merge(object({ action: constant('boards' as const) }), dbOptions),
  { description: message`List boards present in the store, with post counts.` }
);

const refreshStatsCmd = command(
  'refresh-stats',
  merge(object({ action: constant('refresh-stats' as const) }), dbOptions),
  {
    description: message`Rebuild post_stats from the posts heap. Needed only to backfill a store that predates the table, or to repair drift after an interrupted ingest -- tallies are folded in at checkpoints, so a killed run leaves the counts short of what actually landed.`,
  }
);

const countCmd = command(
  'count',
  merge(
    object({
      action: constant('count' as const),
      by: withDefault(
        option('--by', choice(['month', 'day', 'year', 'total'] as const), {
          description: message`Bucket size for the counts.`,
        }),
        'month' as const
      ),
    }),
    filterOptions,
    dbOptions
  ),
  { description: message`Count posts matching a phrase, bucketed over time.` }
);

const searchCmd = command(
  'search',
  merge(
    object({
      action: constant('search' as const),
      limit: withDefault(
        option('--limit', integer(), {
          description: message`Maximum rows to return.`,
        }),
        20
      ),
    }),
    filterOptions,
    dbOptions
  ),
  { description: message`Show posts matching a phrase.` }
);

/**
 * `list manifests` is the odd one: it probes the archive tree rather than the
 * database, so it takes the runner flags and no --db. That asymmetry used to
 * be a bug -- USAGE advertised --db for every `list` subcommand and this one
 * rejected it -- and is now simply what the grammar says.
 */
const listManifestsCmd = command(
  'manifests',
  merge(object({ action: constant('list-manifests' as const) }), runnerOptions),
  {
    description: message`Every source manifest, its adapter, which stage directories hold data (s/e/o), and whether it is ready, pending, a dead end, or in error.`,
  }
);

const listQuery = merge(
  object({
    site: optional(
      option('--site', string(), {
        description: message`Restrict to one site.`,
      })
    ),
  }),
  dbOptions
);

const listBoardsCmd = command(
  'boards',
  merge(object({ action: constant('list-boards' as const) }), listQuery)
);
const listSitesCmd = command(
  'sites',
  merge(object({ action: constant('list-sites' as const) }), listQuery)
);
const listSourcesCmd = command(
  'sources',
  merge(object({ action: constant('list-sources' as const) }), listQuery)
);

const listCmd = command(
  'list',
  or(listManifestsCmd, listBoardsCmd, listSitesCmd, listSourcesCmd),
  {
    description: message`List what the store or the manifest registry contains.`,
  }
);

export const cli = or(
  downloadCmd,
  prepareCmd,
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
