import {
  type LayerName,
  MISSING_HEX,
  NATIVE_ZOOM,
  PRESENT_HEX,
} from './render.ts';

/** What a rendered map records about itself, as `map.json` beside it. */
export interface MapInfo {
  source: string;
  board: string;
  first: number;
  last: number;
  rowWidth: number;
  gridRows: number;
  /** Every rendered zoom level, ascending; the native one last. */
  zooms: number[];
  present: number;
  cells: number;
  /** Rows the readers offered for the board, duplicates included. */
  rows: number;
  /**
   * The tile layers drawn, each a directory beside this file. Absent on maps
   * drawn as one layer under tiles/, which no combined map can use.
   */
  layers?: LayerName[];
}

const fmt = (n: number): string => n.toLocaleString('en-US');
/** A post number as 4chan writes one: no separators, since it is an id. */
const postNo = (n: number): string => `No.${n}`;
const esc = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const pct = (m: MapInfo): string =>
  `${((100 * m.present) / m.cells).toFixed(2)}%`;

const summary = (m: MapInfo): string =>
  `${fmt(m.present)} of ${fmt(m.cells)} post numbers present (${pct(m)})` +
  ` from ${fmt(m.rows)} rows read`;

const STYLE = `
  html, body { margin: 0; height: 100%; font: 14px system-ui, sans-serif; }
  body { background: #ffffee; color: #800000; }
  header { padding: 8px 16px; background: #F0C0B0; border-bottom: 1px solid #D99F91; }
  header h1 { font-size: 16px; margin: 0 0 2px; }
  a { color: #0000ee; }
  .key { display: inline-block; width: 10px; height: 10px; border: 1px solid #64748b; vertical-align: middle; }
`;

const MAP_STYLE = `
  body { display: flex; flex-direction: column; }
  #map { flex: 1; background: #ffffee; }
  /* Over-zoomed tiles are scaled up by CSS; without this each post is a blur. */
  .leaflet-tile { image-rendering: pixelated; }
  .readout { font-size: 14px; padding: 4px 8px; font-variant-numeric: tabular-nums; }
  /* Leaflet's controls in Yotsuba: the reply-post colours at rest, the
     highlighted-post ones under the pointer. Scoped to .leaflet-container
     to outrank leaflet.css's .leaflet-touch rules, which browsers reporting
     touch support get even with a mouse. */
  .leaflet-container .leaflet-bar, .leaflet-container .leaflet-control-layers, .leaflet-container .readout {
    background: #f0e0d6; color: #800000; border: 1px solid #D9BFB7; border-radius: 0; box-shadow: none;
  }
  .leaflet-container .leaflet-bar a, .leaflet-container .leaflet-bar a:first-child, .leaflet-container .leaflet-bar a:last-child {
    background: #f0e0d6; color: #800000; border-bottom-color: #D9BFB7; border-radius: 0;
  }
  .leaflet-container .leaflet-bar a:hover, .leaflet-container .leaflet-bar a:focus, .leaflet-container .leaflet-bar a:active {
    background: #F0C0B0; color: #800000; outline: 1px solid #D99F91; outline-offset: -1px;
  }
  .leaflet-container .leaflet-bar a.leaflet-disabled { background: #f0e0d6; color: #D9BFB7; outline: none; }
  .leaflet-container .leaflet-control-layers label:hover { background: #F0C0B0; }
  .leaflet-container .leaflet-control-layers input { accent-color: #800000; }
`;

/** What the viewer script needs to know about the grid every layer shares. */
interface Viewer {
  first: number;
  last: number;
  rowWidth: number;
  gridRows: number;
  /** The base layer's levels, which also size the hover box. */
  zooms: number[];
}

/**
 * A page holding one Leaflet map of a post-number grid. `layers` is script
 * run once the map exists, adding its tile layers; it may use `Sparse` and
 * `tileOpts`.
 */
const mapPage = (
  title: string,
  header: string,
  grid: Viewer,
  data: object,
  layers: string
): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
<style>${STYLE}${MAP_STYLE}</style>
</head>
<body>
<header>
${header}
</header>
<div id="map"></div>
<script>
const P = ${JSON.stringify({ ...grid, nativeZoom: NATIVE_ZOOM })};
const D = ${JSON.stringify(data)};
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
const levelIn = (zooms, zoom) => {
  let best = zooms[0];
  for (const z of zooms) if (z <= zoom) best = z;
  return best;
};
const Sparse = L.TileLayer.extend({
  _clampZoom(zoom) { return levelIn(this.options.zooms, zoom); },
});
const tileOpts = { tileSize: 256, minZoom, maxZoom, bounds, noWrap: true };
${layers}
map.fitBounds(bounds);

