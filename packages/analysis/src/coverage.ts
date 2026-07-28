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

function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "sources"))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error("could not locate the repo root");
    dir = up;
  }
}

// Categorical slots 1-3 of the reference palette, in fixed order. Validated
// for CVD and normal-vision separation on the light surface; slot 3 (aqua)
// warns on contrast, which the per-row value labels answer.
const COLORS = ["#2a78d6", "#eb6834", "#1baf7a"];

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

const sourceNames = [...new Set(buckets.map((b) => b.source))].sort();
const series: Series[] = sourceNames.map((name, i) => ({
  name,
  color: COLORS[i % COLORS.length],
}));

const grid = new Map<string, Map<string, number>>();
for (const y of allYears) grid.set(y, new Map());
for (const b of buckets) grid.get(b.year)?.set(b.source, b.posts);

const fmt = (n: number) => n.toLocaleString("en-US");

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
    ". Archives overlap, so a post held by more than one is counted once per archive.";
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
    " Archives overlap, so a post may appear more than once.";
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
