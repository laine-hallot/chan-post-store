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

import { BITSET_FORMAT, decodeBitset, hasPost } from './bitset.ts';
import { encodeIndexedPng, type PaletteEntry } from './png.ts';

/**
 * Which post numbers one source holds for one board, as a grid with a cell
 * per post number: filled where the source has the post, empty where it
 * doesn't. Numbers run left to right and wrap, like text.
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
 * Reads the source's staged files on the archive host, as post-dates does,
 * never the store: the store attributes each post to whichever archive got
 * there first and so cannot say what any one archive holds.
 */

const SCAN_BUNDLE = fileURLToPath(
  new URL('../../dist/post-map-scan.mjs', import.meta.url)
);

const TILE = 256;
const NATIVE_ZOOM = 20;

/** Zoom levels rendered besides the native one when --zoom is not given. */
const DEFAULT_ZOOMS = [1, 2, 5, 13, 15, 17, 18];

const MISSING_HEX = '#f0e0d6';
const PRESENT_HEX = '#789922';

/**
 * Tile pixel values, indexing PALETTE: OUTSIDE is past either end of the
 * range and transparent; 1..255 run from none of a pixel's post numbers
 * present to all of them. A native-level pixel is one post, so it is only
 * ever one end or the other.
 */
const OUTSIDE = 0;
const MISSING = 1;
const PRESENT = 255;

const lerpHex = (a: string, b: string, t: number): string => {
  const ca = parseInt(a.slice(1), 16);
  const cb = parseInt(b.slice(1), 16);
  let out = 0;
  for (const shift of [16, 8, 0]) {
    const x = (ca >> shift) & 0xff;
    const y = (cb >> shift) & 0xff;
    out |= Math.round(x + (y - x) * t) << shift;
  }
  return `#${out.toString(16).padStart(6, '0')}`;
};

const PALETTE: PaletteEntry[] = [
  { hex: '#000000', alpha: 0 },
  ...Array.from({ length: PRESENT - MISSING + 1 }, (_, i) => ({
    hex: lerpHex(MISSING_HEX, PRESENT_HEX, i / (PRESENT - MISSING)),
    alpha: 255,
  })),
];

/** The palette index for a block with `present` of its `of` posts held. */
const shade = (present: number, of: number): number =>
  of === 0
    ? OUTSIDE
    : MISSING + Math.round((present / of) * (PRESENT - MISSING));

const program = defineProgram({
  parser: merge(
    object({
      source: option('--source', string(), {
        description: message`Source id, as named under sources/.`,
      }),
      board: option('--board', string(), {
        description: message`Board slug, without slashes.`,
      }),
      first: withDefault(
        option('--first', integer({ min: 0 }), {
          description: message`The post number in the grid's first cell.`,
        }),
        0
      ),
      last: optional(
        option('--last', integer({ min: 0 }), {
          description: message`The post number in the grid's last cell. Defaults to the highest post the source holds for the board.`,
        })
      ),
      'row-width': optional(
        option('--row-width', integer({ min: 1 }), {
          description: message`Post numbers per row of the grid. Defaults to whole tiles making the grid roughly square.`,
        })
      ),
      zoom: multiple(
        option('--zoom', integer({ min: 0, max: 19 }), {
          description: message`A zoom level to render below the native 20, where level z shows 2^(20-z) post numbers per pixel side. Repeatable. Defaults to ${DEFAULT_ZOOMS.join(', ')}.`,
        })
      ),
      'reuse-scan': withDefault(
        flag('--reuse-scan', {
          description: message`Map the scan cached by an earlier run instead of scanning again. NOT invalidated when the source is re-staged.`,
        }),
        false
      ),
      'no-serve': withDefault(
        flag('--no-serve', {
          description: message`Write the tiles and page and exit, instead of serving them.`,
        }),
        false
      ),
      host: withDefault(
        option('--host', string(), {
          description: message`Address to serve on. The default listens on every interface, so the map can be opened from another machine on the network.`,
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
          description: message`Output directory, resolved against the repo root. Defaults to artifacts/post-map-<board>-<source>. Its tiles/ directory is replaced.`,
        })
      ),
    }),
    runnerOptions
  ),
  metadata: {
    name: 'post-map.ts',
    brief: message`Map which post numbers one source holds for one board.`,
    description: message`Reads the source's staged files with the ingest readers, on the machine holding the archives, and records every post number it holds for the board. Renders that as map tiles with one pixel per post number, plus an index.html that views them in Leaflet. Needs no database. Run \`npm run build:sources\` first: it bundles the scan.`,
  },
});

const values = await run(program, { help: 'both' });

