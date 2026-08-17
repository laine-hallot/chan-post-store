import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { optional, withDefault } from '@optique/core/modifiers';
import { flag, option } from '@optique/core/primitives';
import { defineProgram } from '@optique/core/program';
import { string } from '@optique/core/valueparser';
import { run } from '@optique/run';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  connectionString,
  dbOptions,
  envContext,
} from '@chan-post-store/cli/env';
import { PROJECT_ROOT } from '@chan-post-store/cli/paths';

import { openReadOnly } from '../db.ts';
import {
  bucketsFromStats,
  hasPostStats,
  totalsFromStats,
  hasQueryIndexes,
  postsByYearAndSource,
  postsByYearForBoard,
  totals,
  type Totals,
  type YearSourceBucket,
  type PostBuckets,
} from '../stats-table-query.ts';
import { renderChart, type ChartData, type Series } from './svg.ts';

/**
 * Renders "what is actually in the corpus" as a chart: posts per calendar
 * year, split by which archive contributed them.
 *
 * The connection comes from the CLI package's shared `dbOptions`, so this
 * tool and `cli.ts` agree on how the database is addressed rather than each
 * having their own idea. In particular `--db` is now optional here too: with
 * a populated `.env` this runs with no arguments at all. Reusing it also
 * means the URL-encoded-password rule documented in `packages/cli/src/env.ts`
 * is stated once, not twice and eventually only once correctly.
 */

// Tailwind's default palette, non-gray hues only: every 500 in Tailwind's hue
// order, then every 200 in the same order. Converted from the published
// oklch() definitions to sRGB hex because resvg renders the SVG and oklch()
// is not something to depend on there.
//
// The 500s come first because they are the saturated, readable ones; the 200s
// are pastels that only get reached past 17 sources, and on the chart's light
// surface they are low contrast. That is survivable for the same reason the
// previous six-colour set tolerated it: every bar carries its value as a
// label, so identity never rests on hue alone.
//
// This replaced a six-colour set chosen for CVD separation (worst adjacent
// dE 9.1). Thirty-four colours cannot all be mutually distinguishable, under
// CVD or otherwise -- adjacent hues here are deliberately close. The trade is
// deliberate: the corpus outgrew six sources, and a chart that refuses to
// render is worse than one where two of fourteen archives are similar.
//
// Never cycle this list. Reusing a hue would paint two archives identically --
// the bug this whole guard exists for, where three colours across six sources
// made laza-fuuka indistinguishable from warosu-2025 and silently mislabeled a
// 72M-post bar. If the corpus ever exceeds 34 sources, add slots or chart a
// subset; do not wrap around.
const COLORS = [
  '#fb2c36', // red-500
  '#ff6900', // orange-500
  '#fe9a00', // amber-500
  '#f0b100', // yellow-500
  '#7ccf00', // lime-500
  '#00c950', // green-500
  '#00bc7d', // emerald-500
  '#00bba7', // teal-500
  '#00b8db', // cyan-500
  '#00a6f4', // sky-500
  '#2b7fff', // blue-500
  '#615fff', // indigo-500
  '#8e51ff', // violet-500
  '#ad46ff', // purple-500
  '#e12afb', // fuchsia-500
  '#f6339a', // pink-500
  '#ff2056', // rose-500
  '#ffc9c9', // red-200
  '#ffd6a7', // orange-200
  '#fee685', // amber-200
  '#fff085', // yellow-200
  '#d8f999', // lime-200
  '#b9f8cf', // green-200
  '#a4f4cf', // emerald-200
  '#96f7e4', // teal-200
  '#a2f4fd', // cyan-200
  '#b8e6fe', // sky-200
  '#bedbff', // blue-200
  '#c6d2ff', // indigo-200
  '#ddd6ff', // violet-200
  '#e9d4ff', // purple-200
  '#f6cfff', // fuchsia-200
  '#fccee8', // pink-200
  '#ffccd3', // rose-200
];

/**
 * One command, so the grammar is a plain `object()` rather than the `or()` of
 * `command()`s that `packages/cli/src/parsers.ts` builds. `defineProgram`
 * carries the prose that used to sit in a doc comment nobody running the tool
 * would ever see; it reaches `--help` instead.
 */
