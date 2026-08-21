import type { InferValue } from '@optique/core/parser';
import type { Pool } from 'pg';

import { merge, object } from '@optique/core/constructs';
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

import {
  openDb,
  getOrCreateSource,
  markSourceCompleted,
} from '../database/db.ts';
import { ingestOne, type BoardTotals } from '../database/ingest.ts';
import { connectionString, dbOptions } from '../env.ts';
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
    object({
      action: constant('ingest' as const),
      source: argument(string({ metavar: 'SOURCE' })),
      board: multiple(
        option('--board', string(), {
          description: message`Read only these boards. Repeatable. Note this does NOT mark the source complete: it covers part of the source by construction.`,
        })
      ),
      'count-only': withDefault(
        flag('--count-only', {
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

export const execIngest = async (o: IngestArgs): Promise<void> => {
  const id = o.source;
  if (!connectionString(o)) {
    fail('ingest requires --db');
  }

  // A source whose prepare step hasn't run is a normal state to hit; say so
  // plainly instead of dressing it up as a usage error.
  const resolved = readManifest(
    manifestPath(id, PROJECT_ROOT),
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

  const countOnly = o['count-only'];
  const db = await openDb(connectionString(o));
  try {
    // Count-only must not create a source row either -- registering a source
    // is a write, and the point of the mode is that the store is untouched.
    // The id is never used, because nothing is inserted.
    const sourceId = countOnly
      ? 0
      : await getOrCreateSource(db, manifest.name, manifest.link);
    console.log(
      `${countOnly ? 'counting' : 'ingesting'} ${manifest.name}` +
        ` [${manifest.adapter}] from ${manifest.path}`
    );
    const { summary, totals } = await ingestOne(
      db,
      manifest,
      sourceId,
      inputs,
      o.board.length ? [...o.board] : undefined,
      countOnly
    );
    console.log(summary);

    if (countOnly) {
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
      console.log('nothing written: --count-only');
      return;
    }
    // A --board run covers part of the source, so it is progress, not
    // completion -- leaving completed_at null keeps ingest-all honest about
    // the boards this run never looked at.
    if (o.board?.length) {
      console.log(
        'not marked complete: --board ingests only part of the source'
      );
    } else {
      await markSourceCompleted(db, sourceId);
    }
  } finally {
    await db.end();
  }
};
