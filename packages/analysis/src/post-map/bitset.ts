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

/** Bumped whenever the encoding changes, so a stale cache is not misread. */
export const BITSET_FORMAT = 1;

export class BitsetBuilder {
  #bits = new Uint8Array(1 << 20);
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
 * A length-prefixed JSON header and the raw bits, gzipped together. Post
 * numbers are dense enough that gzip is not the point; the runs of zeroes
 * before a capture starts and across its outages are.
 */
export const encodeBitset = (b: PostBitset): Buffer => {
  const { bits, ...meta } = b;
  const header = Buffer.from(
    JSON.stringify({ format: BITSET_FORMAT, ...meta })
  );
  const len = Buffer.alloc(4);
  len.writeUInt32LE(header.length);
  return gzipSync(Buffer.concat([len, header, bits]), { level: 6 });
};

export const decodeBitset = (buf: Buffer): PostBitset => {
  const raw = gunzipSync(buf);
  const len = raw.readUInt32LE(0);
  const meta = JSON.parse(raw.subarray(4, 4 + len).toString('utf8')) as Omit<
    PostBitset,
    'bits'
  > & { format: number };
  if (meta.format !== BITSET_FORMAT) {
    throw new Error(
      `bitset format ${meta.format}, expected ${BITSET_FORMAT}; rescan`
    );
  }
  const { format: _, ...rest } = meta;
  return { ...rest, bits: new Uint8Array(raw.subarray(4 + len)) };
};

export const hasPost = (bits: Uint8Array, n: number): boolean =>
  n >= 0 && ((bits[n >> 3] ?? 0) & (1 << (n & 7))) !== 0;
