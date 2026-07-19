import type { DatabaseSync, StatementSync } from "node:sqlite";

export interface PostRow {
  site: string;
  board: string;
  threadNo: number;
  postNo: number;
  isOp: boolean;
  tsUtc: number | null;
  name: string | null;
  tripcode: string | null;
  subject: string | null;
  bodyText: string | null;
  mediaFilename: string | null;
  mediaMd5: string | null;
}

/** Writes normalized posts into `posts` + `posts_fts`, skipping ones the
 * source has already contributed. */
export class PostInserter {
  #post: StatementSync;
  #fts: StatementSync;
  #sourceId: number;

  constructor(db: DatabaseSync, sourceId: number) {
    this.#sourceId = sourceId;
    this.#post = db.prepare(`
      INSERT INTO posts (
        source_id, site, board, thread_no, post_no, is_op, ts_utc,
        name, tripcode, subject, body_text, media_filename, media_md5
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (source_id, site, board, post_no) DO NOTHING
      RETURNING id
    `);
    this.#fts = db.prepare(
      "INSERT INTO posts_fts (rowid, subject, body_text) VALUES (?, ?, ?)",
    );
  }

  /** Returns true if the post was new, false if this source already had it. */
  insert(p: PostRow): boolean {
    const row = this.#post.get(
      this.#sourceId,
      p.site,
      p.board,
      p.threadNo,
      p.postNo,
      p.isOp ? 1 : 0,
      p.tsUtc,
      p.name,
      p.tripcode,
      p.subject,
      p.bodyText,
      p.mediaFilename,
      p.mediaMd5,
    ) as { id: number } | undefined;
    if (!row) return false;
    this.#fts.run(row.id, p.subject, p.bodyText);
    return true;
  }
}