const fail: (msg: string) => never = (msg) => {
  console.error(msg);
  process.exit(1);
};

const fmt = (n: number): string => n.toLocaleString('en-US');

const { source, board } = values;

const CACHE_DIR = join(PROJECT_ROOT, '.cache', 'post-map');
const cachePath = join(
  CACHE_DIR,
  sanitize(`${source}-${board}-v${BITSET_FORMAT}.bin.gz`)
);

const scan = async (): Promise<Buffer> => {
  if (!existsSync(SCAN_BUNDLE)) {
    fail(`${SCAN_BUNDLE} does not exist\n  run: npm run build:sources`);
  }
  const file = manifestPath(source, PROJECT_ROOT);
  const manifestR = readManifest(file, PROJECT_ROOT);
  if (manifestR.isErr) {
    fail(manifestR.error.message);
  }
  const manifest = manifestR.unwrap();
  const { adapter } = manifest;
  // Positively, as in post-dates: a new adapter is refused until scan.ts
  // learns it.
  if (adapter !== 'sql' && adapter !== 'json' && adapter !== 'html') {
    fail(`${source}: post-map cannot read the ${adapter} adapter`);
  }
  const info = readSourceInfo(file).unwrap();

  const runnerR = await makeRunner({
    projectRoot: PROJECT_ROOT,
    host: values.remote,
    forceLocal: values.local,
    key: values.key,
  });
  if (runnerR.isErr) {
    fail(runnerR.error.message);
  }
  const runner: Runner = runnerR.unwrap();
  try {
    const dir = runner.path(
      runner.rootIsDatasets ? info.dirFromDatasets : info.dir
    );
    const storageRoot = runner.rootIsDatasets
      ? runner.path('.')
      : join(PROJECT_ROOT, info.dir, '..');
    const node = await ensureNodeRuntime(runner, storageRoot, PROJECT_ROOT);
    if (node.isErr) {
      throw node.error;
    }

    const script = `${dir}/.post-map-scan.mjs`;
    const resultFile = `.post-map-${sanitize(board)}.bin.gz`;
    const w = await runner.writeFile(script, readFileSync(SCAN_BUNDLE));
    if (w.isErr) {
      throw w.error;
    }
    const cfg: ScanConfig = {
      source,
      adapter,
      // Project-root relative in the manifest; the scan's cwd is the
      // dataset dir.
      path: relative(resolve(PROJECT_ROOT, info.dir), manifest.path),
      site: manifest.site,
      board,
      excludeBoards: manifest.excludeBoards,
      out: resultFile,
    };
    console.log(`scanning ${source} /${board}/ in ${dir} (${runner.where})`);
    const t0 = Date.now();
    const r = await runner.exec(
      `${shQuote(node.unwrap())} ${shQuote(script)} ${shQuote(JSON.stringify(cfg))}`,
      { cwd: dir, inherit: true }
    );
    await runner.exec(`rm -f ${shQuote(script)}`, { cwd: dir });
    if (r.code !== 0) {
      throw new Error(`${source}: scan exited ${r.code}`);
    }
    const read = await runner.readFile(`${dir}/${resultFile}`);
    await runner.exec(`rm -f ${shQuote(resultFile)}`, { cwd: dir });
    if (read.isErr) {
      throw read.error;
    }
    console.log(`scanned in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    return read.unwrap();
  } catch (e) {
    fail((e as Error).message);
  } finally {
    await runner.close();
  }
};

let raw: Buffer;
if (values['reuse-scan'] && existsSync(cachePath)) {
  console.log(`reusing the cached scan of ${source} /${board}/`);
  raw = readFileSync(cachePath);
} else {
  raw = await scan();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(cachePath, raw);
}
const { bits, maxNo, rows } = decodeBitset(raw);

if (maxNo < 0) {
  fail(
    `${source} holds no posts for /${board}/` +
      ` (check the board slug, and that it is not in ingest.exclude-boards)`
  );
}

const { first } = values;
const last = values.last ?? maxNo;
if (last < first) {
  fail(`--last ${fmt(last)} is before --first ${fmt(first)}`);
}
const cells = last - first + 1;
const rowWidth =
  values['row-width'] ?? Math.ceil(Math.sqrt(cells) / TILE) * TILE;
const gridRows = Math.ceil(cells / rowWidth);
const lowZooms = [
  ...new Set(values.zoom.length > 0 ? values.zoom : DEFAULT_ZOOMS),
].sort((a, b) => b - a);

console.log(
  `/${board}/ ${fmt(first)}..${fmt(last)}: ${fmt(rowWidth)} x ${fmt(gridRows)} cells,` +
    ` zoom levels ${[...lowZooms].reverse().join(', ')} and ${NATIVE_ZOOM}`
);

const base = values.out
  ? resolve(PROJECT_ROOT, values.out)
  : join(PROJECT_ROOT, 'artifacts', sanitize(`post-map-${board}-${source}`));
// Replaced whole: a different --row-width moves every post to another tile,
// and a leftover tile from the last layout would be drawn as if current.
rmSync(join(base, 'tiles'), { recursive: true, force: true });

/**
 * Writes one zoom level's tiles for a level `w` x `h` pixels across, asking
 * `pixel` for each palette index. Returns how many tiles it wrote.
 */
const writeLevel = (
  zoom: number,
  w: number,
  h: number,
  pixel: (x: number, y: number) => number
): number => {
  const tilesX = Math.ceil(w / TILE);
  const tilesY = Math.ceil(h / TILE);
  const dir = join(base, 'tiles', String(zoom));
  for (let tx = 0; tx < tilesX; tx++) {
    mkdirSync(join(dir, String(tx)), { recursive: true });
  }
  const px = new Uint8Array(TILE * TILE);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx = 0; tx < tilesX; tx++) {
      for (let y = 0; y < TILE; y++) {
        const py = ty * TILE + y;
        for (let x = 0; x < TILE; x++) {
          const pxX = tx * TILE + x;
          px[y * TILE + x] = pxX < w && py < h ? pixel(pxX, py) : OUTSIDE;
        }
      }
      writeFileSync(
        join(dir, String(tx), `${ty}.png`),
        encodeIndexedPng(TILE, TILE, px, PALETTE)
      );
    }
    process.stdout.write(`\rzoom ${zoom}: tile row ${ty + 1}/${tilesY}`);
  }
  process.stdout.write('\n');
  return tilesX * tilesY;
};

const t0 = Date.now();

let present = 0;
let tiles = writeLevel(NATIVE_ZOOM, rowWidth, gridRows, (col, row) => {
  const cell = row * rowWidth + col;
  if (cell >= cells) {
    return OUTSIDE;
  }
  if (hasPost(bits, first + cell)) {
    present++;
    return PRESENT;
  }
  return MISSING;
});

/**
 * How many in-range post numbers the k x k block at (bx, by) covers. Worked
 * out from the grid's shape rather than counted: every row is full but the
 * last, which holds `tail` cells.
 */
const fullRows = Math.floor(cells / rowWidth);
const tail = cells - fullRows * rowWidth;
const clamp = (n: number, k: number): number => Math.max(0, Math.min(k, n));
const inRange = (bx: number, by: number, k: number): number => {
  const r0 = by * k;
  const full = Math.max(0, Math.min(r0 + k, fullRows) - r0);
  let n = clamp(rowWidth - bx * k, k) * full;
  if (fullRows >= r0 && fullRows < r0 + k) {
    n += clamp(tail - bx * k, k);
  }
  return n;
};

if (lowZooms.length > 0) {
  // Present posts per block at the finest low level, counted from the set
  // bits directly; each coarser level is then 2x2 sums of the one above.
  let zoom = lowZooms[0]!;
  let k = 2 ** (NATIVE_ZOOM - zoom);
  let w = Math.ceil(rowWidth / k);
  let h = Math.ceil(gridRows / k);
  let counts = new Uint32Array(w * h);
  const lastByte = Math.min(last >> 3, bits.length - 1);
  for (let b = first >> 3; b <= lastByte; b++) {
    const byte = bits[b]!;
    if (byte === 0) {
      continue;
    }
    for (let i = 0; i < 8; i++) {
      const n = b * 8 + i;
      if ((byte & (1 << i)) === 0 || n < first || n > last) {
        continue;
      }
      const cell = n - first;
      const row = Math.floor(cell / rowWidth);
      const col = cell - row * rowWidth;
      counts[Math.floor(row / k) * w + Math.floor(col / k)]!++;
    }
  }

  for (;;) {
    if (lowZooms.includes(zoom)) {
      const [c, cw, kk] = [counts, w, k];
      tiles += writeLevel(zoom, w, h, (x, y) =>
        shade(c[y * cw + x]!, inRange(x, y, kk))
      );
    }
    if (zoom === lowZooms[lowZooms.length - 1]) {
      break;
    }
    const w2 = Math.ceil(w / 2);
    const h2 = Math.ceil(h / 2);
    const halved = new Uint32Array(w2 * h2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        halved[(y >> 1) * w2 + (x >> 1)]! += counts[y * w + x]!;
      }
    }
    [counts, w, h, k, zoom] = [halved, w2, h2, k * 2, zoom - 1];
  }
}
console.log(
  `rendered ${fmt(tiles)} tiles in ${((Date.now() - t0) / 1000).toFixed(1)}s`
);

const pct = ((100 * present) / cells).toFixed(2);
const summary =
  `${fmt(present)} of ${fmt(cells)} post numbers present (${pct}%)` +
  ` from ${fmt(rows)} rows read`;
console.log(summary);

const page = {
  title: `/${board}/ in ${source}`,
  summary,
  first,
  rowWidth,
  gridRows,
  nativeZoom: NATIVE_ZOOM,
  zooms: [...lowZooms].reverse().concat(NATIVE_ZOOM),
  missing: MISSING_HEX,
  present: PRESENT_HEX,
};
const renderPage = (p: typeof page): string => {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Post map: ${esc(p.title)}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>
  html, body { margin: 0; height: 100%; font: 14px system-ui, sans-serif; }
  body { display: flex; flex-direction: column; background: #ffffee; color: #800000; }
  header { padding: 8px 16px; background: #F0C0B0; border-bottom: 1px solid #D99F91; }
  header h1 { font-size: 16px; margin: 0 0 2px; }
  .key { display: inline-block; width: 10px; height: 10px; border: 1px solid #64748b; vertical-align: middle; }
  #map { flex: 1; background: #ffffee; }
  /* Over-zoomed tiles are scaled up by CSS; without this each post is a blur. */
  .leaflet-tile { image-rendering: pixelated; }
  .readout { font-size: 14px; background: #fff; padding: 4px 8px; border-radius: 4px; font-variant-numeric: tabular-nums; }
</style>
</head>
<body>
<header>
  <h1>${esc(p.title)}</h1>
  <div>${esc(p.summary)}.
    <span class="key" style="background:${p.present}"></span> present
    <span class="key" style="background:${p.missing}"></span> missing.
    ${fmt(p.rowWidth)} post numbers per row.</div>
</header>
<div id="map"></div>
<script>
const P = ${JSON.stringify(p)};
// Zoom NATIVE is one pixel per map unit, so lng is the column and lat the row
// (rows run down the screen, hence the positive y coefficient).
const s = Math.pow(2, -P.nativeZoom);
const crs = L.extend({}, L.CRS.Simple, { transformation: new L.Transformation(s, 0, s, 0) });
const bounds = L.latLngBounds([0, 0], [P.gridRows, P.rowWidth]);
const minZoom = P.zooms[0], maxZoom = P.nativeZoom + 6;
const map = L.map('map', { crs, minZoom, maxZoom, maxBounds: bounds.pad(0.5) });
// Only some levels are rendered. Leaflet's native-zoom clamp assumes one
// contiguous range, so it is replaced: tiles come from the nearest rendered
// level at or below the view's zoom, scaled up -- never a finer one, which
// would load 4x the tiles for every level it is away.
const Sparse = L.TileLayer.extend({
  _clampZoom(zoom) {
    let best = P.zooms[0];
    for (const z of P.zooms) if (z <= zoom) best = z;
    return best;
  },
});
new Sparse('tiles/{z}/{x}/{y}.png', { tileSize: 256, minZoom, maxZoom, bounds, noWrap: true }).addTo(map);
map.fitBounds(bounds);

const Readout = L.Control.extend({
  onAdd() { this.el = L.DomUtil.create('div', 'readout'); this.el.textContent = 'hover for a post number'; return this.el; },
});
const readout = new Readout({ position: 'bottomleft' }).addTo(map);
map.on('mousemove', (e) => {
  const row = Math.floor(e.latlng.lat), col = Math.floor(e.latlng.lng);
  readout.el.textContent = row < 0 || col < 0 || col >= P.rowWidth || row >= P.gridRows
    ? ''
    : 'No.' + (P.first + row * P.rowWidth + col).toLocaleString('en-US');
});
</script>
</body>
</html>
`;
};

writeFileSync(join(base, 'index.html'), renderPage(page));
console.log(`wrote ${join(base, 'index.html')}`);

if (!values['no-serve']) {
  // Static files only: the page and its tiles are already on disk, so the
  // server is just what lets a browser on another machine reach them.
  const app = express();
  app.use(express.static(base));
  const server = app.listen(values.port, values.host, (err?: Error) => {
    if (err) {
      fail(`could not listen on ${values.host}:${values.port}: ${err.message}`);
    }
    const shown = values.host === '0.0.0.0' ? 'localhost' : values.host;
    console.log(`serving at http://${shown}:${values.port}/ (ctrl-c to stop)`);
  });
  process.on('SIGINT', () => server.close(() => process.exit(0)));
}
