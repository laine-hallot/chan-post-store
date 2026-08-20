import type { BoardTotals } from './ingest.ts';

import { printTable } from './table.ts';

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
 * Counts are therefore ROWS PRESENT IN THE FILES, deduplicated by nothing.
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
  const headers = [
    ...(multiSite ? ['site'] : []),
    'board',
    'posts',
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
