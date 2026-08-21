import type { InferValue } from '@optique/core/parser';

import type { BoardTotals } from '../database/ingest.ts';

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

import { ingestOne } from '../database/ingest.ts';
import { readManifest, manifestPath, ingestInputs } from '../manifest.ts';
import { printTable } from '../table.ts';
import { fail } from '../utils/console.ts';
import { PROJECT_ROOT } from '../utils/paths.ts';

/**
 * Renders what a source's STAGED FILES contain, as opposed to what the store
 * contains.
 *
 * The distinction is the whole point. `list boards` answers from `post_stats`,
 * so it describes posts that survived `ON CONFLICT` -- a board already
 * supplied by an earlier archive shows nothing here even though this source
 * holds it in full. Reading the staged tree instead attributes every row to
 * the source that actually carries it, which is what you need when deciding
 * whether a dump is worth keeping, or which archive to ingest first where two
 * overlap.
 *
 * Counts are therefore ROWS PRESENT IN THE FILES. `--distinct` additionally
 * reports how many distinct post numbers those rows carry.
 *
 * NEITHER NUMBER PREDICTS WHAT AN INGEST WOULD ADD, and the distinct one is
 * the more tempting to misread. Ingest attempts every row -- the UNIQUE
 * constraint is what collapses repeats, not the reader -- so `posts` is the
 * count of insert attempts, and `distinct` is at best an upper bound on what
 * lands. It is only an upper bound because a post already claimed by another
 * archive is rejected too, and nothing here can see the store. Use these to
 * describe what a source HOLDS; use post_stats to ask what it CONTRIBUTED.
 */

/** `YYYY-MM-DD HH:MM` in UTC, assembled from parts rather than sliced out of
 * an ISO string: `toISOString()` expands years outside 1000-9999 to a signed
 * six-digit form, which shifts every field after it. No post should have such
 * a timestamp, but a misparsed one is exactly what this command exists to
 * make visible, and a mangled column would hide it. */
const fmtTs = (ts: number | null): string | null => {
  if (ts == null) {
    return null;
  }
  const d = new Date(ts * 1000);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return (
    `${p(d.getUTCFullYear(), 4)}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    ` ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  );
};

/** Post numbers are identifiers, not quantities, so they are rendered as
 * strings: `printTable` group-separates numbers and would print post
 * 1234567 as "1,234,567". Years and months are strings for the same reason. */
const id = (n: number): string => String(n);

const sum = (ns: number[]): number => ns.reduce((a, b) => a + b, 0);

/** Per-board summary: what boards, what post-number span, what date span. */
export const printBoardTable = (totals: BoardTotals[]): void => {
  const multiSite = new Set(totals.map((t) => t.site)).size > 1;
  const withDistinct = totals.some((t) => t.distinct != null);
  const headers = [
    ...(multiSite ? ['site'] : []),
    'board',
    'posts',
    ...(withDistinct ? ['distinct', 'repeats'] : []),
    'ops',
    'undated',
    'first post',
    'last post',
    'oldest',
    'newest',
  ];
  const body = totals.map((t) => [
    ...(multiSite ? [t.site] : []),
    t.board,
    t.posts,
    ...(withDistinct ? [t.distinct, t.posts - (t.distinct ?? t.posts)] : []),
    t.ops,
    t.nullTs,
    id(t.minPostNo),
    id(t.maxPostNo),
    fmtTs(t.minTs),
    fmtTs(t.maxTs),
  ]);

  // Built by hand rather than through `totalsRow`: its min/max rules compare
  // strings, and post numbers as strings compare lexicographically -- "999"
  // would beat "1000". The spans below are numeric comparisons.
  const dated = totals.filter((t) => t.minTs != null);
  const footer =
    totals.length > 1
      ? [
          ...(multiSite ? ['TOTAL'] : []),
          multiSite ? '' : 'TOTAL',
          sum(totals.map((t) => t.posts)),
          ...(withDistinct
            ? [
                sum(totals.map((t) => t.distinct ?? 0)),
                sum(totals.map((t) => t.posts - (t.distinct ?? t.posts))),
              ]
            : []),
          sum(totals.map((t) => t.ops)),
          sum(totals.map((t) => t.nullTs)),
          id(Math.min(...totals.map((t) => t.minPostNo))),
          id(Math.max(...totals.map((t) => t.maxPostNo))),
          dated.length ? fmtTs(Math.min(...dated.map((t) => t.minTs!))) : null,
          dated.length ? fmtTs(Math.max(...dated.map((t) => t.maxTs!))) : null,
        ]
      : undefined;

  printTable(headers, body, footer);
};

