import type {
  Manifest,
  SourceInfo,
} from '@chan-post-store/cli/src/manifest.ts';
import type { Runner } from '@chan-post-store/cli/src/utils/exec/runner.ts';

import type { ScanResult } from './histogram.ts';
import type { ScanConfig } from './scan.ts';

import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { multiple, optional, withDefault } from '@optique/core/modifiers';
import { option } from '@optique/core/primitives';
import { defineProgram } from '@optique/core/program';
import { integer, string } from '@optique/core/valueparser';
import { run } from '@optique/run';
import * as echarts from 'echarts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sanitize from 'sanitize-filename';

import {
  PROJECT_ROOT,
  ensureNodeRuntime,
  makeRunner,
  manifestPath,
  readManifest,
  readSourceInfo,
  runnerOptions,
  shQuote,
} from '@chan-post-store/cli';

import { COLORS } from '../colors.ts';

/**
 * Post number against post date for one board, from one or more sources'
 * STAGED FILES, each source in its own colour.
 *
 * Post numbers on a board are allocated in order, so on a clean capture this
 * is a monotone curve whose slope is the board's posting rate. What makes it
 * worth looking at is where it isn't: a vertical jump is a gap in the
 * capture, a flat run is a stretch of post numbers the archive never saw, and
 * a point off the curve is a timestamp that was parsed wrong (a timezone
 * slip, a year read out of a filename). With several sources on one chart,
 * where one archive's gap is another's coverage -- and whether two archives
 * agree about when a post was made -- is visible at a glance.
 *
 * Reads each source's `out*` tree, not the store. The store keeps one row per
 * post and attributes it to whichever archive got there first, so it cannot
 * show what a given source holds -- the same reason `survey` exists.
 *
 * The reading happens where the archives are. `scan.ts` is bundled and run
 * on the archive host exactly as a prepare script is, and only a few
 * thousand buckets per source come back; walking a board's files over the
 * mount is both slow and the thing that takes the NAS down.
 *
 * A board can be tens of millions of posts, so each bucket is drawn as two
 * points, its earliest and latest timestamp. On a clean capture they sit on
 * top of each other; where they part, the bucket holds a post whose date
 * disagrees with its neighbours.
 */

const SCAN_BUNDLE = fileURLToPath(
  new URL('../../dist/post-dates-scan.mjs', import.meta.url)
);

const program = defineProgram({
  parser: merge(
    object({
      sources: multiple(
        option('--source', string(), {
          description: message`Source id, as named under sources/. Repeatable: each source is scanned separately and drawn in its own colour.`,
        }),
        { min: 1 }
      ),
      board: option('--board', string(), {
        description: message`Board slug, without slashes.`,
      }),
      buckets: withDefault(
        option('--buckets', integer({ min: 1 }), {
          description: message`Roughly how many post-number buckets to draw per source; each has between this and twice this many.`,
        }),
        1000
      ),
      out: optional(
        option('--out', string(), {
          description: message`Output path without extension, resolved against the repo root. Defaults to artifacts/post-dates-<board>-<source>[+<source>...].`,
        })
      ),
    }),
    runnerOptions
  ),
  metadata: {
    name: 'post-dates.ts',
    brief: message`Chart post number against post date for one board, across one or more sources.`,
    description: message`Reads each source's staged files with the ingest readers, on the machine holding the archives, and buckets the board's posts by post number. Each bucket is drawn as its earliest and latest timestamp, so gaps in a capture and misparsed dates both show up as departures from one smooth curve. Needs no database. Run \`npm run build:sources\` first: it bundles the scan along with the prepare scripts. Writes an SVG into artifacts/.`,
  },
});

const values = await run(program, { help: 'both' });

// The annotation is load-bearing: a call only narrows the code after it when
// the callee is declared with an explicit `never` type.
const fail: (msg: string) => never = (msg) => {
  console.error(msg);
  process.exit(1);
};

if (!existsSync(SCAN_BUNDLE)) {
  fail(`${SCAN_BUNDLE} does not exist\n  run: npm run build:sources`);
}

