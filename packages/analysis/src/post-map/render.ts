import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { hasPost } from './bitset.ts';
import { encodeIndexedPng, type PaletteEntry } from './png.ts';

export const TILE = 256;
export const NATIVE_ZOOM = 20;

export const MISSING_HEX = '#f0e0d6';
export const PRESENT_HEX = '#789922';

/**
 * A map is two tile layers, so that more than one source's presence can be
 * drawn over the same base later:
 *
 * - `base`: the post-number range itself, MISSING_HEX inside it and
 *   transparent past either end.
 * - `present`: PRESENT_HEX where posts are held, transparent elsewhere. A
 *   native-level pixel is one post, so it is either opaque or not; a coarser
 *   one is a block of posts and its alpha is the fraction of them held, which
 *   over the base composites to the same gradient one layer used to draw.
 *
 * Pixel values index each layer's palette; 0 is transparent in both.
 */
const CLEAR = 0;
const IN_RANGE = 1;
const ALL_PRESENT = 255;

export type LayerName = 'base' | 'present';

interface Layer {
  palette: PaletteEntry[];
  /**
   * The pixel value a tile is left unwritten for when every pixel holds it --
   * a capture of a few months of a board ten years long is otherwise
   * thousands of identical files. The server answers for it with `blankTile`.
   */
  blank: number;
}

const LAYERS: Record<LayerName, Layer> = {
  base: {
    palette: [
      { hex: '#000000', alpha: 0 },
      { hex: MISSING_HEX, alpha: 255 },
    ],
    blank: IN_RANGE,
  },
  present: {
    palette: Array.from({ length: ALL_PRESENT + 1 }, (_, alpha) => ({
      hex: PRESENT_HEX,
      alpha,
    })),
    blank: CLEAR,
  },
};

/** A block with `present` of its posts held; never 0 when any are. */
const opacity = (present: number, of: number): number =>
  present === 0 ? CLEAR : Math.max(1, Math.round((present / of) * ALL_PRESENT));

/**
 * The tile every unwritten one in `layer` stands for. The page only asks for
 * tiles inside the grid, so a missing base tile there is always one wholly in
 * range, never one past its end.
 */
export const blankTile: Record<LayerName, Buffer> = {
  base: encodeIndexedPng(
    TILE,
    TILE,
    new Uint8Array(TILE * TILE).fill(LAYERS.base.blank),
    LAYERS.base.palette
  ),
  present: encodeIndexedPng(
    TILE,
    TILE,
    new Uint8Array(TILE * TILE).fill(LAYERS.present.blank),
    LAYERS.present.palette
  ),
};

export interface MapLayout {
  first: number;
  last: number;
  rowWidth: number;
  gridRows: number;
}

/** Defaults to whole tiles making the grid roughly square. */
export const layout = (
  first: number,
  last: number,
  rowWidth?: number
): MapLayout => {
  const cells = last - first + 1;
  const w = rowWidth ?? Math.ceil(Math.sqrt(cells) / TILE) * TILE;
  return { first, last, rowWidth: w, gridRows: Math.ceil(cells / w) };
};

export interface RenderResult {
  present: number;
  /** Tiles per layer, written or not, across every level. */
  tiles: number;
  /** Tiles written, per layer; the rest are that layer's blank tile. */
  written: Record<LayerName, number>;
}

/**
 * Writes both layers' tiles for one map into `dir`/<layer>/: the native
 * level at a pixel per post, and each of `lowZooms` shaded by the fraction of
 * its block present.
 */
export const renderMap = (
  bits: Uint8Array,
  { first, last, rowWidth, gridRows }: MapLayout,
  lowZooms: readonly number[],
  dir: string
): RenderResult => {
  const cells = last - first + 1;
  const result: RenderResult = {
    present: 0,
    tiles: 0,
    written: { base: 0, present: 0 },
  };

  /**
   * Writes one zoom level of one layer, `w` x `h` pixels across, asking
   * `pixel` for each palette index.
   */
  const writeLevel = (
    name: LayerName,
    zoom: number,
    w: number,
    h: number,
    pixel: (x: number, y: number) => number
  ): void => {
    const { palette, blank } = LAYERS[name];
    const tilesX = Math.ceil(w / TILE);
    const tilesY = Math.ceil(h / TILE);
    const levelDir = join(dir, name, String(zoom));
    const made = new Set<number>();
    const px = new Uint8Array(TILE * TILE);
    for (let ty = 0; ty < tilesY; ty++) {
      for (let tx = 0; tx < tilesX; tx++) {
        let any = false;
        for (let y = 0; y < TILE; y++) {
          const py = ty * TILE + y;
          for (let x = 0; x < TILE; x++) {
            const pxX = tx * TILE + x;
            const v = pxX < w && py < h ? pixel(pxX, py) : CLEAR;
            px[y * TILE + x] = v;
            any ||= v !== blank;
          }
        }
        if (name === 'base') {
          result.tiles++;
        }
        if (!any) {
          continue;
        }
        if (!made.has(tx)) {
          mkdirSync(join(levelDir, String(tx)), { recursive: true });
          made.add(tx);
        }
        writeFileSync(
          join(levelDir, String(tx), `${ty}.png`),
          encodeIndexedPng(TILE, TILE, px, palette)
        );
        result.written[name]++;
      }
    }
  };

  writeLevel('base', NATIVE_ZOOM, rowWidth, gridRows, (col, row) =>
    row * rowWidth + col < cells ? IN_RANGE : CLEAR
  );
  writeLevel('present', NATIVE_ZOOM, rowWidth, gridRows, (col, row) => {
    const cell = row * rowWidth + col;
    if (cell < cells && hasPost(bits, first + cell)) {
      result.present++;
      return ALL_PRESENT;
    }
    return CLEAR;
  });
  /**
   * How many in-range post numbers the k x k block at (bx, by) covers.
   * Worked out from the grid's shape rather than counted: every row is full
   * but the last, which holds `tail` cells.
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

  const zooms = [...new Set(lowZooms)].sort((a, b) => b - a);
  if (zooms.length > 0) {
    // Present posts per block at the finest low level, counted from the set
    // bits directly; each coarser level is then 2x2 sums of the one above.
    let zoom = zooms[0]!;
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
      if (zooms.includes(zoom)) {
        const [c, cw, kk] = [counts, w, k];
        writeLevel('base', zoom, w, h, (x, y) =>
          inRange(x, y, kk) > 0 ? IN_RANGE : CLEAR
        );
        writeLevel('present', zoom, w, h, (x, y) =>
          opacity(c[y * cw + x]!, inRange(x, y, kk))
        );
      }
      if (zoom === zooms[zooms.length - 1]) {
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
  return result;
};
