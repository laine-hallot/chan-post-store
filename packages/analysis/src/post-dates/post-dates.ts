import type {
  Manifest,
  SourceInfo,
} from '@chan-post-store/cli/src/manifest.ts';
import type { Runner } from '@chan-post-store/cli/src/utils/exec/runner.ts';

import type { ScanConfig } from './scan.ts';

import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { multiple, optional, withDefault } from '@optique/core/modifiers';
import { flag, option } from '@optique/core/primitives';
import { defineProgram } from '@optique/core/program';
import { float, integer, string } from '@optique/core/valueparser';
import { run } from '@optique/run';
import * as echarts from 'echarts';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sanitize from 'sanitize-filename';

import {
  PROJECT_ROOT,
  ensureNodeRuntime,
  makeRunner,
  manifestPath,
  parseBound,
  readManifest,
  readSourceInfo,
  runnerOptions,
  shQuote,
} from '@chan-post-store/cli';

import { assignColours, COLORS } from '../colors.ts';
import { coarsenTo, SCAN_FORMAT, type ScanResult } from './histogram.ts';

/**
 * Post number against post date for one board, from one or more sources'
 * STAGED FILES, each source in its own colour. Date runs along x, post
 * number up y.
 *
 * Post numbers on a board are allocated in order, so on a clean capture this
 * is a monotone curve whose slope is the board's posting rate. What makes it
 * worth looking at is where it isn't: a horizontal break is a stretch of time
 * the archive never captured, a vertical jump is a run of post numbers it
 * never saw, and a point off the curve is a timestamp that was parsed wrong
 * (a timezone slip, a year read out of a filename). Where a source stops is
 * the date its capture ends, readable straight off the axis. With several sources on one chart,
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
 * A board can be tens of millions of posts, so posts are bucketed by time and
 * each bucket is drawn as two points, its lowest and highest post number. On
 * a clean capture they sit close together; where they part, the bucket holds
 * a post whose number disagrees with its date.
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
          description: message`Roughly how many time buckets to draw per source; each has between this and twice this many.`,
        }),
        1000
      ),
      'reuse-scans': withDefault(
        flag('--reuse-scans', {
          description: message`Chart the scans cached by an earlier run instead of scanning again, for any source that has one. The cache is keyed by source, board and --buckets, and is NOT invalidated when a source is re-staged.`,
        }),
        false
      ),
      start: optional(
        option('--start', string(), {
          description: message`Chart only posts from this date on: YYYY, YYYY-MM or YYYY-MM-DD (UTC). Applied in the scan, so the automatic bucket width fits the range rather than the whole board.`,
        })
      ),
      end: optional(
        option('--end', string(), {
          description: message`Chart only posts up to and including this date. --end 2014-03 means through the end of March 2014.`,
        })
      ),
      'bucket-days': optional(
        option('--bucket-days', float({ min: 1 / 86_400 }), {
          description: message`Bucket width in days, e.g. 0.5 or 7. Every source is scanned at exactly this width rather than one chosen to fit --buckets, so a width not cached yet means scanning again.`,
        })
      ),
      'point-size': withDefault(
        option('--point-size', float({ min: 0.5 }), {
          description: message`Diameter of a point, in pixels.`,
        }),
        3
      ),
      opacity: withDefault(
        option('--opacity', float({ min: 0, max: 1 }), {
          description: message`Point opacity.`,
        }),
        0.6
      ),
      'ring-width': withDefault(
        option('--ring-width', float({ min: 0 }), {
          description: message`Pixels a point grows by, all the way round, for each later source drawn over it -- so a source hidden under another still shows as a ring, one ring per covering source. 0 disables it.`,
        }),
        1.5
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
    description: message`Reads each source's staged files with the ingest readers, on the machine holding the archives, and buckets the board's posts by time. Each bucket is drawn as its lowest and highest post number, so gaps in a capture and misparsed dates both show up as departures from one smooth curve. Needs no database. Run \`npm run build:sources\` first: it bundles the scan along with the prepare scripts. Writes an SVG into artifacts/.`,
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

// parseBound exits with its own message on a malformed date.
const start = values.start ? parseBound(values.start, false) : undefined;
const end = values.end ? parseBound(values.end, true) : undefined;
if (start !== undefined && end !== undefined && start >= end) {
  fail(`--start ${values.start} is not before --end ${values.end}`);
}
const ranged = start !== undefined || end !== undefined;
const fixedWidth =
  values['bucket-days'] === undefined
    ? undefined
    : values['bucket-days'] * 86_400;

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
    width: fixedWidth,
    start,
    end,
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

/**
 * Scans cached locally, so the chart can be iterated on without re-reading
 * gigabytes on the archive host each time. Written on every scan, read only
 * under --reuse-scans: a re-staged source changes what a scan would find, and
 * nothing here can tell.
 */
