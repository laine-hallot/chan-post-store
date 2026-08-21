import type { InferValue } from '@optique/core/parser';

import { bindConfig } from '@optique/config';
import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { multiple, optional, withDefault } from '@optique/core/modifiers';
import {
  argument,
  command,
  constant,
  flag,
  option,
} from '@optique/core/primitives';
import { choice, string } from '@optique/core/valueparser';

import { openDb } from '../database/db.ts';
import { refreshPostStats } from '../database/stats.ts';
import { connectionString, dbOptions } from '../env.ts';
import { fail } from '../utils/console.ts';

export const refreshStatsCmd = command(
  'refresh-stats',
  merge(object({ action: constant('refresh-stats' as const) }), dbOptions),
  {
    description: message`Rebuild post_stats from the posts heap. Needed only to backfill a store that predates the table, or to repair drift after an interrupted ingest -- tallies are folded in at checkpoints, so a killed run leaves the counts short of what actually landed.`,
  }
);

export type RefreshStatsArgs = InferValue<typeof refreshStatsCmd>;

/**
 * Rebuilds the post_stats summary table.
 *
 * Ingest keeps it current, so this is for backfilling a store that predates
 * the table. One full pass over `posts`.
 */
export const execRefreshStats = async (o: RefreshStatsArgs): Promise<void> => {
  if (!connectionString(o)) {
    fail('refresh-stats requires --db');
  }
  const db = await openDb(connectionString(o));
  try {
    console.log('rebuilding post_stats (one full pass over posts) ...');
    const t0 = Date.now();
    const rows = await refreshPostStats(db);
    console.log(
      `wrote ${rows} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
  } finally {
    await db.end();
  }
};
