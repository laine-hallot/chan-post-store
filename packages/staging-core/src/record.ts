import { createWriteStream, mkdirSync } from 'node:fs';
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
 * Writes records into one file per board, opening each on first use.
 *
 * One file per board because that is the staged layout, and because a future
 * board filter then means simply not writing the other files.
 *
 * Records are written with `JSON.stringify` + "\n". Note that this leaves
 * U+2028 RAW in the output -- `JSON.stringify` escapes \n and \r but not the
 * Unicode line separators -- so the framing is only safe against a reader
 * that splits on "\n" alone. See `readLines`.
 */
export class NdjsonWriter {
  #root: string;
  #open = new Map<string, ReturnType<typeof createWriteStream>>();
  /** Counted separately from #open, which close() empties. */
  #boards = 0;
  written = 0;

  constructor(root: string) {
    this.#root = root;
  }

  write(post: NdjsonPost): void {
    let w = this.#open.get(post.board);
    if (!w) {
      mkdirSync(join(this.#root, post.board), { recursive: true });
      w = createWriteStream(join(this.#root, post.board, 'posts.ndjson'));
      this.#open.set(post.board, w);
      this.#boards++;
    }
    w.write(JSON.stringify(post) + '\n');
    this.written++;
  }

  /** Distinct boards written, still meaningful after close(). */
  get boards(): number {
    return this.#boards;
  }

  /** Flush and close every open file; the caller must await this. */
  async close(): Promise<void> {
    await Promise.all(
      [...this.#open.values()].map(
        (w) =>
          new Promise<void>((res, rej) => {
            w.end((err?: Error | null) => (err ? rej(err) : res()));
          })
      )
    );
    this.#open.clear();
  }
}
