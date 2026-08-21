import type { InferValue } from '@optique/core/parser';

import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { optional, withDefault } from '@optique/core/modifiers';
import { command, constant, flag, option } from '@optique/core/primitives';
import { integer } from '@optique/core/valueparser';

import { filterOptions } from '../cli-common-args.ts';
import { phraseFilters } from '../cli.ts';
import { openDb } from '../database/db.ts';
import { connectionString, dbOptions } from '../env.ts';
import { fail, write } from '../utils/console.ts';

export const searchCmd = command(
  'search',
  merge(
    object({
      action: constant('search' as const),
      limit: optional(
        option('--limit', integer(), {
          description: message`Maximum rows to return. Unset means every match, streamed through a server-side cursor rather than buffered.`,
        })
      ),
      json: withDefault(
        flag('--json', {
          description: message`Emit a JSON array of post objects instead of the readable form. Streams, so it stays usable unlimited. ts_utc stays epoch seconds -- lossless, and the text form is the one that formats dates.`,
        }),
        false
      ),
    }),
    filterOptions,
    dbOptions
  ),
  {
    description: message`Show posts matching a phrase. Returns every match by default: the cost of a search is set by how many posts match, not by how many are printed, so a truncating default hid that rather than avoiding it.`,
  }
);

export type SearchArgs = InferValue<typeof searchCmd>;

export const execSearch = async (o: SearchArgs): Promise<void> => {
  if (!connectionString(o) || !o.phrase) {
    fail('search requires --db and --phrase');
  }
  // Unset means every match. `optional` gives undefined, and Number(undefined)
  // is NaN rather than 0, so the guard below must test for the absence first
  // or "no limit" reads as "invalid limit".
  const limit = o.limit == null ? null : Number(o.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    fail(`invalid --limit: ${o.limit}`);
  }

  const { where, params } = phraseFilters(o);
  // No GROUP BY: posts holds one row per post, so there are no copies to
  // collapse. Dropping it also lets the LIMIT short-circuit -- grouping
  // forced every match to be materialized and sorted before the first row
  // could be returned.
  const sql = `
    SELECT p.board, p.thread_no, p.post_no, p.is_op, p.ts_utc,
           p.name, p.tripcode, p.subject, p.body_text
    FROM posts p
    WHERE ${where}
    ORDER BY p.ts_utc, p.post_no
    ${limit === null ? '' : `LIMIT $${params.length + 1}`}
  `;
  const totalSql = `
    SELECT COUNT(*) AS n
    FROM posts p
    WHERE ${where}
  `;

  interface Hit {
    board: string;
    thread_no: number;
    post_no: number;
    is_op: boolean;
    ts_utc: number | null;
    name: string | null;
    tripcode: string | null;
    subject: string | null;
    body_text: string | null;
  }

  const renderHit = (r: Hit): string => {
    const when = r.ts_utc
      ? new Date(r.ts_utc * 1000).toISOString().replace('T', ' ').slice(0, 16)
      : '(no date)';
    const who = `${r.name ?? 'Anonymous'}${r.tripcode ?? ''}`;
    let header = `[${when}] /${r.board}/${r.post_no}`;
    if (r.is_op) {
      header += ' (OP)';
    } else {
      header += ` in ${r.thread_no}`;
    }
    header += ` — ${who}`;
    if (r.subject) {
      header += ` — “${r.subject}”`;
    }
    const body = r.body_text ? `${r.body_text.replace(/^/gm, '  ')}\n` : '';
    return `${header}\n${body}\n`;
  };

  const db = await openDb(connectionString(o));
  // A server-side cursor rather than one buffered result set. With no default
  // limit a broad phrase can match millions of posts, and node-postgres
  // materializes an entire result before handing it back -- the row count is
  // the user's business, but running the process out of memory is not.
  const client = await db.connect();
  let seen = 0;
  try {
    await client.query('BEGIN');
    await client.query(
      `DECLARE search_hits NO SCROLL CURSOR FOR ${sql}`,
      limit === null ? params : [...params, limit]
    );
    for (;;) {
      const { rows } = await client.query<Hit>('FETCH FORWARD 500 search_hits');
      if (rows.length === 0) {
        break;
      }
      for (const r of rows) {
        if (o.json) {
          await write(seen === 0 ? '[\n' : ',\n');
          await write(JSON.stringify(r));
        } else {
          await write(renderHit(r));
        }
        seen++;
      }
    }
    if (o.json) {
      await write(seen === 0 ? '[]\n' : '\n]\n');
    }
    if (seen === 0 && !o.json) {
      console.log('no matches');
      return;
    }
    // Only when the limit is what stopped us. Previously this COUNT(*) ran on
    // every search, including ones that had already returned every match --
    // a second full pass over the matching rows, which on this store is the
    // expensive half of the query (the GIN lookup is milliseconds; the heap
    // recheck is minutes).
    if (!o.json && limit !== null && seen === limit) {
      const { rows } = await client.query<{ n: number }>(totalSql, params);
      const total = rows[0]!.n;
      if (total > seen) {
        console.log(
          `(showing ${seen} of ${total} matching posts; raise or drop --limit for more)`
        );
      }
    }
  } finally {
    // The cursor dies with the transaction; ending it explicitly keeps the
    // pooled connection clean for release.
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await db.end();
  }
};