const Readout = L.Control.extend({
  onAdd() { this.el = L.DomUtil.create('div', 'readout'); this.el.textContent = 'hover for a post number'; return this.el; },
});
const readout = new Readout({ position: 'bottomleft' }).addTo(map);
// Outlines what one pixel of the tiles on screen stands for: a post at the
// native level and past it, below it the k x k block of posts the pixel
// averages, clipped where the block runs off the grid.
const box = L.rectangle([[0, 0], [0, 0]], { color: '#800000', weight: 1, fill: false, interactive: false });
let hovered = null;
const showBox = () => {
  if (hovered === null) { box.remove(); return; }
  const k = Math.pow(2, P.nativeZoom - levelIn(P.zooms, map.getZoom()));
  const r0 = Math.floor(hovered.row / k) * k, c0 = Math.floor(hovered.col / k) * k;
  box.setBounds([[r0, c0], [Math.min(r0 + k, P.gridRows), Math.min(c0 + k, P.rowWidth)]]).addTo(map);
};
map.on('mousemove', (e) => {
  const row = Math.floor(e.latlng.lat), col = Math.floor(e.latlng.lng);
  const inGrid = row >= 0 && col >= 0 && col < P.rowWidth && row < P.gridRows
    && row * P.rowWidth + col <= P.last - P.first;
  hovered = inGrid ? { row, col } : null;
  readout.el.textContent = inGrid ? 'No.' + (P.first + row * P.rowWidth + col) : '';
  showBox();
});
map.on('mouseout', () => { hovered = null; readout.el.textContent = ''; showBox(); });
map.on('zoomend', showBox);
</script>
</body>
</html>
`;

export const renderMapPage = (m: MapInfo): string =>
  mapPage(
    `Post map: /${m.board}/ in ${m.source}`,
    `  <h1><a href="../../">All maps</a> / ${esc(m.source)} <a href="../../${BY_BOARD}/#${esc(m.board)}">/${esc(m.board)}/</a></h1>
  <div>${esc(summary(m))}.
    <span class="key" style="background:${PRESENT_HEX}"></span> present
    <span class="key" style="background:${MISSING_HEX}"></span> missing.
    ${fmt(m.rowWidth)} post numbers per row.</div>`,
    m,
    { source: m.source },
    `// The range is one layer and what the source holds another, drawn over it
// with every missing post transparent, so more sources can be laid over the
// same base.
new Sparse('base/{z}/{x}/{y}.png', { ...tileOpts, zooms: P.zooms }).addTo(map);
const present = new Sparse('present/{z}/{x}/{y}.png', { ...tileOpts, zooms: P.zooms }).addTo(map);
L.control.layers(null, { [D.source]: present }, { collapsed: false }).addTo(map);`
  );

/** Where the per-board pages live, under the output root. */
export const BY_BOARD = 'by-board';

/**
 * One board across every source that has drawn it. Only maps sharing one
 * grid can be laid over each other; the rest are only listed.
 */
export interface BoardView {
  board: string;
  /** The board's directory under BY_BOARD. */
  dir: string;
  /** The maps laid over the base, fullest first. */
  layers: HubEntry[];
  excluded: HubEntry[];
}

/** The board's map with every source in `v.layers` as its own layer. */
export const renderBoardPage = (v: BoardView): string => {
  const [grid] = v.layers as [HubEntry];
  const sources = v.layers.map((m) => ({
    url: `../../${m.href}present/{z}/{x}/{y}.png`,
    zooms: m.zooms,
    label: `${esc(m.source)} (${pct(m)})`,
  }));
  return mapPage(
    `Post map: /${v.board}/, every source`,
    `  <h1><a href="../../">All maps</a> / <a href="../#${esc(v.board)}">Boards</a> /${esc(v.board)}/</h1>
  <div>${fmt(v.layers.length)} sources over post numbers ${postNo(grid.first)} &ndash; ${postNo(grid.last)},
    ${fmt(grid.rowWidth)} per row.</div>`,
    grid,
    { base: `../../${grid.href}`, sources },
    `new Sparse(D.base + 'base/{z}/{x}/{y}.png', { ...tileOpts, zooms: P.zooms }).addTo(map);
