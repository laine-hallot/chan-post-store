/**
 * Timestamp -> post number, summarised in bounded memory.
 *
 * Buckets are slices of TIME, so points on the chart are evenly spaced along
 * the date axis whatever the board's posting rate: a slow year is as wide as
 * a busy one, rather than being squeezed into a few buckets because it used
 * few post numbers.
 *
 * The readers hand rows over one at a time and a board can be tens of
 * millions of them, so the span of dates is not known until the last row --
 * which rules out choosing a bucket width up front. Instead buckets start
 * one second wide and double whenever there are more than twice as many as
 * asked for, merging neighbours pairwise. Every field is a count, a min or a
 * max, so merging is exact: the result is the same as if the final width had
 * been chosen before the first row.
 *
 * Doubling from 1 means the final width is a power of two seconds and the
 * bucket count lands between `target` and `2 * target`.
 *
 * A fixed width can be asked for instead (`--bucket-days`), in which case
 * nothing is ever merged and the bucket count is whatever the data makes it.
 *
 * Buckets are aligned to an ORIGIN -- the epoch, or the start of the range
 * being charted -- which every source in one chart shares. That is what lets
 * `coarsenTo` bring two sources' buckets to one width exactly.
 */

/**
 * Bumped whenever what a scan writes changes meaning, so a cached scan from
 * an older bundle is never read back as the current shape.
 */
export const SCAN_FORMAT = 4;

/** One bucket as it crosses the wire: plain numbers, JSON-safe. */
export interface Bucket {
  /** Earliest and latest timestamp actually seen, Unix seconds UTC. */
  firstTs: number;
  lastTs: number;
  posts: number;
  /** Lowest and highest post number in the bucket. */
  lowNo: number;
  highNo: number;
}

/** What the scan writes and the chart reads. */
export interface ScanResult {
  source: string;
  site: string;
  board: string;
  /** Seconds per bucket: a power of two, or exactly what was asked for. */
  width: number;
  /** Unix seconds every bucket boundary is a whole number of widths from. */
  origin: number;
  /** Ordered by time. */
  buckets: Bucket[];
  /**
   * Posts with no timestamp. Over the whole board they are ALSO in
   * `buckets`, filed at Unix time 0: a chart that quietly leaves them out
   * looks healthy, where a column of points at 1970 cannot be missed. A scan
   * limited to a date range counts them but files them nowhere, since a range
   * is a request to look closely at something else.
   */
  undated: number;
}

export class PostDateHistogram {
  #target: number;
  #width: number;
  #fixed: boolean;
  #origin: number;
  #buckets = new Map<number, Bucket>();

  constructor(target: number, origin: number, width?: number) {
    this.#target = target;
    this.#origin = origin;
    this.#fixed = width !== undefined;
    this.#width = width ?? 1;
  }

  add(postNo: number, tsUtc: number): void {
    const one: Bucket = {
      firstTs: tsUtc,
      lastTs: tsUtc,
      posts: 1,
      lowNo: postNo,
      highNo: postNo,
    };
    const key = Math.floor((tsUtc - this.#origin) / this.#width);
    const b = this.#buckets.get(key);
    if (b !== undefined) {
      merge(b, one);
      return;
    }
    this.#buckets.set(key, one);
    if (!this.#fixed && this.#buckets.size > 2 * this.#target) {
      this.#coarsen();
    }
  }

  get width(): number {
    return this.#width;
  }

  get origin(): number {
    return this.#origin;
  }

  buckets(): Bucket[] {
    return [...this.#buckets.values()].sort((a, b) => a.firstTs - b.firstTs);
  }

  /** Doubles the width, merging each even bucket with its odd neighbour. */
  #coarsen(): void {
    const next = new Map<number, Bucket>();
    for (const [key, b] of this.#buckets) {
      const k = Math.floor(key / 2);
      const into = next.get(k);
      if (into === undefined) {
        next.set(k, b);
      } else {
        merge(into, b);
      }
    }
    this.#buckets = next;
    this.#width *= 2;
  }
}

/**
 * The same scan at a coarser width. The width must be a whole multiple of the
 * scan's -- automatic widths are powers of two, so the coarsest of a group
 * always is -- and buckets share an origin, so a coarse bucket is exactly
 * the union of the fine ones inside it and the merge loses nothing a scan at
 * the coarse width would have kept.
 */
export const coarsenTo = (r: ScanResult, width: number): ScanResult => {
  if (width === r.width) {
    return r;
  }
  if (width < r.width || width % r.width !== 0) {
    throw new Error(`cannot coarsen ${r.width}s buckets to ${width}s`);
  }
  const next = new Map<number, Bucket>();
  for (const b of r.buckets) {
    const k = Math.floor((b.firstTs - r.origin) / width);
    const into = next.get(k);
    if (into === undefined) {
      next.set(k, { ...b });
    } else {
      merge(into, b);
    }
  }
  return {
    ...r,
    width,
    buckets: [...next.values()].sort((a, b) => a.firstTs - b.firstTs),
  };
};

/** Folds `from` into `into`. */
const merge = (into: Bucket, from: Bucket): void => {
  into.firstTs = Math.min(into.firstTs, from.firstTs);
  into.lastTs = Math.max(into.lastTs, from.lastTs);
  into.posts += from.posts;
  into.lowNo = Math.min(into.lowNo, from.lowNo);
  into.highNo = Math.max(into.highNo, from.highNo);
};
