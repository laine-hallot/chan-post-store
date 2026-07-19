import { opendirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { stripHtml } from "../html.ts";

/**
 * Ingests thread dumps in the 4chan JSON read API format
 * (https://github.com/4chan/4chan-API): a `{ posts: [...] }` object per
 * thread, stored as `<root>/<board>/<threadno>.json` or
 * `<root>/<board>/<threadno>/<threadno>.json`.
 */

interface ApiPost {
  no: number;
  resto?: number;
  time?: number;
  name?: string;
  trip?: string;
  sub?: string;
  com?: string;
  filename?: string;
  ext?: string;
  md5?: string;
}

interface IngestStats {
  threads: number;
  posts: number;
  skippedPosts: number;
  badFiles: number;
}

function* threadFiles(boardDir: string): Generator<string> {
  const dir = opendirSync(boardDir);
  try {
    let entry;
    while ((entry = dir.readSync()) !== null) {
      const path = join(boardDir, entry.name);
      if (entry.isDirectory() && /^\d+$/.test(entry.name)) {
        const nested = join(path, `${entry.name}.json`);
        yield nested;
      } else if (entry.isFile() && /^\d+\.json$/.test(entry.name)) {
        yield path;
      }
    }
  } finally {
    dir.closeSync();
  }
}

function listBoards(root: string, only?: string[]): string[] {
  const boards: string[] = [];
  const dir = opendirSync(root);
  try {
    let entry;
    while ((entry = dir.readSync()) !== null) {
      if (!entry.isDirectory()) continue;
      if (only && !only.includes(entry.name)) continue;
      boards.push(entry.name);
    }
  } finally {
    dir.closeSync();
  }
  return boards.sort();
}

export function ingestJsonApi(
  db: DatabaseSync,
  opts: { root: string; sourceId: number; site: string; boards?: string[] },
): IngestStats {
  const insertPost = db.prepare(`
    INSERT INTO posts (
      source_id, site, board, thread_no, post_no, is_op, ts_utc,
      name, tripcode, subject, body_text, media_filename, media_md5
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (source_id, site, board, post_no) DO NOTHING
    RETURNING id
  `);
  const insertFts = db.prepare(
    "INSERT INTO posts_fts (rowid, subject, body_text) VALUES (?, ?, ?)",
  );

  const stats: IngestStats = { threads: 0, posts: 0, skippedPosts: 0, badFiles: 0 };
  const BATCH = 500;

  for (const board of listBoards(opts.root, opts.boards)) {
    const boardDir = join(opts.root, board);
    let inTx = 0;
    db.exec("BEGIN");
    try {
      for (const file of threadFiles(boardDir)) {
        let posts: ApiPost[];
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8"));
          posts = parsed.posts;
          if (!Array.isArray(posts)) throw new Error("no posts array");
        } catch {
          stats.badFiles++;
          continue;
        }

        const threadNo = Number(basename(file).replace(/\.json$/, ""));
        for (const p of posts) {
          if (typeof p.no !== "number") {
            stats.skippedPosts++;
            continue;
          }
          const subject = p.sub ? stripHtml(p.sub) : null;
          const body = p.com ? stripHtml(p.com) : null;
          const row = insertPost.get(
            opts.sourceId,
            opts.site,
            board,
            threadNo,
            p.no,
            p.resto === 0 || p.no === threadNo ? 1 : 0,
            p.time ?? null,
            p.name ?? null,
            p.trip ?? null,
            subject,
            body,
            p.filename != null ? `${p.filename}${p.ext ?? ""}` : null,
            p.md5 ?? null,
          ) as { id: number } | undefined;
          if (row) {
            insertFts.run(row.id, subject, body);
            stats.posts++;
          } else {
            stats.skippedPosts++;
          }
        }

        stats.threads++;
        if (++inTx >= BATCH) {
          db.exec("COMMIT");
          db.exec("BEGIN");
          inTx = 0;
          process.stderr.write(
            `\r/${board}/ threads=${stats.threads} posts=${stats.posts}`,
          );
        }
      }
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    process.stderr.write(
      `\r/${board}/ threads=${stats.threads} posts=${stats.posts}\n`,
    );
  }
  return stats;
}
