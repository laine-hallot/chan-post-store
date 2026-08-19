import { nyWallToUtc } from 'staging-core';

export interface Dialect {
  name: string;
  /** Columns that must all be present for this dialect to match. */
  threadCols: string[];
  postCols: string[];
  threads: { key: string; threadNo: string; board?: string; url?: string };
  posts: {
    threadRef: string;
    postNo: string;
    date: string;
    body: string;
    name?: string;
    trip?: string;
    subject?: string;
    media?: string;
  };
}

export const DIALECTS: Dialect[] = [
  {
    name: 'chanarchive',
    threadCols: ['threadid', 'threadurl', 'number'],
    postCols: ['commentid', 'threadid', 'number', 'postdate', 'body'],
    threads: { key: 'threadid', threadNo: 'number', url: 'threadurl' },
    posts: {
      threadRef: 'threadid',
      postNo: 'number',
      date: 'postdate',
      body: 'body',
      name: 'name',
      trip: 'tripcode',
      subject: 'subject',
    },
  },
  {
    name: '4archive',
    threadCols: ['id', 'thread_id', 'board'],
    postCols: ['id', 'chan_id', 'threads_id', 'chan_post_date', 'body'],
    threads: { key: 'id', threadNo: 'thread_id', board: 'board' },
    posts: {
      threadRef: 'threads_id',
      postNo: 'chan_id',
      date: 'chan_post_date',
      body: 'body',
      name: 'name',
      trip: 'tripcode',
      subject: 'subject',
      media: 'original_image_name',
    },
  },
];

/**
 * 'YYYY-MM-DD HH:MM:SS' as New-York wall time, in epoch seconds.
 * Returns null for MySQL's zero date and anything unparseable.
 */
export const parseDateTime = (s: string | null): number | null => {
  if (!s) {
    return null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m) {
    return null;
  }
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y === 0) {
    return null;
  } // '0000-00-00 00:00:00'
  const wall = Date.UTC(y, mo - 1, d, h, mi, se) / 1000;
  return Number.isFinite(wall) ? nyWallToUtc(wall) : null;
};

/**
 * Board and site from a chanarchive thread URL.
 * 'http://orz.4chan.org/d/res/177990.html' -> { board: 'd', site: '4chan' }
 *
 * 4chan served this era from several hostnames -- img, cgi, orz and zip, all
 * under 4chan.org -- which MUST collapse to the single site "4chan", or its
 * posts stop deduplicating against every other source in the store.
 *
 * Everything else keeps its full hostname. The obvious shortcut, taking the
 * second-level domain, is wrong: orly.yi.org was an early imageboard hosted on
 * the yi.org dynamic-DNS service, so that rule labels it "yi" after the DNS
 * provider and would silently merge it with any other yi.org board. Since
 * UNIQUE (site, board, post_no) means a wrong site label lets unrelated boards
 * collide and displace each other, the safe default is to never merge hosts
 * that have not been shown to be the same site.
 */
export const fromUrl = (
  url: string | null
): { board: string; site: string } | null => {
  if (!url) {
    return null;
  }
  const m = /^[a-z]+:\/\/([^/]+)\/([^/]+)\//i.exec(url);
  if (!m) {
    return null;
  }
  const host = m[1].toLowerCase();
  const site =
    host === '4chan.org' || host.endsWith('.4chan.org') ? '4chan' : host;
  return { board: m[2], site };
};

/**
 * Growable typed-array store for the thread index.
 *
 * Typed arrays indexed by the local AUTO_INCREMENT id, not a Map: both dumps
 * use dense keys and chanarchive reaches 10,849,597 threads, where a Map of
 * that many number->object entries costs hundreds of MB against ~54MB here.
 *
 * (site, board) labels are interned, so the pair is stored once however many
 * threads share it.
 */
export class ThreadIndex {
  #no = new Uint32Array(1 << 20);
  #key = new Uint16Array(1 << 20);
  #names: string[] = [];
  #byName = new Map<string, number>();
  max = 0;

  #grow(need: number): void {
    if (need < this.#no.length) {
      return;
    }
    let n = this.#no.length;
    while (n <= need) {
      n *= 2;
    }
    const no = new Uint32Array(n);
    no.set(this.#no);
    const key = new Uint16Array(n);
    key.set(this.#key);
    this.#no = no;
    this.#key = key;
  }

  set(id: number, threadNo: number, board: string, site: string): void {
    this.#grow(id);
    const label = `${site}\0${board}`;
    let k = this.#byName.get(label);
    if (k === undefined) {
      k = this.#names.length;
      this.#names.push(label);
      this.#byName.set(label, k);
    }
    this.#no[id] = threadNo;
    this.#key[id] = k;
    if (id > this.max) {
      this.max = id;
    }
  }

  get(id: number): {
    threadNo: number;
    board: string;
    site: string;
  } | null {
    if (id <= 0 || id >= this.#no.length || this.#no[id] === 0) {
      return null;
    }
    const k = this.#key[id];
    const [site, board] = this.#names[k].split('\0');
    return { threadNo: this.#no[id], board, site };
  }
}
