import { crc32, deflateSync } from 'node:zlib';

/**
 * Just enough PNG for map tiles: 8-bit indexed colour, no filtering. A tile
 * holds three or four distinct values in long runs, which deflate handles
 * without help, and a hand-rolled encoder is smaller than the dependency.
 */

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const chunk = (type: string, data: Buffer): Buffer => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** An `#rrggbb` colour and its opacity, 0-255. */
export interface PaletteEntry {
  hex: string;
  alpha: number;
}

/** `pixels` is `width * height` palette indices, row by row. */
export const encodeIndexedPng = (
  width: number,
  height: number,
  pixels: Uint8Array,
  palette: PaletteEntry[]
): Buffer => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // colour type: indexed
  // compression, filter and interlace methods all 0

  const plte = Buffer.alloc(palette.length * 3);
  palette.forEach(({ hex }, i) => {
    plte.writeUIntBE(parseInt(hex.slice(1), 16), i * 3, 3);
  });
  const trns = Buffer.from(palette.map((p) => p.alpha));

  // Each scanline is prefixed with its filter type, 0 (none).
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
};
