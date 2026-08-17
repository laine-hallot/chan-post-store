import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { optional, withDefault } from '@optique/core/modifiers';
import { option, flag } from '@optique/core/primitives';
import { defineProgram } from '@optique/core/program';
import { string } from '@optique/core/valueparser';
import { run } from '@optique/run';
import * as echarts from 'echarts';
import { mkdirSync, writeFileSync } from 'fs';
import { resolve, join } from 'path';
import sanitize from 'sanitize-filename';

import {
  connectionString,
  dbOptions,
  envContext,
} from '@chan-post-store/cli/env';
import { PROJECT_ROOT } from '@chan-post-store/cli/paths';

import { openReadOnly } from '../db.ts';

interface YearBucket {
  /** Calendar year, e.g. "2015". */
  year: string;
  posts: number;
}
const bucketsFromStats = async (filter: {
  site?: string;
  board?: string;
  grouping?: 'source';
}): Promise<YearBucket[]> => {
  const { rows } = await db.query<YearBucket>(
    `SELECT ps.year::text AS year, SUM(ps.posts)::bigint AS posts
         FROM post_stats ps
        WHERE ps.site LIKE $1 AND ps.board LIKE $2 AND ps.year IS NOT NULL
        GROUP BY ps.year
        ORDER BY ps.year`,
    [filter.site ?? '%', filter.board ?? '%']
  );
  return rows;
};

const program = defineProgram({
  parser: merge(
    object({
      phrase: option('--phrase', string(), {
        description: message`Phrase to search for`,
      }),
      board: option('--board', string(), {
        description: message`Chart one board instead of the whole corpus. Changes what the bars mean: the corpus chart splits by archive, a board chart splits by whichever archives supplied that board.`,
      }),
      site: withDefault(
        option('--site', string(), {
          description: message`Site the --board belongs to. Ignored without --board.`,
        }),
        '4chan'
      ),
      out: optional(
        option('--out', string(), {
          description: message`Output path without extension, resolved against the repo root. Defaults to artifacts/post-coverage[-<site>-<board>].`,
        })
      ),
    }),
    dbOptions
  ),
  metadata: {
    name: 'coverage.ts',
    brief: message`Chart what the post store actually contains.`,
    description: message`Posts per calendar year, stacked by the archive that supplied them. Every post is counted once -- posts is keyed UNIQUE (site, board, post_no), so a post held by several archives is attributed to whichever one got there first, and the bars do not double-count overlap. Reads post_stats when it is populated, which is a few hundred rows; without it every cell is counted from the posts heap and needs the query indexes to finish in reasonable time. Writes a PNG (via resvg) into artifacts/.`,
  },
});

const values = await run(program, {
  contexts: [envContext],
  help: 'both',
});

let conn: string;
try {
  conn = connectionString(values);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const db = openReadOnly(conn);

type Row = {
  board: string;
  thread_no: number;
  post_no: number;
  is_op: boolean;
  ts_utc: number | null;
  name: string | null;
  tripcode: string | null;
  subject: string | null;
  body_text: string | null;
};

const where: string = [
  "posts.search_vector @@ to_tsquery('simple', $1)",
  'posts.board = $2',
  'posts.site = $3',
].join(' AND ');

const { rows } = await db.query<Row>(
  `SELECT * FROM posts WHERE ${where} ORDER BY posts.ts_utc, posts.post_no`,
  [values.phrase, values.board, values.site]
);

const { years, noDate } = rows.reduce<{
  years: Record<string, Row[]>;
  noDate: Row[];
}>(
  (grouped, row) => {
    if (row.ts_utc === null) {
      grouped.noDate.push(row);
      return grouped;
    }
    const year = new Date(row.ts_utc * 1000).getUTCFullYear().toString();
    if (grouped.years[year] === undefined) {
      return {
        years: { ...grouped.years, [year]: [row] },
        noDate: grouped.noDate,
      };
    }
    grouped.years[year].push(row);
    return grouped;
  },
  { years: {}, noDate: [] }
);

const buckets = Object.fromEntries(
  (await bucketsFromStats({ site: '4chan', board: 'g' })).map((bucket) => [
    bucket.year,
    bucket.posts,
  ])
);
console.log('Closing DB...');
await db.end();

const searchTermPercentages = Object.fromEntries(
  Object.entries(years).map(([year, rows]) => {
    return [year, rows.length / buckets[year]];
  })
);
console.log(
  Object.entries(searchTermPercentages).map((year) => {
    return [year[0], (year[1] * 100000).toFixed(2)];
  })
);

const chart = echarts.init(null, null, {
  renderer: 'svg',
  ssr: true,
  height: 600,
  width: 800,
});
chart.setOption({
  title: {
    text: `Usage of ${values.phrase} on /${values.board}/`,
  },
  xAxis: {
    data: Object.keys(searchTermPercentages),
  },
  yAxis: {
    name: 'Post count (per 100,000 posts)',
  },
  series: [
    {
      data: Object.values(searchTermPercentages).map((percentage) => {
        return (percentage * 100000).toFixed(2);
      }),
      type: 'line',
      stack: 'x',
    },
  ],
});

const svg = chart.renderToSVGString();
chart.dispose();
const outDir = join(PROJECT_ROOT, 'artifacts');
mkdirSync(outDir, { recursive: true });

const base = values.out
  ? resolve(PROJECT_ROOT, svg)
  : join(
      outDir,
      `${sanitize(values.phrase).trim().replaceAll(/ +/g, '-')}-term-count`
    );
const svgPath = `${base}.svg`;
writeFileSync(svgPath, svg);

console.log('No date: ' + noDate);

console.log('DONE');
