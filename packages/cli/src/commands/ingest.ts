import type { InferValue } from '@optique/core/parser';
import type { Pool } from 'pg';

import { Result } from '@badrap/result';
import { merge, object, or } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { multiple, withDefault } from '@optique/core/modifiers';
import {
  argument,
  command,
  constant,
  flag,
  option,
} from '@optique/core/primitives';
import { choice, string } from '@optique/core/valueparser';
import { fail } from 'assert';

import { openDb } from '../database/db.ts';
import { ingestOne, type BoardTotals } from '../database/ingest.ts';
import {
  allSources,
  createSource,
  markSourceCompleted,
  type Source,
} from '../database/sources.ts';
import { connectionString, dbOptions } from '../env.ts';
import {
  addSourceToIngestLock,
  INGEST_LOCK_FILE,
  existsInIngestLock,
  readIngestLock,
  type IngestLock,
} from '../ingest-lock.ts';
import {
  type Manifest,
  readManifest,
  manifestPath,
  ingestInputs,
} from '../manifest.ts';
import { printTable } from '../table.ts';
import { PROJECT_ROOT } from '../utils/paths.ts';

export const ingestCmd = command(
  'ingest',
  merge(
    or(
      object({
        action: constant('ingest-sync' as const),
      }),
      object({
        action: constant('ingest' as const),
        source: argument(string({ metavar: 'SOURCE' })),
      })
    ),
    object({
      exclude: multiple(
        option('--exclude', string(), {
          description: message`Skip ingesting any posts belonging to the specified board`,
        })
      ),
      'dry-run': withDefault(
        flag('--dry-run', {
          description: message`Run the reader and report per-board rows, OPs and unparsed timestamps, writing NOTHING -- no posts, no post_stats, no completion mark. This is how a staged source is checked against its recorded figures: a plain re-ingest cannot do it, because every post already in the store is rejected by ON CONFLICT and counts as zero.`,
        }),
        false
      ),
    }),
    dbOptions
  ),
  {
    description: message`Ingest one source. The manifest supplies the adapter, input path and site; posts are keyed UNIQUE (site, board, post_no), so re-running adds only what is missing and ingesting the same post from two archives stores it once.`,
  }
);

export type IngestArgs = InferValue<typeof ingestCmd>;

class DatabaseAheadError extends Error {
  constructor(options?: {
    cause: {
      index: number;
      dbSources: Source[];
      lockSources: IngestLock['sources'][];
    };
  }) {
    super(
      `The database contains sources that do not appear in ${INGEST_LOCK_FILE}`,
      options
    );
    this.name = 'DATABASE_AHEAD';
  }
}

class DatabaseLockConflictError extends Error {
  constructor(options?: {
    cause: {
      index: number;
      dbSources: Source[];
      lockSources: IngestLock['sources'];
    };
  }) {
    super(
      `Source ${options !== undefined ? '#' + options.cause.index : ''}in ${INGEST_LOCK_FILE} conflicts with source ${options !== undefined ? '#' + options.cause.index : ''}in the database`,
      options
    );
    this.name = 'DATABASE_LOCK_CONFLICT';
  }
}

const computeRemainingSources = async (
  db: Pool
): Promise<Result<IngestLock['sources']>> => {
  const sourcesResult = Result.all([
    await readIngestLock(),
    await allSources(db),
  ]);
  if (sourcesResult.isErr) {
    return Result.err(sourcesResult.error);
  }

  const [{ version: lockVersion, sources: lockSources }, dbSources] =
    sourcesResult.value;

  if (lockVersion === '0.0.1') {
    if (dbSources.length > lockSources.length) {
      return Result.err(new DatabaseAheadError());
    }

    const remaining: IngestLock['sources'] = [];
    for (let i = 0; i < lockSources.length; i++) {
      const lockSource = lockSources[i]!;

      if (i < dbSources.length) {
        const dbSource = dbSources[i]!;
        if (
          dbSource.name !== lockSource.name &&
          lockSource.exclude.difference(dbSource.exclude).size > 0
        ) {
          return Result.err(
            new DatabaseLockConflictError({
              cause: { index: i, dbSources, lockSources },
            })
          );
        }
      } else {
        remaining.push(lockSource);
      }
    }
    return Result.ok(remaining);
  } else {
    return Result.err(new Error('Unknown manifest version'));
  }
};