const overlays = {};
for (const s of D.sources) {
  overlays[s.label] = new Sparse(s.url, { ...tileOpts, zooms: s.zooms }).addTo(map);
}
L.control.layers(null, overlays, { collapsed: false }).addTo(map);`
  );
};

/** Every board's maps grouped into the view renderBoardPage draws. */
export const boardViews = (maps: HubEntry[]): BoardView[] => {
  const byBoard = new Map<string, HubEntry[]>();
  for (const m of maps) {
    byBoard.set(m.board, [...(byBoard.get(m.board) ?? []), m]);
  }
  const gridKey = (m: MapInfo): string => `${m.first}:${m.last}:${m.rowWidth}`;
  return [...byBoard]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([board, ms]) => {
      const layered = ms.filter((m) => m.layers?.includes('present'));
      // The grid most of the layered maps share; on a tie the one reaching
      // furthest, which is the more recent bound.
      const counts = new Map<string, number>();
      for (const m of layered) {
        counts.set(gridKey(m), (counts.get(gridKey(m)) ?? 0) + 1);
      }
      const best = layered
        .slice()
        .sort(
          (a, b) =>
            counts.get(gridKey(b))! - counts.get(gridKey(a))! || b.last - a.last
        )[0];
      const members = layered
        .filter((m) => best !== undefined && gridKey(m) === gridKey(best))
        .sort((a, b) => b.present / b.cells - a.present / a.cells);
      return {
        board,
        dir: decodeURIComponent(ms[0]!.href.split('/')[1]!),
        layers: members,
        excluded: ms.filter((m) => !members.includes(m)),
      };
    });
};

/** Every board as a section, linking to its combined map. */
export const renderBoardIndex = (views: BoardView[]): string => {
  const sections = views
    .map((v) => {
      const rows = [...v.layers, ...v.excluded]
        .map(
          (m) => `<tr>
  <td><a href="../${esc(m.href)}">${esc(m.source)}</a></td>
  <td>${fmt(m.present)}</td>
  <td>${pct(m)}</td>
</tr>`
        )
        .join('\n');
      const title =
        v.layers.length === 0
          ? `/${esc(v.board)}/`
          : `<a href="${encodeURIComponent(v.dir)}/">/${esc(v.board)}/</a>`;
      return `<section>
<h2 id="${esc(v.board)}">${title}</h2>
<table>
<thead><tr><th>Source</th><th>Posts present</th><th>Of range</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</section>`;
    })
    .join('\n');
  return indexPage(
    'Post maps by board',
    `<h1><a href="../">All maps</a> / Boards</h1>
  <div>${fmt(views.length)} boards. Each links to one map with every source that shares the board's range as its own layer.</div>`,
    sections
  );
};

/** A map as the hub lists it: `href` is its page, relative to the hub. */
export type HubEntry = MapInfo & { href: string };

/** Every map under the output root, a section per source. */
export const renderHub = (maps: HubEntry[]): string => {
  const bySource = new Map<string, HubEntry[]>();
  for (const m of maps) {
    bySource.set(m.source, [...(bySource.get(m.source) ?? []), m]);
  }
  const sections = [...bySource]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, ms]) => {
      const rows = ms
        .sort((a, b) => a.board.localeCompare(b.board))
        .map(
          (m) => `<tr>
  <td><a href="${esc(m.href)}">/${esc(m.board)}/</a></td>
  <td>${fmt(m.present)}</td>
  <td>${pct(m)}</td>
  <td>${postNo(m.first)} &ndash; ${postNo(m.last)}</td>
</tr>`
        )
        .join('\n');
      return `<section>
<h2 id="${esc(source)}">${esc(source)}</h2>
<table>
<thead><tr><th>Board</th><th>Posts present</th><th>Of range</th><th>Post numbers</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</section>`;
    })
    .join('\n');
  return indexPage(
    'Post maps',
    `<h1>Post maps</h1>
  <div>${fmt(maps.length)} maps across ${fmt(bySource.size)} sources. Each map shares its post-number range with the other sources' maps of that board, as of the run that drew it. <a href="${BY_BOARD}/">By board</a>, with every source on one map.</div>`,
    sections
  );
};

const indexPage = (title: string, header: string, body: string): string =>
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${STYLE}
  main { padding: 8px 16px 32px; }
  h2 { font-size: 15px; margin: 20px 0 6px; }
  table { border-collapse: collapse; font-variant-numeric: tabular-nums; }
  th, td { padding: 2px 12px 2px 0; text-align: right; }
  th:first-child, td:first-child { text-align: left; }
  th { font-weight: 600; border-bottom: 1px solid #D99F91; }
</style>
</head>
<body>
<header>
  ${header}
</header>
<main>
${body}
</main>
</body>
</html>
`;
