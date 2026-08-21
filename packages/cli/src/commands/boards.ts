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
import { hasStats, boardList } from '../database/stats.ts';
import { connectionString, dbOptions } from '../env.ts';
import { printTable, totalsRow } from '../table.ts';
import { fail } from '../utils/console.ts';

export const boardsCmd = command(
  'boards',
  merge(object({ action: constant('boards' as const) }), dbOptions),
  { description: message`List boards present in the store, with post counts.` }
);

export type BoardsArgs = InferValue<typeof boardsCmd>;

/**
 * Board list from the summary table.
 *
 * Distinct from `list boards`, which dedupes post/thread numbers across
 * overlapping archives by scanning `posts` — accurate but minutes-long on a
 * large store. This reads pre-rolled counts instead, so it answers "which
 * boards exist and when is their data from" immediately; the counts are raw
 * per-archive contributions and can double-count a post held twice.
 */
export const execBoards = async (o: BoardsArgs): Promise<void> => {
  if (!connectionString(o)) {
    fail('boards requires --db');
  }
  const db = await openDb(connectionString(o));
  try {
    if (!(await hasStats(db))) {
      fail('post_stats is empty — run: cli.ts refresh-stats --db <file>');
    }
    const rows = await boardList(db);
    if (rows.length === 0) {
      console.log('no boards recorded');
      return;
    }
    // Years are rendered as strings: printTable group-separates numbers,
    // which would print 2015 as "2,015".
    const body = rows.map((r) => [
      r.site,
      r.board,
      r.posts,
      r.firstYear == null ? null : String(r.firstYear),
      r.lastYear == null ? null : String(r.lastYear),
    ]);
    printTable(
      ['site', 'board', 'posts', 'first', 'last'],
      body,
      body.length > 1
        ? totalsRow(['label', 'blank', 'sum', 'min', 'max'], body)
        : undefined
    );
  } finally {
    await db.end();
  }
};