type FakesSource = {
  id: number;
};
const createDbSource = async (
  db: Pool,
  manifest: Manifest,
  shouldCreate: boolean
): Promise<Result<Source | FakesSource>> => {
  if (shouldCreate) {
    try {
      return Result.ok(
        await createSource(db, {
          name: manifest.id,
          title: manifest.name,
          link: manifest.link,
          exclude: new Set(),
          notes: '',
        })
      );
    } catch (error) {
      return Result.err(
        error instanceof Error ? error : new Error('Unknown error')
      );
    }
  } else {
    return Result.ok({ id: 0 });
  }
};

const ingest = async (
  db: Pool,
  sourceName: string,
  exclude: Set<string>,
  dryRun: boolean
): Promise<void> => {
  // A source whose prepare step hasn't run is a normal state to hit; say so
  // plainly instead of dressing it up as a usage error.
  const resolved = readManifest(
    manifestPath(sourceName, PROJECT_ROOT),
    PROJECT_ROOT
  ).chain((m) => ingestInputs(m).map((inputs) => ({ manifest: m, inputs })));

  if (resolved.isErr) {
    if (resolved.error.kind === 'pending') {
      console.error(resolved.error.message);
      process.exit(2);
    }
    fail(resolved.error.message);
  }
  const { manifest, inputs } = resolved.value;

  console.log(
    `${dryRun ? 'Counting' : 'Ingesting'} ${manifest.name}` +
      ` [${manifest.adapter}] from ${manifest.path}`
  );

  try {
    if (!(await existsInIngestLock(sourceName, exclude))) {
      addSourceToIngestLock({
        name: sourceName,
        exclude,
      });
    }

    const sourceResult = await createDbSource(db, manifest, !dryRun);

    if (sourceResult.isErr) {
      console.log(sourceResult.error);
      return;
    }

    const { value: source } = sourceResult;

    const { summary, totals } = await ingestOne(
      db,
      manifest,
      source.id,
      inputs,
      exclude.size > 0 ? Array.from(exclude) : undefined,
      dryRun
    );

    console.log(summary);

    if (!dryRun) {
      await markSourceCompleted(db, source.id);
    }

    if (dryRun) {
      printTable(
        ['board', 'rows', 'ops', 'no timestamp'],
        totals.map((t) => [
          t.board,
          t.posts.toLocaleString(),
          t.ops.toLocaleString(),
          t.nullTs.toLocaleString(),
        ])
      );

      const sum = (f: (t: BoardTotals) => number): number =>
        totals.reduce((a, t) => a + f(t), 0);

      console.log(
        `\n${totals.length} board(s), ${sum((t) => t.posts).toLocaleString()} row(s),` +
          ` ${sum((t) => t.ops).toLocaleString()} OP(s),` +
          ` ${sum((t) => t.nullTs).toLocaleString()} without a timestamp`
      );
      console.log('nothing written: --dry-run');
      return;
    }
  } catch (error) {
    console.log(error);
    return;
  }
};

export const execIngest = async (o: IngestArgs): Promise<void> => {
  if (!connectionString(o)) {
    fail('ingest requires --db');
  }
  const db = await openDb(connectionString(o));

  const remainingResult = await computeRemainingSources(db);

  if (remainingResult.isErr) {
    console.log(remainingResult.error);
    await db.end();
    return;
  }

  if (o.action === 'ingest-sync') {
    const { value: remaining } = remainingResult;

    for (const source of remaining) {
      await ingest(db, source.name, source.exclude, o['dry-run']);
    }
  } else {
    if (remainingResult.value.length !== 0) {
      console.log('Error: Database not in sync with lockfile');
      console.log('Run `cli ingest` to sync');

      await db.end();

      return;
    }

    console.log(o);

    await ingest(db, o.source, new Set(o.exclude), o['dry-run']);
  }

  await db.end();
};