const program = defineProgram({
  parser: merge(
    object({
      board: optional(
        option('--board', string(), {
          description: message`Chart one board instead of the whole corpus. Changes what the bars mean: the corpus chart splits by archive, a board chart splits by whichever archives supplied that board.`,
        })
      ),
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
      svg: withDefault(
        flag('--svg', {
          description: message`Keep the intermediate SVG next to the PNG. It is deleted by default.`,
        }),
        false
      ),
      perSource: optional(
        flag('--per-source', {
          description: message`Split stats by source`,
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

// Awaited: binding a context makes the parse async, the same way cli.ts uses
// runAsync. Top-level await, so nothing else changes.
const values = await run(program, {
  contexts: [envContext],
  // `--help` and `help`, matching cli.ts.
  help: 'both',
});

// connectionString throws when nothing is configured; its message is the
// useful part, so print that rather than a stack trace.
let conn: string;
try {
  conn = connectionString(values);
} catch (e) {
  console.error((e as Error).message);
  process.exit(1);
}

const db = openReadOnly(conn);

// Never echo the connection string: it carries the password.
console.log('reading the post store ...');
const t0 = Date.now();

// post_stats holds pre-rolled (source, board, year) counts, so when it is
// populated everything is a scan of a few hundred rows — including the
// board+source split, which no index on `posts` can serve.
const cached = await hasPostStats(db);
if (!cached) {
  console.error(
    'note: post_stats is empty, falling back to counting rows directly.\n' +
      '      Populate it once with: node packages/cli/src/cli.ts refresh-stats --db <conn>'
  );
  // Only consulted on the fallback path. These indexes are dropped for bulk
  // loads and rebuilt afterwards, so their absence is a normal state rather
  // than a broken store — but the fallback without them is a sequential scan
  // of a 126GB heap per cell, which is hours, not minutes.
  const idx = await hasQueryIndexes(db);
  const need = values.board ? idx.boardTs : idx.srcTs;
  if (!need) {
    console.error(
      `warning: ${values.board ? 'idx_posts_board_ts' : 'idx_posts_src_ts'} is missing too.\n` +
        '         Every count will scan the whole posts table. Build the indexes first:\n' +
        '           node packages/cli/src/cli.ts indexes build --db <conn>'
    );
  }
}

/**
 * The year/source grid, from post_stats when it is populated and from `posts`
 * otherwise. The board fallback has no source column of its own — it counts
 * one board across every archive — so the board name stands in as the series
 * label, keeping the shape the chart expects.
 */
const readBuckets = async (): Promise<
  PostBuckets | { grouping: 'board'; rows: { year: string; posts: number }[] }
> => {
  if (cached) {
    const filter = {
      ...(values.board ? { site: values.site, board: values.board } : {}),
      ...(values.perSource ? { grouping: 'source' as const } : {}),
    };
    return await bucketsFromStats(db, filter);
  }
  if (values.board) {
    const rows = await postsByYearForBoard(db, values.site, values.board);
    return {
      grouping: 'board',
      rows: rows.map((r) => ({ ...r, source: `/${values.board}/` })),
    };
  }
  return { grouping: 'source', rows: await postsByYearAndSource(db) };
};

/**
 * Corpus totals for the summary line. Null on the board-scoped fallback:
 * corpus-wide totals next to one board's chart would only mislead, and the
 * board's own span is already in the buckets.
 */
const readTotals = async (): Promise<Totals | null> => {
  if (cached) {
    return totalsFromStats(db);
  }
  return values.board ? null : totals(db);
};

const buckets = await readBuckets();
const tot = await readTotals();
await db.end();
console.log(
  `aggregated ${buckets.rows.length} buckets in ${((Date.now() - t0) / 1000).toFixed(1)}s`
);

if (buckets.rows.length === 0) {
  console.error(
    values.board
      ? `no dated posts for /${values.board}/ on ${values.site}`
      : 'no dated posts in the database — nothing to chart'
  );
  process.exit(1);
}

// Fill gaps so a year with no posts still occupies a row; an absent year
// reads as "no coverage", which is the point of the chart.
const years = buckets.rows.map((b) => b.year).sort();
const lo = Number(years[0]);
const hi = Number(years[years.length - 1]);
const allYears: string[] = [];
for (let y = lo; y <= hi; y++) {
  allYears.push(String(y));
}

const collectSourceNames = (rows: YearSourceBucket[]): string[] => {
  // Largest first, so the sources that dominate the chart take the leading slots
  // and the reading order of the legend matches the visual weight of the bars.
  const totalBySource = new Map<string, number>();
  for (const b of rows) {
    totalBySource.set(b.source, (totalBySource.get(b.source) ?? 0) + b.posts);
  }
  const sourceNames = [...totalBySource.keys()].sort(
    (a, z) => (totalBySource.get(z) ?? 0) - (totalBySource.get(a) ?? 0)
  );
  if (sourceNames.length > COLORS.length) {
    // Better to stop than to hand two archives the same colour: the chart's
    // whole job is telling them apart.
    console.error(
      `${sourceNames.length} sources but only ${COLORS.length} validated colors.\n` +
        `Add slots from the reference palette (validating the new set) or chart a subset with --board.`
    );
    process.exit(1);
  }
  return sourceNames;
};

const sourceNames =
  buckets.grouping === 'source' ? collectSourceNames(buckets.rows) : ['Posts'];

const series: Series[] = sourceNames.map((name, i) => ({
  name,
  color: COLORS[i],
}));

const grid = new Map<string, Map<string, number>>();
for (const y of allYears) {
  grid.set(y, new Map());
}
if (buckets.grouping === 'source') {
  for (const b of buckets.rows) {
    grid.get(b.year)?.set(b.source, b.posts);
  }
} else {
  for (const b of buckets.rows) {
    console.log({ [b.year]: b.posts });
    grid.get(b.year)?.set('Posts', b.posts);
  }
}

const yearFormat = (n: number): string => n.toLocaleString('en-US');

// Sum of what is actually charted, so the headline matches the bars.
const charted = buckets.rows.reduce((n, b) => n + b.posts, 0);

let title: string;
let subtitle: string;
if (values.board) {
  const active = buckets.rows
    .filter((b) => b.posts > 0)
    .map((b) => b.year)
    .sort();
  title = `/${values.board}/ — posts by year`;
  subtitle =
    `${yearFormat(charted)} posts, ${active[0]} to ${active[active.length - 1]}` +
    (series.length > 1 ? `, across ${series.length} archives` : '') +
    '. Each post is counted once, attributed to the archive that supplied it.';
} else {
  const span =
    tot!.minTs && tot!.maxTs
      ? `${new Date(tot!.minTs * 1000).toISOString().slice(0, 7)} to ${new Date(tot!.maxTs * 1000).toISOString().slice(0, 7)}`
      : 'unknown span';
  const undated = tot!.posts - charted;
  title =
    buckets.grouping === 'source'
      ? 'Post coverage by year and archive'
      : 'Post coverage by year';
  if (buckets.grouping === 'source') {
    subtitle =
      `${yearFormat(charted)} dated posts across ${series.length} sources, ${span}.` +
      (undated > 0
        ? ` ${yearFormat(undated)} undated posts are not shown.`
        : '') +
      ' Each post is counted once, attributed to the archive that supplied it first.';
  } else {
    subtitle =
      `${yearFormat(charted)} posts dated ${span}.` +
      (undated > 0
        ? ` ${yearFormat(undated)} undated posts are not shown.`
        : '');
  }
}

const data: ChartData = {
  years: allYears,
  series,
  values: grid,
  title,
  subtitle,
};

const svg = renderChart(data);
const outDir = join(PROJECT_ROOT, 'artifacts');
mkdirSync(outDir, { recursive: true });

const base = values.out
  ? resolve(PROJECT_ROOT, values.out)
  : join(
      outDir,
      values.board
        ? `post-coverage-${values.site}-${values.board}`
        : 'post-coverage'
    );
const svgPath = `${base}.svg`;
const pngPath = `${base}.png`;
writeFileSync(svgPath, svg);

// resvg comes from the flake rather than a native npm module, so the
// toolchain stays declarative.
const r = spawnSync('resvg', ['--zoom', '2', svgPath, pngPath], {
  stdio: 'inherit',
});
if (r.error || r.status !== 0) {
  console.error(
    `resvg failed (${r.error?.message ?? `exit ${r.status}`}); SVG written to ${svgPath}`
  );
  process.exit(1);
}
if (!values.svg) {
  // The SVG is an intermediate unless asked for.
  const { unlinkSync } = await import('node:fs');
  unlinkSync(svgPath);
}
console.log(`wrote ${pngPath}`);
