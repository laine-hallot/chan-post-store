/**
 * Post number -> timestamp, summarised in bounded memory.
 *
 * The readers hand rows over one at a time and a board can be tens of
 * millions of them, so the span of post numbers is not known until the last
 * row -- which rules out choosing a bucket width up front. Instead buckets
 * start one post number wide and double whenever there are more than twice
 * as many as asked for, merging neighbours pairwise. Every field is a count,
 * a min or a max, so merging is exact: the result is the same as if the
 * final width had been chosen before the first row.
 *
 * Doubling from 1 means the final width is a power of two and the bucket
 * count lands between `target` and `2 * target`.
 */

/** One bucket as it crosses the wire: plain numbers, JSON-safe. */
export interface Bucket {
  /** Lowest and highest post number actually seen in the bucket. */
  firstNo: number;
  lastNo: number;
  posts: number;
  /** Posts carrying a timestamp; `posts - dated` were undated. */
  dated: number;
  /** Unix seconds, UTC. Null when every post in the bucket is undated. */
  earliest: number | null;
  latest: number | null;
}

/** What the scan writes and the chart reads. */
export interface ScanResult {
  source: string;
  site: string;
  board: string;
  /** Post numbers per bucket; a power of two. */
  width: number;
  /** Ordered by post number. */
  buckets: Bucket[];
}

export class PostDateHistogram {
  #target: number;
  #width = 1;
  #buckets = new Map<number, Bucket>();

  constructor(target: number) {
    this.#target = target;
  }

  add(postNo: number, tsUtc: number | null): void {
    const key = Math.floor(postNo / this.#width);
    const b = this.#buckets.get(key);
    if (b === undefined) {
      this.#buckets.set(key, {
        firstNo: postNo,
        lastNo: postNo,
        posts: 1,
        dated: tsUtc === null ? 0 : 1,
        earliest: tsUtc,
        latest: tsUtc,
      });
      if (this.#buckets.size > 2 * this.#target) {
        this.#coarsen();
      }
      return;
    }
    merge(b, {
      firstNo: postNo,
      lastNo: postNo,
      posts: 1,
      dated: tsUtc === null ? 0 : 1,
      earliest: tsUtc,
      latest: tsUtc,
    });
  }

  get width(): number {
    return this.#width;
  }

  buckets(): Bucket[] {
    return [...this.#buckets.values()].sort((a, b) => a.firstNo - b.firstNo);
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

/** Min/max where null means "no timestamp" and loses to any number. */
const pick =
  (f: (a: number, b: number) => number) =>
  (a: number | null, b: number | null): number | null => {
    if (a === null || b === null) {
      return a ?? b;
    }
    return f(a, b);
  };
const minOf = pick(Math.min);
const maxOf = pick(Math.max);

/** Folds `from` into `into`. */
const merge = (into: Bucket, from: Bucket): void => {
  into.firstNo = Math.min(into.firstNo, from.firstNo);
  into.lastNo = Math.max(into.lastNo, from.lastNo);
  into.posts += from.posts;
  into.dated += from.dated;
  into.earliest = minOf(into.earliest, from.earliest);
  into.latest = maxOf(into.latest, from.latest);
};
