import type { InferValue } from '@optique/core/parser';

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

import { openDb } from '../../database/db.ts';
import { connectionString, dbOptions } from '../../env.ts';
import { type TotalRule, totalsRow, printTable } from '../../table.ts';
import { listManifestsCmd } from './manifests.ts';

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

export const listCmd = command(
  'list',
  or(listManifestsCmd, listBoardsCmd, listSitesCmd),
  {
    description: message`List what the store or the manifest registry contains.`,
  }
);

export type ListQueryArgs = Exclude<
  InferValue<typeof listCmd>,
  { action: 'list-manifests' }
>;

/**
 * The subcommand names, derived from the grammar rather than restated.
 *
 * Keying LIST_QUERIES on this union instead of `string` is what makes a
 * subcommand added to the parser without a query here a compile error rather
 * than an `undefined` at runtime -- the same rule cli.ts's action switch
 * already follows.
 */
type ListKind = ListQueryArgs['action'] extends `list-${infer K}` ? K : never;

const LIST_QUERIES: Record<
  ListKind,
  { headers: string[]; totals: TotalRule[]; sql: string }
> = {
  boards: {
    headers: ['site', 'board', 'posts', 'threads', 'first', 'last'],
    // posts/threads sum cleanly since each belongs to exactly one board
    totals: ['label', 'blank', 'sum', 'sum', 'min', 'max'],
    sql: `
      SELECT p.site, p.board,
             COUNT(*) AS posts,
             COUNT(DISTINCT p.thread_no) AS threads,
             to_char(to_timestamp(MIN(p.ts_utc)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS first,
             to_char(to_timestamp(MAX(p.ts_utc)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last
      FROM posts p {WHERE}
      GROUP BY p.site, p.board
      ORDER BY p.site, p.board`,
  },
  sites: {
    headers: ['site', 'boards', 'posts', 'first', 'last'],
    totals: ['label', 'sum', 'sum', 'min', 'max'],
    sql: `
      SELECT p.site,
             COUNT(DISTINCT p.board) AS boards,
             COUNT(*) AS posts,
             to_char(to_timestamp(MIN(p.ts_utc)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS first,
             to_char(to_timestamp(MAX(p.ts_utc)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last
      FROM posts p {WHERE}
      GROUP BY p.site
      ORDER BY p.site`,
  },
};

export const execList = async (o: ListQueryArgs): Promise<void> => {
  // The grammar already picked the subcommand, so there is nothing left to
  // validate here -- 'list-boards' etc. map straight onto the query table.
  const query = LIST_QUERIES[o.action.slice('list-'.length) as ListKind];

  const params: string[] = [];
  let where = '';
  if (o.site) {
    where = 'WHERE p.site = $1';
    params.push(o.site);
  }
  const sql = query.sql.replace('{WHERE}', where);

  const db = await openDb(connectionString(o));
  try {
    const { rows } = await db.query<Record<string, string | number | null>>(
      sql,
      params
    );
    if (rows.length === 0) {
      console.log('database is empty');
      return;
    }
    const body = rows.map((r) => Object.values(r));
    // a totals row only adds signal when there's more than one row to total
    const footer = body.length > 1 ? totalsRow(query.totals, body) : undefined;
    printTable(query.headers, body, footer);
  } finally {
    await db.end();
  }
};
