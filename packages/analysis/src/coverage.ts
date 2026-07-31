import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  bucketsFromStats,
  hasPostStats,
  totalsFromStats,
  hasSourceTimeIndex,
  openReadOnly,
  postsByYearAndSource,
  postsByYearForBoard,
  totals,
} from "./query.ts";
import { renderChart, type ChartData, type Series } from "./svg.ts";

/**
 * Renders "what is actually in the corpus" as a chart: posts per calendar
 * year, split by which archive contributed them.
 *
 * Run: node packages/analysis/src/coverage.ts [--db data/posts.db]
 */

const findProjectRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "sources"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error("could not locate the repo root");
    dir = up;
  }
};

// Categorical slots 1-6 of the reference palette, in fixed order. Validated as
// a set on the light surface: worst adjacent CVD dE 9.1, normal-vision 19.6.
// Aqua, yellow and magenta sit below 3:1 contrast, which the per-bar value
// labels answer (identity never rests on hue alone).
//
// Never cycle this list. Reusing a hue for a 7th source would paint two
// archives identically -- the bug this replaced, where three colors across six
// sources made laza-fuuka indistinguishable from warosu-2025 and silently
// mislabeled a 72M-post bar.
const COLORS = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
];

const root = findProjectRoot();
const { values } = parseArgs({
  options: {
    db: { type: "string" },
    out: { type: "string" },
    svg: { type: "boolean" },
    board: { type: "string" },
    site: { type: "string", default: "4chan" },
  },
});

const dbPath = resolve(root, values.db ?? "data/posts.db");
if (!existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`);
  process.exit(1);
}

const db = openReadOnly(dbPath);

console.log(`reading ${dbPath} ...`);
const t0 = Date.now();

// post_stats holds pre-rolled (source, board, year) counts, so when it is
// populated everything is a scan of a few hundred rows — including the
// board+source split, which no index on `posts` can serve.
const cached = hasPostStats(db);
if (!cached) {
  console.error(
    "note: post_stats is empty, falling back to counting rows directly.\n" +
      "      Populate it once with: node packages/cli/src/cli.ts refresh-stats --db <file>",
  );
  // Only relevant on the fallback path; with the summary table this index
  // is not consulted at all.
  if (!hasSourceTimeIndex(db)) {
    console.error(
      "warning: idx_posts_src_ts is missing too — the fallback will scan the\n" +
        "         whole posts table and may take several minutes.",
    );
  }
}

const buckets = cached
  ? bucketsFromStats(db, values.board ? { site: values.site, board: values.board } : undefined)
  : values.board
    ? postsByYearForBoard(db, values.site, values.board).map((r) => ({
        ...r,
        source: `/${values.board}/`,
      }))
    : postsByYearAndSource(db);
const tot = cached ? totalsFromStats(db) : values.board ? null : totals(db);
db.close();
console.log(`aggregated ${buckets.length} buckets in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

if (buckets.length === 0) {
  console.error(
    values.board
      ? `no dated posts for /${values.board}/ on ${values.site}`
      : "no dated posts in the database — nothing to chart",
  );
  process.exit(1);
}

// Fill gaps so a year with no posts still occupies a row; an absent year
// reads as "no coverage", which is the point of the chart.
const years = buckets.map((b) => b.year).sort();
const lo = Number(years[0]);
const hi = Number(years[years.length - 1]);
const allYears: string[] = [];
for (let y = lo; y <= hi; y++) allYears.push(String(y));

// Largest first, so the sources that dominate the chart take the leading slots
// and the reading order of the legend matches the visual weight of the bars.
const totalBySource = new Map<string, number>();
for (const b of buckets) {
  totalBySource.set(b.source, (totalBySource.get(b.source) ?? 0) + b.posts);
}
const sourceNames = [...totalBySource.keys()].sort(
  (a, z) => (totalBySource.get(z) ?? 0) - (totalBySource.get(a) ?? 0),
);
if (sourceNames.length > COLORS.length) {
  // Better to stop than to hand two archives the same colour: the chart's
  // whole job is telling them apart.
  console.error(
    `${sourceNames.length} sources but only ${COLORS.length} validated colors.\n` +
      `Add slots from the reference palette (validating the new set) or chart a subset with --board.`,
  );
  process.exit(1);
}
const series: Series[] = sourceNames.map((name, i) => ({
  name,
  color: COLORS[i],
}));

const grid = new Map<string, Map<string, number>>();
for (const y of allYears) grid.set(y, new Map());
for (const b of buckets) grid.get(b.year)?.set(b.source, b.posts);

const fmt = (n: number): string => n.toLocaleString("en-US");

// Sum of what is actually charted, so the headline matches the bars.
const charted = buckets.reduce((n, b) => n + b.posts, 0);

let title: string;
let subtitle: string;
if (values.board) {
  const active = buckets.filter((b) => b.posts > 0).map((b) => b.year).sort();
  title = `/${values.board}/ — posts by year`;
  subtitle =
    `${fmt(charted)} posts, ${active[0]} to ${active[active.length - 1]}` +
    (series.length > 1 ? `, across ${series.length} archives` : "") +
    ". Each post is counted once, attributed to the archive that supplied it.";
} else {
  const span =
    tot!.minTs && tot!.maxTs
      ? `${new Date(tot!.minTs * 1000).toISOString().slice(0, 7)} to ${new Date(tot!.maxTs * 1000).toISOString().slice(0, 7)}`
      : "unknown span";
  const undated = tot!.posts - charted;
  title = "Post coverage by year and archive";
  subtitle =
    `${fmt(charted)} dated posts across ${series.length} sources, ${span}.` +
    (undated > 0 ? ` ${fmt(undated)} undated posts are not shown.` : "") +
    " Each post is counted once, attributed to the archive that supplied it first.";
}

const data: ChartData = { years: allYears, series, values: grid, title, subtitle };

const svg = renderChart(data);
const outDir = join(root, "artifacts");
mkdirSync(outDir, { recursive: true });

const base = values.out
  ? resolve(root, values.out)
  : join(outDir, values.board ? `post-coverage-${values.site}-${values.board}` : "post-coverage");
const svgPath = `${base}.svg`;
const pngPath = `${base}.png`;
writeFileSync(svgPath, svg);

// resvg comes from the flake rather than a native npm module, so the
// toolchain stays declarative.
const r = spawnSync("resvg", ["--zoom", "2", svgPath, pngPath], { stdio: "inherit" });
if (r.error || r.status !== 0) {
  console.error(`resvg failed (${r.error?.message ?? `exit ${r.status}`}); SVG written to ${svgPath}`);
  process.exit(1);
}
if (!values.svg) {
  // The SVG is an intermediate unless asked for.
  const { unlinkSync } = await import("node:fs");
  unlinkSync(svgPath);
}
console.log(`wrote ${pngPath}`);
