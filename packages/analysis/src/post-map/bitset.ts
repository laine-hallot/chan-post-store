import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Which post numbers one source holds for one board: bit n is set when the
 * staged files contain post n. A board's numbers run into the hundreds of
 * millions, so this is the only shape that is both exact and small -- ~12MB
 * per hundred million post numbers before compression.
 */
export interface PostBitset {
  source: string;
  site: string;
  board: string;
  /** Rows the readers offered for the board, duplicates included. */
  rows: number;
  /** The highest post number seen, or -1 when the board has none. */
  maxNo: number;
  /** Bit n of byte n >> 3, least significant first. */
  bits: Uint8Array;
}

/**
 * Bumped whenever the encoding changes, so a stale cache is not misread.
 * 2: one scan holds every board it read, not just one.
 */
export const BITSET_FORMAT = 2;

export class BitsetBuilder {
  #bits = new Uint8Array(1 << 10);
  rows = 0;
  maxNo = -1;

  add(postNo: number): void {
    this.rows++;
    const byte = postNo >> 3;
    if (byte >= this.#bits.length) {
      // Doubling, so a board in the hundreds of millions grows a few dozen
      // times rather than once per new maximum.
      let size = this.#bits.length;
      while (size <= byte) {
        size *= 2;
      }
      const grown = new Uint8Array(size);
      grown.set(this.#bits);
      this.#bits = grown;
    }
    this.#bits[byte]! |= 1 << (postNo & 7);
    if (postNo > this.maxNo) {
      this.maxNo = postNo;
    }
  }

  /** Trimmed to the highest post seen. */
  bits(): Uint8Array {
    return this.#bits.subarray(0, (this.maxNo >> 3) + 1);
  }
}

/**
 * Every board of one scan, gzipped together: a count, then for each board a
 * length-prefixed JSON header and its raw bits. Post numbers are dense enough
 * that gzip is not the point; the runs of zeroes before a capture starts and
 * across its outages are.
 */
export const encodeScan = (boards: PostBitset[]): Buffer => {
  const parts: Uint8Array[] = [u32(boards.length)];
  for (const { bits, ...meta } of boards) {
    const header = Buffer.from(
      JSON.stringify({ format: BITSET_FORMAT, bytes: bits.length, ...meta })
    );
    parts.push(u32(header.length), header, bits);
  }
  return gzipSync(Buffer.concat(parts), { level: 6 });
};

export const decodeScan = (buf: Buffer): PostBitset[] => {
  const raw = gunzipSync(buf);
  const count = raw.readUInt32LE(0);
  let at = 4;
  const out: PostBitset[] = [];
  for (let i = 0; i < count; i++) {
    const len = raw.readUInt32LE(at);
    const meta = JSON.parse(
      raw.subarray(at + 4, at + 4 + len).toString('utf8')
    ) as Omit<PostBitset, 'bits'> & { format: number; bytes: number };
    if (meta.format !== BITSET_FORMAT) {
      throw new Error(
        `bitset format ${meta.format}, expected ${BITSET_FORMAT}; rescan`
      );
    }
    at += 4 + len;
    const { format: _, bytes, ...rest } = meta;
    out.push({ ...rest, bits: new Uint8Array(raw.subarray(at, at + bytes)) });
    at += bytes;
  }
  return out;
};

const u32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

export const hasPost = (bits: Uint8Array, n: number): boolean =>
  n >= 0 && ((bits[n >> 3] ?? 0) & (1 << (n & 7))) !== 0;
