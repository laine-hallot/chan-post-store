import type { Manifest } from '@chan-post-store/cli/src/manifest.ts';
import type { Runner } from '@chan-post-store/cli/src/utils/exec/runner.ts';

import type { ScanConfig } from './scan.ts';

import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { multiple, optional, withDefault } from '@optique/core/modifiers';
import { flag, option } from '@optique/core/primitives';
import { defineProgram } from '@optique/core/program';
import { integer, string } from '@optique/core/valueparser';
import { run } from '@optique/run';
import express from 'express';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

import { BITSET_FORMAT, decodeScan } from './bitset.ts';
import {
  boardViews,
  BY_BOARD,
  renderBoardIndex,
  renderBoardPage,
  renderHub,
  renderMapPage,
  type HubEntry,
  type MapInfo,
} from './page.ts';
import { blankTile, layout, NATIVE_ZOOM, renderMap } from './render.ts';

/**
 * Which post numbers a source holds for a board, as a grid with a cell per
 * post number: filled where the source has the post, empty where it
 * doesn't. Numbers run left to right and wrap, like text. One map per
 * (source, board), for every source and board asked for -- by default every
 * board of every source in chan.config.json.
 *
 * Post numbers on a board only count up, so every number between the first
 * and the last was once a post somewhere. A gap is a post the archive never
 * saw -- scattered gaps are mostly deletions it was too slow for, solid
 * bands are outages.
 *
 * A board is hundreds of millions of cells, far past what one image can be,
 * so the grid is cut into 256px map tiles at one pixel per post and viewed
 * in Leaflet, which scales those same tiles up for the zoom levels past it.
 * The tiles are zoom level 20 of a CRS where level 20 is one pixel per map
 * unit, so a map coordinate IS a grid cell.
 *
 * Zooming out over level-20 tiles would load 4x as many per level, so a few
 * coarser levels are rendered too (`--zoom`). Each of their pixels covers a
 * square block of post numbers and is shaded by the fraction present; the
 * viewer uses the nearest rendered level at or below the current zoom and
 * scales it up for the levels between.
 *
 * Every map of one board shares one range -- up to the highest post any
 * source in the run holds there -- and so one grid, so the same post number
 * is in the same place on each and two archives can be compared by flipping
 * between them.
 *
 * Reads the sources' staged files on the archive host, as post-dates does,
 * never the store: the store attributes each post to whichever archive got
 * there first and so cannot say what any one archive holds.
 */

const SCAN_BUNDLE = fileURLToPath(
  new URL('../../dist/post-map-scan.mjs', import.meta.url)
);

/** Zoom levels rendered besides the native one when --zoom is not given. */
const DEFAULT_ZOOMS = [1, 2, 5, 13, 15, 17, 18];

const program = defineProgram({
  parser: merge(
    object({
      sources: multiple(
        option('--source', string(), {
          description: message`Source id, as named under sources/. Repeatable. Defaults to every source in chan.config.json.`,
        })
      ),
      board: optional(
        option('--board', string(), {
          description: message`Board slug, without slashes. Defaults to every board each source holds.`,
        })
      ),
      first: withDefault(
        option('--first', integer({ min: 0 }), {
          description: message`The post number in every grid's first cell.`,
        }),
        0
      ),
      last: optional(
        option('--last', integer({ min: 0 }), {
          description: message`The post number in every grid's last cell. Defaults, per board, to the highest post any of the sources holds there.`,
        })
      ),
      'row-width': optional(
        option('--row-width', integer({ min: 1 }), {
          description: message`Post numbers per row of the grid. Defaults to whole tiles making each board's grid roughly square.`,
        })
      ),
      zoom: multiple(
        option('--zoom', integer({ min: 0, max: 19 }), {
          description: message`A zoom level to render below the native 20, where level z shows 2^(20-z) post numbers per pixel side. Repeatable. Defaults to ${DEFAULT_ZOOMS.join(', ')}.`,
        })
      ),
      'reuse-scan': withDefault(
        flag('--reuse-scan', {
          description: message`Map the scans cached by an earlier run instead of scanning again, for any source that has one. NOT invalidated when a source is re-staged.`,
        }),
        false
      ),
      'serve-only': withDefault(
        flag('--serve-only', {
          description: message`Serve the maps already drawn under the output root, without scanning or drawing any.`,
        }),
        false
      ),
      'no-serve': withDefault(
        flag('--no-serve', {
          description: message`Write the tiles and pages and exit, instead of serving them.`,
        }),
        false
      ),
      host: withDefault(
        option('--host', string(), {
          description: message`Address to serve on. The default listens on every interface, so the maps can be opened from another machine on the network.`,
        }),
        '0.0.0.0'
      ),
      port: withDefault(
        option('--port', integer({ min: 0, max: 65_535 }), {
          description: message`Port to serve on.`,
        }),
        8080
      ),
      out: optional(
        option('--out', string(), {
          description: message`Output root, resolved against the repo root. Defaults to artifacts/post-map. Each map is <source>/<board>/ under it, replaced whole when redrawn; index.html lists every map there.`,
        })
      ),
    }),
    runnerOptions
  ),
  metadata: {
    name: 'post-map.ts',
    brief: message`Map which post numbers each source holds for each board.`,
    description: message`Reads each source's staged files with the ingest readers, on the machine holding the archives, and records every post number it holds for each board. Renders each (source, board) as map tiles with one pixel per post number, with a page that views them in Leaflet and an index of every map. Needs no database. Run \`npm run build:sources\` first: it bundles the scan.`,
  },
});

