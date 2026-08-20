import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One post in the standard staged NDJSON layout, `<board>/posts.ndjson`.
 *
 * Asagi field names, so the sql and json ingest cases share one vocabulary
 * and a staged tree stays meaningful without the code that wrote it.
 *
 * **`timestamp` is TRUE UTC here**, where the SQL case is America/New_York
 * wall time. That is the one place the two halves of the standard format
 * deliberately differ, and it cannot be inferred from the data: the same
 * producer ships both conventions -- Desuarchive's 2019 mysqldump exports are
 * NY wall time while its NDJSON export is UTC. Converting is the writer's
 * job, so the reader never has to know which archive a record came from.
 */
export interface NdjsonPost {
  site: string;
  board: string;
  num: number;
  subnum: number;
  thread_num: number;
  op: 0 | 1;
  timestamp: number | null;
  name: string | null;
  trip: string | null;
  title: string | null;
  comment: string | null;
  media_filename: string | null;
  media_hash: string | null;
}

/**
 * Writes records into one file per board, holding only a few open at a time.
 *
 * One file per board because that is the staged layout, and because a future
 * board filter then means simply not writing the other files.
 *
 * **Open handles are capped, and that is not a micro-optimisation.** The
 * first version kept a `WriteStream` per board open for the whole run and
 * closed them all at the end. That worked up to 66 boards and failed at 67:
 * `4chan-threads` wrote every one of its 67 boards and then died in `close()`
 * with `writev failed` and an unmapped errno, twice, at exactly the same
 * point -- 67 buffered FUSE handles flushing at once is more than shfs will
 * take. The failure is at the END, so the data looks complete right up until
 * the tails are lost.
 *
 * So: at most OPEN_CAP file descriptors, least-recently-used evicted, and a
 * board reopened in append mode. Plain descriptors with an explicit buffer
 * rather than streams, so eviction is synchronous and there is no queue of
 * pending closes to go wrong.
 *
 * Records are written with `JSON.stringify` + "\n". Note that this leaves
 * U+2028 RAW in the output -- `JSON.stringify` escapes \n and \r but not the
 * Unicode line separators -- so the framing is only safe against a reader
 * that splits on "\n" alone. See `readLines`.
 */
/** Descriptors held at once. Well under any FUSE or ulimit ceiling. */
const OPEN_CAP = 8;

/** Bytes buffered per board before a write syscall. */
const BUFFER_BYTES = 1 << 22;

export class NdjsonWriter {
  #root: string;
  /** board -> open descriptor and pending text. Insertion order is the LRU. */
  #open = new Map<string, { fd: number; buf: string; bytes: number }>();
  /** Boards written before, so a reopen appends rather than truncating. */
  #seen = new Set<string>();
  written = 0;

  constructor(root: string) {
    this.#root = root;
  }

  #fileFor(board: string): { fd: number; buf: string; bytes: number } {
    const held = this.#open.get(board);
    if (held) {
      // Refresh its place in the LRU.
      this.#open.delete(board);
      this.#open.set(board, held);
      return held;
    }
    if (this.#open.size >= OPEN_CAP) {
      const oldest = this.#open.keys().next().value as string;
      this.#closeOne(oldest);
    }
    mkdirSync(join(this.#root, board), { recursive: true });
    const fd = openSync(
      join(this.#root, board, 'posts.ndjson'),
      this.#seen.has(board) ? 'a' : 'w'
    );
    this.#seen.add(board);
    const entry = { fd, buf: '', bytes: 0 };
    this.#open.set(board, entry);
    return entry;
  }

  #closeOne(board: string): void {
    const e = this.#open.get(board);
    if (!e) {
      return;
    }
    if (e.buf.length > 0) {
      writeSync(e.fd, e.buf);
    }
    closeSync(e.fd);
    this.#open.delete(board);
  }

  write(post: NdjsonPost): void {
    const e = this.#fileFor(post.board);
    const line = JSON.stringify(post) + '\n';
    e.buf += line;
    e.bytes += line.length;
    if (e.bytes >= BUFFER_BYTES) {
      writeSync(e.fd, e.buf);
      e.buf = '';
      e.bytes = 0;
    }
    this.written++;
  }

  /** Distinct boards written, still meaningful after close(). */
  get boards(): number {
    return this.#seen.size;
  }

  /** Flush and close everything still open. */
  async close(): Promise<void> {
    for (const board of [...this.#open.keys()]) {
      this.#closeOne(board);
    }
  }
}