const CACHE_DIR = join(PROJECT_ROOT, '.cache', 'post-dates');
const cachePath = (source: string): string =>
  join(
    CACHE_DIR,
    sanitize(
      [
        source,
        values.board,
        fixedWidth === undefined ? `n${values.buckets}` : `w${fixedWidth}`,
        start === undefined ? '' : `from${start}`,
        end === undefined ? '' : `to${end}`,
        `v${SCAN_FORMAT}`,
      ]
        .filter(Boolean)
        .join('-') + '.json'
    )
  );

const cached = (source: string): ScanResult | undefined => {
  if (!values['reuse-scans'] || !existsSync(cachePath(source))) {
    return undefined;
  }
  return JSON.parse(readFileSync(cachePath(source), 'utf8')) as ScanResult;
};

const slots: (ScanResult | undefined)[] = plans.map((p) => cached(p.source));
const toScan = plans.filter((_, i) => slots[i] === undefined);
for (const [i, p] of plans.entries()) {
  if (slots[i] !== undefined) {
    console.log(`reusing the cached scan of ${p.source}`);
  }
}

// Connected only when something needs scanning, so a fully cached run works
// with the archive host down.
if (toScan.length > 0) {
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

  // One after another, not in parallel: every scan is reading the same
  // array, and two concurrent sequential reads over it are slower than one
  // each.
  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    for (const plan of toScan) {
      const r = await scanOne(runner, plan);
      writeFileSync(cachePath(plan.source), JSON.stringify(r));
      slots[plans.indexOf(plan)] = r;
    }
  } catch (e) {
    await runner.close();
    fail((e as Error).message);
  }
  await runner.close();
}
const results = slots.filter((r): r is ScanResult => r !== undefined);

const fmt = (n: number): string => n.toLocaleString('en-US');

// A source without the board is reported and left off, rather than failing
// the run: with several sources that is an answer, not an error. Only when
// NONE hold it is there nothing to draw.
const found = results.filter((r, i) => {
  if (r.buckets.length > 0) {
    return true;
  }
  console.warn(
    ranged
      ? `${r.source} holds no posts for /${values.board}/ in the date range`
      : `${r.source} holds no posts for /${values.board}/ in ${plans[i]!.manifest.path}` +
          ` (check the board slug, and that it is not in ingest.exclude-boards)`
  );
  return false;
});
if (found.length === 0) {
  fail(
    `no source holds posts for /${values.board}/${ranged ? ' in the date range' : ''}`
  );
}

/**
 * Every source at one bucket width: --bucket-days when given, which every
 * scan already used, and otherwise the coarsest any of them needed.
 *
 * Each scan picks its own width to fit its bucket count, so a sparse source
 * ends up with FINER buckets than a dense one and draws about as solid a
 * curve. At a shared width a point means the same span of time for every
 * source, and a source that is thinner somewhere shows it as gaps where the
 * others are continuous.
 */
const width = Math.max(...found.map((r) => r.width));
const charted = found.map((r) => coarsenTo(r, width));

const undated = charted.reduce((n, r) => n + r.undated, 0);

/** A bucket width in the largest unit that keeps it above one. */
const duration = (secs: number): string => {
  const units: [string, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [name, size] of units) {
    if (secs >= size) {
      const n = Math.round((secs / size) * 10) / 10;
      return `${n} ${name}${n === 1 ? '' : 's'}`;
    }
  }
  return `${secs} seconds`;
};

/** Where undated posts went, which depends on whether a range was asked for. */
const undatedNote = (): string => {
  if (undated === 0) {
    return '';
  }
  return ranged
    ? ` ${fmt(undated)} UNDATED posts fall outside any date range and are not shown.`
    : ` ${fmt(undated)} UNDATED posts are drawn at 1970-01-01.`;
};

const day = (ts: number): string =>
  new Date(ts * 1000).toISOString().slice(0, 10);
const rangeNote = ranged
  ? ` From ${start === undefined ? 'the first post' : day(start)}` +
    ` to ${end === undefined ? 'the last' : day(end - 1)}.`
  : '';

const subtitle =
  `Each point is a bucket's lowest or highest post number, in buckets of ` +
  `${duration(width)}.` +
  rangeNote +
  undatedNote();

