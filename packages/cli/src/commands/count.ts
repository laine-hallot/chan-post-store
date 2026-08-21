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

import { filterOptions } from '../cli-common-args.ts';
import { phraseFilters } from '../cli.ts';
import { openDb } from '../database/db.ts';
import { connectionString, dbOptions } from '../env.ts';
import { fail } from '../utils/console.ts';

export const countCmd = command(
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

export type CountArgs = InferValue<typeof countCmd>;

export const BUCKET_FORMATS: Record<string, string> = {
  day: 'YYYY-MM-DD',
  month: 'YYYY-MM',
  year: 'YYYY',
};

export const execCount = async (o: CountArgs): Promise<void> => {
  if (!connectionString(o) || !o.phrase) {
    fail('count requires --db and --phrase');
  }
  if (o.by !== 'total' && !(o.by in BUCKET_FORMATS)) {
    fail(
      `--by must be one of: ${Object.keys(BUCKET_FORMATS).join(', ')}, total`
    );
  }

  const { where, params } = phraseFilters(o);

  // A plain COUNT(*) is correct because posts holds one row per post: the
  // UNIQUE (site, board, post_no) constraint means an archive that also had
  // the post contributed no second row to count.
  const bucketExpr =
    o.by === 'total'
      ? "'total'"
      : `to_char(to_timestamp(p.ts_utc) AT TIME ZONE 'UTC', '${BUCKET_FORMATS[o.by]}')`;
  const sql = `
    SELECT ${bucketExpr} AS bucket,
           COUNT(*) AS posts
    FROM posts p
    WHERE ${where}
    GROUP BY bucket
    ORDER BY bucket
  `;

  const db = await openDb(connectionString(o));
  try {
    const { rows } = await db.query<{ bucket: string | null; posts: number }>(
      sql,
      params
    );
    if (rows.length === 0) {
      console.log('no matches');
      return;
    }
    let total = 0;
    for (const r of rows) {
      console.log(`${r.bucket ?? '(no date)'}\t${r.posts}`);
      total += r.posts;
    }
    if (o.by !== 'total') {
      console.log(`total\t${total}`);
    }
  } finally {
    await db.end();
  }
};