const values = await run(program, { help: 'both' });

const fail: (msg: string) => never = (msg) => {
  console.error(msg);
  process.exit(1);
};

const fmt = (n: number): string => n.toLocaleString('en-US');
const secs = (t0: number): string =>
  `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const configured = (): string[] => {
  const file = join(PROJECT_ROOT, 'chan.config.json');
  const cfg = JSON.parse(readFileSync(file, 'utf8')) as { sources?: string[] };
  if (!cfg.sources || cfg.sources.length === 0) {
    fail(`${file} lists no sources; name them with --source`);
  }
  return cfg.sources;
};
// --serve-only maps nothing: both passes below then do nothing, and the run
// goes straight to the index and the server.
const serveOnly = values['serve-only'];
const sources = serveOnly
  ? []
  : [...new Set(values.sources.length > 0 ? values.sources : configured())];

if (!serveOnly && !existsSync(SCAN_BUNDLE)) {
  fail(`${SCAN_BUNDLE} does not exist\n  run: npm run build:sources`);
}

const CACHE_DIR = join(PROJECT_ROOT, '.cache', 'post-map');
const cacheFor = (source: string, board: string | undefined): string =>
  join(
    CACHE_DIR,
    sanitize(`${source}-${board ?? 'all'}-v${BITSET_FORMAT}.bin.gz`)
  );

/**
 * The cached scan that answers for this source, if any. A whole-source scan
 * answers for a single board too, so it is the fallback for one.
 */
const cachedScan = (source: string): string | undefined =>
  [cacheFor(source, values.board), cacheFor(source, undefined)].find((f) =>
    existsSync(f)
  );

type Readable = Manifest & { adapter: ScanConfig['adapter'] };

/**
 * The manifest when the scan can read this source; otherwise why not. A
 * pending or dead-end source, or one whose adapter scan.ts does not know, is
 * reported and skipped: across the whole corpus that is an answer, not an
 * error.
 */
const plan = (source: string): Readable | string => {
  const r = readManifest(manifestPath(source, PROJECT_ROOT), PROJECT_ROOT);
  if (r.isErr) {
    return r.error.message.split('\n')[0]!;
  }
  const m = r.unwrap();
  // Positively, as in post-dates: a new adapter is refused until scan.ts
  // learns it.
  if (m.adapter !== 'sql' && m.adapter !== 'json' && m.adapter !== 'html') {
    return `post-map cannot read the ${m.adapter} adapter`;
  }
  return m as Readable;
};

let runner: Runner | undefined;
/** Connected on first use, so a fully cached run works with the host down. */
const connect = async (): Promise<Runner> => {
  if (runner === undefined) {
    const r = await makeRunner({
      projectRoot: PROJECT_ROOT,
      host: values.remote,
      forceLocal: values.local,
      key: values.key,
    });
    if (r.isErr) {
      fail(r.error.message);
    }
    runner = r.unwrap();
  }
  return runner;
};

/** Scans one source on the archive host and returns the encoded result. */
const scan = async (source: string, manifest: Readable): Promise<Buffer> => {
  const r = await connect();
  const info = readSourceInfo(manifestPath(source, PROJECT_ROOT)).unwrap();
  const dir = r.path(r.rootIsDatasets ? info.dirFromDatasets : info.dir);
  const storageRoot = r.rootIsDatasets
    ? r.path('.')
    : join(PROJECT_ROOT, info.dir, '..');
  const node = await ensureNodeRuntime(r, storageRoot, PROJECT_ROOT);
  if (node.isErr) {
    throw node.error;
  }

  const script = `${dir}/.post-map-scan.mjs`;
  const resultFile = `.post-map-${sanitize(values.board ?? 'all')}.bin.gz`;
  const w = await r.writeFile(script, readFileSync(SCAN_BUNDLE));
  if (w.isErr) {
    throw w.error;
  }
  const cfg: ScanConfig = {
    source,
    adapter: manifest.adapter,
    // Project-root relative in the manifest; the scan's cwd is the dataset
    // dir.
    path: relative(resolve(PROJECT_ROOT, info.dir), manifest.path),
    site: manifest.site,
    board: values.board,
    excludeBoards: manifest.excludeBoards,
    out: resultFile,
  };
  const res = await r.exec(
    `${shQuote(node.unwrap())} ${shQuote(script)} ${shQuote(JSON.stringify(cfg))}`,
    { cwd: dir, inherit: true }
  );
  await r.exec(`rm -f ${shQuote(script)}`, { cwd: dir });
  if (res.code !== 0) {
    throw new Error(`scan exited ${res.code}`);
  }
  const read = await r.readFile(`${dir}/${resultFile}`);
  await r.exec(`rm -f ${shQuote(resultFile)}`, { cwd: dir });
  if (read.isErr) {
    throw read.error;
  }
  return read.unwrap();
};

// Pass 1: every source scanned or found in the cache, keeping only each
// board's highest post. The bits stay on disk until pass 2, one source at a
// time -- a whole corpus of bitsets is gigabytes.
interface Scanned {
  source: string;
  cache: string;
  maxNo: Map<string, number>;
}
const scanned: Scanned[] = [];
const skipped: [string, string][] = [];
const failed: [string, string][] = [];

mkdirSync(CACHE_DIR, { recursive: true });
for (const [i, source] of sources.entries()) {
  const tag = `[${i + 1}/${sources.length}] ${source}`;
  const manifest = plan(source);
  if (typeof manifest === 'string') {
    console.log(`${tag}: skipped -- ${manifest}`);
    skipped.push([source, manifest]);
    continue;
  }
  let cache = values['reuse-scan'] ? cachedScan(source) : undefined;
  if (cache !== undefined) {
    console.log(`${tag}: reusing ${relative(PROJECT_ROOT, cache)}`);
  } else {
    console.log(
      `${tag}: scanning ${values.board === undefined ? 'every board' : `/${values.board}/`}`
    );
    const t0 = Date.now();
    try {
      const buf = await scan(source, manifest);
      cache = cacheFor(source, values.board);
      writeFileSync(cache, buf);
      console.log(`${tag}: scanned in ${secs(t0)}`);
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`${tag}: FAILED -- ${msg}`);
      failed.push([source, msg]);
      continue;
    }
  }
  const boards = decodeScan(readFileSync(cache)).filter(
    (b) =>
      b.maxNo >= 0 && (values.board === undefined || b.board === values.board)
  );
  if (boards.length === 0) {
    const what = values.board === undefined ? 'any board' : `/${values.board}/`;
    console.log(`${tag}: holds no posts for ${what}`);
    skipped.push([source, `no posts for ${what}`]);
    continue;
  }
  scanned.push({
    source,
    cache,
    maxNo: new Map(boards.map((b) => [b.board, b.maxNo])),
  });
}
await runner?.close();

/** Each board's range end: --last, or the highest post any source holds. */
const boardLast = new Map<string, number>();
for (const s of scanned) {
  for (const [board, max] of s.maxNo) {
    boardLast.set(board, Math.max(boardLast.get(board) ?? -1, max));
  }
}

// Pass 2: the maps, one source's bitsets in memory at a time.
const root = values.out
  ? resolve(PROJECT_ROOT, values.out)
  : join(PROJECT_ROOT, 'artifacts', 'post-map');
const mapDir = (source: string, board: string): string =>
  join(root, sanitize(source), sanitize(board) || '_');
const zooms = values.zoom.length > 0 ? values.zoom : DEFAULT_ZOOMS;
const { first } = values;

let drawn = 0;
for (const s of scanned) {
  for (const b of decodeScan(readFileSync(s.cache))) {
    if (!s.maxNo.has(b.board)) {
      continue;
    }
    const last = values.last ?? boardLast.get(b.board)!;
    const tag = `${s.source} /${b.board}/`;
    if (last < first) {
      console.log(`${tag}: nothing at or after --first ${fmt(first)}`);
      continue;
    }
    const grid = layout(first, last, values['row-width']);
    const dir = mapDir(s.source, b.board);
    // Replaced whole: a different range or --row-width moves every post to
    // another tile, and a leftover tile from the last layout would be drawn
    // as if current.
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    const r = renderMap(b.bits, grid, zooms, dir);
    const map: MapInfo = {
      source: s.source,
      board: b.board,
      ...grid,
      zooms: [...new Set(zooms)].sort((x, y) => x - y).concat(NATIVE_ZOOM),
      present: r.present,
      cells: last - first + 1,
      rows: b.rows,
      layers: ['base', 'present'],
    };
    writeFileSync(join(dir, 'map.json'), JSON.stringify(map));
    writeFileSync(join(dir, 'index.html'), renderMapPage(map));
    drawn++;
    console.log(
      `${tag}: ${fmt(r.present)} of ${fmt(map.cells)} present,` +
        ` ${fmt(r.written.base)}/${fmt(r.written.present)} of ${fmt(r.tiles)}` +
        ` base/present tiles written in ${secs(t0)}`
    );
  }
}

/** Every map under the root, including ones drawn by earlier runs. */
const allMaps = (): HubEntry[] =>
  readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .flatMap((src) =>
      readdirSync(join(root, src.name), { withFileTypes: true })
        .filter(
          (e) =>
            e.isDirectory() &&
            existsSync(join(root, src.name, e.name, 'map.json'))
        )
        .map((e) => ({
          ...(JSON.parse(
            readFileSync(join(root, src.name, e.name, 'map.json'), 'utf8')
          ) as MapInfo),
          href: `${encodeURIComponent(src.name)}/${encodeURIComponent(e.name)}/`,
        }))
    );

mkdirSync(root, { recursive: true });
const maps = allMaps();
writeFileSync(join(root, 'index.html'), renderHub(maps));
// Rebuilt whole, like the hub: a board page names the maps it layers, and
// any of them may have been redrawn or removed since.
const boardRoot = join(root, BY_BOARD);
rmSync(boardRoot, { recursive: true, force: true });
mkdirSync(boardRoot, { recursive: true });
const views = boardViews(maps);
writeFileSync(join(boardRoot, 'index.html'), renderBoardIndex(views));
for (const v of views.filter((v) => v.layers.length > 0)) {
  mkdirSync(join(boardRoot, v.dir), { recursive: true });
  writeFileSync(join(boardRoot, v.dir, 'index.html'), renderBoardPage(v));
}

console.log(
  `\ndrew ${fmt(drawn)} maps from ${fmt(scanned.length)} sources;` +
    ` ${fmt(maps.length)} maps in ${join(root, 'index.html')}`
);
for (const [source, why] of skipped) {
  console.log(`  skipped ${source}: ${why}`);
}
for (const [source, why] of failed) {
  console.log(`  FAILED  ${source}: ${why}`);
}

if (serveOnly || !values['no-serve']) {
  // Static files, plus the tile each layer leaves unwritten: inside a grid,
  // a base tile with no file is wholly in range and a present one holds no
  // post. The page never asks for a tile outside its grid. `tiles/` is the
  // single layer maps drawn before the split still ask for, whose unwritten
  // tile was the base's.
  const app = express();
  app.use(express.static(root));
  app.get(/\/(base|tiles)\/\d+\/\d+\/\d+\.png$/, (_req, res) => {
    res.type('png').send(blankTile.base);
  });
  app.get(/\/present\/\d+\/\d+\/\d+\.png$/, (_req, res) => {
    res.type('png').send(blankTile.present);
  });
  const server = app.listen(values.port, values.host, (err?: Error) => {
    if (err) {
      fail(`could not listen on ${values.host}:${values.port}: ${err.message}`);
    }
    const shown = values.host === '0.0.0.0' ? 'localhost' : values.host;
    console.log(`serving at http://${shown}:${values.port}/ (ctrl-c to stop)`);
  });
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}

if (failed.length > 0) {
  process.exitCode = 1;
}