/** Month keys rolled up to calendar years. */
const toYears = (months: Map<string, number>): Map<string, number> => {
  const out = new Map<string, number>();
  for (const [m, n] of months) {
    const y = m.slice(0, 4);
    out.set(y, (out.get(y) ?? 0) + n);
  }
  return out;
};

const bucketsOf = (
  totals: BoardTotals[],
  by: 'year' | 'month'
): Map<string, number> => {
  const merged = new Map<string, number>();
  for (const t of totals) {
    for (const [m, n] of t.months) {
      merged.set(m, (merged.get(m) ?? 0) + n);
    }
  }
  return by === 'year' ? toYears(merged) : merged;
};

/**
 * Posts per calendar bucket, with undated rows called out rather than
 * dropped.
 *
 * A bucket table that silently omits them cannot be reconciled against the
 * post count, and "the years don't add up" is how a timezone or parse bug
 * announces itself. So the footer totals the buckets, and an `(undated)` row
 * carries the rest.
 */
export const printBucketTable = (
  totals: BoardTotals[],
  by: 'year' | 'month',
  label: string
): void => {
  const buckets = bucketsOf(totals, by);
  const undated = sum(totals.map((t) => t.nullTs));
  if (buckets.size === 0 && undated === 0) {
    console.log(`${label}: no posts`);
    return;
  }
  console.log(`\n${label}`);

  const keys = [...buckets.keys()].sort();
  const body: (string | number | null)[][] = keys.map((k) => [
    k,
    buckets.get(k)!,
  ]);
  if (undated > 0) {
    body.push(['(undated)', undated]);
  }
  printTable(
    [by, 'posts'],
    body,
    body.length > 1
      ? ['TOTAL', sum([...buckets.values()]) + undated]
      : undefined
  );
};

/**
 * Describes a source's staged files without touching the database.
 *
 * This runs the ordinary reader for the manifest's adapter -- the same code
 * ingest uses -- with a null pool and count-only set, so the figures are
 * exactly what an ingest of these files would offer the store, not a second
 * implementation that could disagree with it.
 */
export const execSurvey = async (o: SurveyArgs): Promise<void> => {
  const resolved = readManifest(
    manifestPath(o.source, PROJECT_ROOT),
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
    `surveying ${manifest.name} [${manifest.adapter}] from ${manifest.path}\n`
  );
  const { totals } = await ingestOne(
    null,
    manifest,
    0,
    inputs,
    o.board.length ? [...o.board] : undefined,
    true,
    o.distinct
  );
  if (totals.length === 0) {
    console.log('no posts found in the staged files');
    return;
  }

  console.log();
  printBoardTable(totals);
  printBucketTable(totals, o.by, `posts by ${o.by}, all boards`);

  if (o['per-board']) {
    for (const t of totals) {
      printBucketTable([t], o.by, `posts by ${o.by} — /${t.board}/`);
    }
  }
};

export const surveyCmd = command(
  'survey',
  object({
    action: constant('survey' as const),
    source: argument(string({ metavar: 'SOURCE' })),
    board: multiple(
      option('--board', string(), {
        description: message`Report only these boards. Repeatable.`,
      })
    ),
    by: withDefault(
      option('--by', choice(['year', 'month'] as const), {
        description: message`Bucket size for the post-count table.`,
      }),
      'year' as const
    ),
    distinct: withDefault(
      flag('--distinct', {
        description: message`Also count DISTINCT post numbers per board, and how many rows are repeats WITHIN THIS SOURCE. Costs about 4 bytes per row held in memory. Worth it where staging concatenates snapshots of one database -- rbt-asia reads 299M rows for ~76M posts, because its four daily_4klaani dumps each carry the same boards. This is NOT a prediction of what an ingest would add: ingest attempts every row and lets the UNIQUE constraint collapse repeats, and posts another archive already claimed are rejected as well, which nothing here can see.`,
      }),
      false
    ),
    'per-board': withDefault(
      flag('--per-board', {
        description: message`Also print a bucket table for each board, not just the aggregate.`,
      }),
      false
    ),
  }),
  {
    description: message`Describe a source's STAGED FILES: which boards it holds, each board's post-number and date span, and posts per year or month. Reads out/ directly and needs no database -- so unlike \`list boards\`, which answers from post_stats and therefore shows only what survived ON CONFLICT, this attributes every row to the source that actually carries it. Counts are rows present in the files; --distinct adds how many distinct post numbers they carry. Neither predicts what an ingest would store -- see --distinct.`,
  }
);

export type SurveyArgs = InferValue<typeof surveyCmd>;