const sources = [...new Set(values.sources)];
// Never cycle the palette -- see colors.ts. Checked before any scanning, so
// an over-long list costs nothing rather than an hour of reading first.
if (sources.length > COLORS.length) {
  fail(
    `${sources.length} sources but only ${COLORS.length} colours; chart a subset`
  );
}

/**
 * The adapters the scan can run. Stated positively rather than by excluding
 * the ones it can't, so a new adapter is refused until scan.ts learns it
 * instead of reaching the scan's catch-all branch.
 */
const isReadable = (a: string): a is ScanConfig['adapter'] =>
  a === 'sql' || a === 'json' || a === 'html';

/** Everything a scan needs from one source's manifest. */
interface Plan {
  source: string;
  manifest: Manifest;
  adapter: ScanConfig['adapter'];
  info: SourceInfo;
  /** The staged tree, relative to the dataset dir. */
  stagedPath: string;
}

const planScan = (source: string): Plan => {
  const file = manifestPath(source, PROJECT_ROOT);
  const manifestR = readManifest(file, PROJECT_ROOT);
  if (manifestR.isErr) {
    fail(manifestR.error.message);
  }
  const manifest = manifestR.unwrap();
  const { adapter } = manifest;
  if (!isReadable(adapter)) {
    fail(`${source}: post-dates cannot read the ${adapter} adapter`);
  }
  const info = readSourceInfo(file).unwrap();
  return {
    source,
    manifest,
    adapter,
    info,
    // ingest.path is project-root relative, but the scan runs with the
    // dataset dir as cwd, where the project root may not exist at all.
    stagedPath: relative(resolve(PROJECT_ROOT, info.dir), manifest.path),
  };
};

// Every manifest is read before anything runs, so a typo in the third
// --source fails in a second rather than after the first two have scanned.
const plans = sources.map(planScan);