// A fine --bucket-days over a long range is legal and slow to draw: every
// bucket is two points, and SVG has no way to thin them.
const totalPoints = charted.reduce((n, r) => n + 2 * r.buckets.length, 0);
if (totalPoints > 100_000) {
  console.warn(
    `drawing ${fmt(totalPoints)} points; a coarser --bucket-days or a narrower range will render faster`
  );
}

/**
 * One source's points, lowest and highest together, each at the bucket's
 * first timestamp. A scatter rather than a line: a sparse capture -- a crawl
 * of a few hundred threads spread across years -- is almost all isolated
 * buckets, which a line with no symbols draws as nothing at all. Points also
 * show a capture gap as a gap, where a line would draw straight across it
 * and make it read as steady posting. Both ends share the source's colour
 * because on a clean capture they nearly coincide, and an outlier is visible
 * as a point off the curve without a second legend entry saying which end it
 * was.
 */
const points = (r: ScanResult): [number, number][] =>
  r.buckets.flatMap((b): [number, number][] => [
    [b.firstTs * 1000, b.lowNo],
    [b.firstTs * 1000, b.highNo],
  ]);

const WIDTH = 1000;
const HEIGHT = 600;
const GRID = { top: 80, left: 90, right: 40, bottom: 50 };

const chart = echarts.init(null, null, {
  renderer: 'svg',
  ssr: true,
  height: HEIGHT,
  width: WIDTH,
});
// By name, so a source is the same colour on every chart it appears in
// unless it clashes with another there -- see assignColours.
const colours = assignColours(charted.map((r) => r.source));
const series = charted.map((r) => ({
  r,
  data: points(r),
  name: `${r.source} (${fmt(r.buckets.reduce((n, b) => n + b.posts, 0))} posts)`,
}));
chart.setOption({
  backgroundColor: '#ffffff',
  animation: false,
  title: {
    text: `Post number vs date on /${values.board}/`,
    subtext: subtitle,
    left: 'center',
  },
  // Placed once the points are laid out -- see placeLegend.
  legend: {
    backgroundColor: 'rgba(255, 255, 255, 0.85)',
  },
  grid: GRID,
  xAxis: {
    type: 'time',
    name: 'Posted (UTC)',
    nameLocation: 'middle',
    nameGap: 30,
    // The range asked for, not just the part of it that has data, so a
    // source missing the start or end of a range shows that as empty space.
    min: start === undefined ? 'dataMin' : start * 1000,
    max: end === undefined ? 'dataMax' : end * 1000,
  },
  yAxis: {
    type: 'value',
    name: 'Post number',
    min: 'dataMin',
    max: 'dataMax',
  },
  series: series.map(({ r, data, name }) => {
    return {
      name,
      type: 'scatter',
      symbolSize: values['point-size'],
      // Drawn in one pass: progressive rendering is for interactive charts,
      // and SSR renders once.
      progressive: 0,
      itemStyle: {
        color: colours.get(r.source)!,
        opacity: values.opacity,
      },
      data,
    };
  }),
});

/**
 * Grows each point by `--ring-width` all round for every LATER source that
 * draws a point on top of it, so a source that is covered still shows as a
 * ring around the one covering it -- while one that simply has no data there
 * shows nothing.
 *
 * Additive, one fixed-width ring per covering source. It was a multiplier
 * first, and at 1.5x per source a bucket under six others came out 11x its
 * size: a blob, not a stack of rings.
 *
 * Series draw in order, later on top, so only later sources can cover a
 * point. Points of the same source are not compared: a dense capture's
 * neighbouring buckets always touch, and growing them would only thicken the
 * curve. Two points touch when their centres are closer than one diameter,
 * measured in pixels -- which is why this runs after the first setOption,
 * once the axes exist to convert through.
 */
// Every point's position on the canvas, now the axes exist to convert
// through. Both the overlap scaling and the legend placement work in pixels.
// Placing the legend never moves the plot, so these stay valid.
const pixels = series.map(({ data }, i) =>
  data.map((d) => chart.convertToPixel({ seriesIndex: i }, d) as number[])
);