const scanOne = async (runner: Runner, plan: Plan): Promise<ScanResult> => {
  const { info } = plan;
  const dir = runner.path(
    runner.rootIsDatasets ? info.dirFromDatasets : info.dir
  );
  // Same layout as prepare: the runtime is shared, beside the datasets.
  const storageRoot = runner.rootIsDatasets
    ? runner.path('.')
    : join(PROJECT_ROOT, info.dir, '..');
  const node = await ensureNodeRuntime(runner, storageRoot, PROJECT_ROOT);
  if (node.isErr) {
    throw node.error;
  }

  const script = `${dir}/.post-dates-scan.mjs`;
  const resultFile = `.post-dates-${sanitize(values.board)}.json`;
  const w = await runner.writeFile(script, readFileSync(SCAN_BUNDLE));
  if (w.isErr) {
    throw w.error;
  }

  const cfg: ScanConfig = {
    source: plan.source,
    adapter: plan.adapter,
    path: plan.stagedPath,
    site: plan.manifest.site,
    board: values.board,
    excludeBoards: plan.manifest.excludeBoards,
    buckets: values.buckets,
    out: resultFile,
  };
  console.log(
    `scanning ${plan.source} /${values.board}/ in ${dir} (${runner.where})`
  );
  const t0 = Date.now();
  const r = await runner.exec(
    `${shQuote(node.unwrap())} ${shQuote(script)} ${shQuote(JSON.stringify(cfg))}`,
    { cwd: dir, inherit: true }
  );
  await runner.exec(`rm -f ${shQuote(script)}`, { cwd: dir });
  if (r.code !== 0) {
    throw new Error(`${plan.source}: scan exited ${r.code}`);
  }
  const read = await runner.readFile(`${dir}/${resultFile}`);
  await runner.exec(`rm -f ${shQuote(resultFile)}`, { cwd: dir });
  if (read.isErr) {
    throw read.error;
  }
  console.log(`scanned in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
  return JSON.parse(read.unwrap().toString('utf8')) as ScanResult;
};

const runnerR = await makeRunner({
  projectRoot: PROJECT_ROOT,
  host: values.remote,
  forceLocal: values.local,
  key: values.key,
});
if (runnerR.isErr) {
  fail(runnerR.error.message);
}
const runner = runnerR.unwrap();

// One after another, not in parallel: every scan is reading the same array,
// and two concurrent sequential reads over it are slower than one each.
const results: ScanResult[] = [];
try {
  for (const plan of plans) {
    results.push(await scanOne(runner, plan));
  }
} catch (e) {
  await runner.close();
  fail((e as Error).message);
}
await runner.close();

const fmt = (n: number): string => n.toLocaleString('en-US');

// A source without the board is reported and left off, rather than failing
// the run: with several sources that is an answer, not an error. Only when
// NONE hold it is there nothing to draw.
const charted = results.filter((r, i) => {
  if (r.buckets.length > 0) {
    return true;
  }
  console.warn(
    `${r.source} holds no posts for /${values.board}/ in ${plans[i]!.manifest.path}` +
      ` (check the board slug, and that it is not in ingest.exclude-boards)`
  );
  return false;
});
if (charted.length === 0) {
  fail(`no source holds posts for /${values.board}/`);
}

const undated = charted.reduce(
  (n, r) => n + r.buckets.reduce((m, b) => m + b.posts - b.dated, 0),
  0
);
const widths = [...new Set(charted.map((r) => r.width))];
const subtitle =
  `Each point is a bucket's earliest or latest post, in buckets of ` +
  `${widths.map(fmt).join(' / ')} post numbers.` +
  (undated > 0 ? ` ${fmt(undated)} undated posts are not shown.` : '');

/**
 * One source's points, earliest and latest together. A scatter rather than a
 * line: a sparse capture -- a crawl of a few hundred threads spread across
 * years of post numbers -- is almost all isolated buckets, which a line with
 * no symbols draws as nothing at all. Points also show a capture gap as a
 * gap, where a line would draw straight across it and make it read as steady
 * posting. Both ends share the source's colour because on a clean capture
 * they coincide, and an outlier is visible as a point off the curve without
 * a second legend entry saying which end it was.
 */
const points = (r: ScanResult): [number, number][] =>
  r.buckets.flatMap((b) =>
    [b.earliest, b.latest].flatMap((t) =>
      t === null ? [] : [[b.firstNo, t * 1000] as [number, number]]
    )
  );

const chart = echarts.init(null, null, {
  renderer: 'svg',
  ssr: true,
  height: 600,
  width: 1000,
});
chart.setOption({
  backgroundColor: '#ffffff',
  animation: false,
  title: {
    text: `Post number vs date on /${values.board}/`,
    subtext: subtitle,
    left: 'center',
  },
  legend: { bottom: 0 },
  grid: { top: 80, left: 90, right: 40, bottom: 70 },
  xAxis: {
    type: 'value',
    name: 'Post number',
    nameLocation: 'middle',
    nameGap: 30,
    min: 'dataMin',
    max: 'dataMax',
  },
  yAxis: {
    type: 'time',
    name: 'Posted (UTC)',
    min: 'dataMin',
    max: 'dataMax',
  },
  // Colours follow --source order, not which sources turned out to hold the
  // board, so a source keeps its colour when a sibling is dropped.
  series: charted.map((r) => {
    const posts = r.buckets.reduce((n, b) => n + b.posts, 0);
    return {
      name: `${r.source} (${fmt(posts)} posts)`,
      type: 'scatter',
      symbolSize: 3,
      itemStyle: { color: COLORS[sources.indexOf(r.source)] },
      data: points(r),
    };
  }),
});

const svg = chart.renderToSVGString();
chart.dispose();

const outDir = join(PROJECT_ROOT, 'artifacts');
mkdirSync(outDir, { recursive: true });
const base = values.out
  ? resolve(PROJECT_ROOT, values.out)
  : join(outDir, sanitize(`post-dates-${values.board}-${sources.join('+')}`));
const svgPath = `${base}.svg`;
writeFileSync(svgPath, svg);
console.log(`wrote ${svgPath}`);