const overlapSizes = (): number[][] => {
  const size = values['point-size'];
  // Each series' points hashed into diameter-sized cells, so a lookup is
  // the 3x3 block around a point rather than every point of the series.
  const cellOf = (p: number[]): string =>
    `${Math.floor(p[0]! / size)},${Math.floor(p[1]! / size)}`;
  const grids = pixels.map((ps) => {
    const g = new Map<string, number[][]>();
    for (const p of ps) {
      const k = cellOf(p);
      g.set(k, [...(g.get(k) ?? []), p]);
    }
    return g;
  });
  const touches = (p: number[], g: Map<string, number[][]>): boolean => {
    const cx = Math.floor(p[0]! / size);
    const cy = Math.floor(p[1]! / size);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const q of g.get(`${cx + dx},${cy + dy}`) ?? []) {
          if (Math.hypot(p[0]! - q[0]!, p[1]! - q[1]!) < size) {
            return true;
          }
        }
      }
    }
    return false;
  };
  return pixels.map((ps, i) =>
    ps.map((p) => {
      const covers = grids.slice(i + 1).filter((g) => touches(p, g)).length;
      return size + 2 * values['ring-width'] * covers;
    })
  );
};

/** Rough rendered width of a legend entry: icon, gap, label. Errs large --
 * echarts does not report a legend's size before rendering. */
const entryWidth = (name: string): number => 35 + 6.5 * name.length;
const ENTRY_HEIGHT = 24;

/**
 * Top left inside the plot when it is clear, and otherwise below the chart.
 *
 * Post numbers rise with time, so on a chart whose axes end where its data
 * does, the top-left corner is empty -- but a long legend reaches down into
 * the curve, and a --start or --end past where a source's data stops can
 * run the curve through the corner. So it is measured, not assumed: any
 * point under the box sends the legend below. Undated posts at 1970 sit ON
 * the y axis, and the box starts to the right of it.
 *
 * Below, the canvas grows to fit it and the plot keeps its size, so the
 * point positions measured for the overlap rings stay valid.
 */
const placeLegend = (): void => {
  const names = series.map(({ name }) => name);
  const w = Math.max(...names.map(entryWidth));
  const h = 10 + ENTRY_HEIGHT * series.length;
  const left = GRID.left + 20;
  const top = GRID.top + 15;
  const covered = pixels
    .flat()
    .some(
      ([x, y]) => x! >= left && x! <= left + w && y! >= top && y! <= top + h
    );
  if (!covered) {
    chart.setOption({ legend: { orient: 'vertical', left, top } });
    return;
  }

  // Entries packed into rows the width of the plot, as echarts wraps them.
  const span = WIDTH - GRID.left - GRID.right;
  let rows = 1;
  let used = 0;
  for (const n of names) {
    const e = entryWidth(n) + 10;
    if (used > 0 && used + e > span) {
      rows++;
      used = 0;
    }
    used += e;
  }
  const extra = rows * ENTRY_HEIGHT + 10;
  chart.resize({ width: WIDTH, height: HEIGHT + extra });
  chart.setOption({
    legend: {
      orient: 'horizontal',
      left: GRID.left,
      right: GRID.right,
      top: HEIGHT,
    },
    grid: { ...GRID, bottom: GRID.bottom + extra },
  });
};
placeLegend();

if (values['ring-width'] > 0 && series.length > 1) {
  const sizes = overlapSizes();
  chart.setOption({
    series: series.map(({ data }, i) => ({
      data: data.map((value, j) => ({ value, symbolSize: sizes[i]![j] })),
    })),
  });
}

const svg = chart.renderToSVGString();
chart.dispose();

const outDir = join(PROJECT_ROOT, 'artifacts');
mkdirSync(outDir, { recursive: true });
/**
 * The sources as they appear in the default filename: every name while they
 * fit, and past that a count and a hash of the set. A filename is capped at
 * 255 bytes, and sanitize() truncating the list would both name the chart
 * after sources it happens to start with and let two different sets land on
 * one file. The hash is of the sorted set, so the same sources in another
 * order -- which only changes their colours -- overwrite rather than pile up.
 */
const sourcesLabel = (): string => {
  const all = sources.join('+');
  if (all.length <= 150) {
    return all;
  }
  const hash = createHash('sha256')
    .update([...sources].sort().join('\n'))
    .digest('hex')
    .slice(0, 8);
  return `${sources.length}-sources-${hash}`;
};

const base = values.out
  ? resolve(PROJECT_ROOT, values.out)
  : join(
      outDir,
      sanitize(
        [
          'post-dates',
          values.board,
          ...(values.start ? [`from-${values.start}`] : []),
          ...(values.end ? [`to-${values.end}`] : []),
          sourcesLabel(),
        ].join('-')
      )
    );
const svgPath = `${base}.svg`;
writeFileSync(svgPath, svg);
console.log(`wrote ${svgPath}`);
