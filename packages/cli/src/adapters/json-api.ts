import { existsSync, opendirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { stripHtml } from "../html.ts";
import { PostInserter } from "../ingest.ts";

/**
 * Ingests thread dumps in the 4chan JSON read API format
 * (https://github.com/4chan/4chan-API): a `{ posts: [...] }` object per
 * thread. Handles the layouts seen in the archives, flat or nested,
 * with or without a board prefix in the filename:
 *   <root>/<board>/[<board> ]<threadno>.(json|txt)
 *   <root>/<board>/[<board> ]<threadno>/<same>.(json|txt)
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

function* threadFiles(
  boardDir: string,
  board: string,
): Generator<{ path: string; threadNo: number }> {
  const filePat = new RegExp(`^(?:${board} )?(\\d+)\\.(?:json|txt)$`);
  const dirPat = new RegExp(`^(?:${board} )?(\\d+)$`);
  const dir = opendirSync(boardDir);
  try {
    let entry;
    while ((entry = dir.readSync()) !== null) {
      const path = join(boardDir, entry.name);
      if (entry.isDirectory()) {
        const m = dirPat.exec(entry.name);
        if (!m) continue;
        for (const ext of [".json", ".txt"]) {
          const nested = join(path, entry.name + ext);
          if (existsSync(nested)) {
            yield { path: nested, threadNo: Number(m[1]) };
            break;
          }
        }
      } else if (entry.isFile()) {
        const m = filePat.exec(entry.name);
        if (m) yield { path, threadNo: Number(m[1]) };
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
  const inserter = new PostInserter(db, opts.sourceId);

  const stats: IngestStats = { threads: 0, posts: 0, skippedPosts: 0, badFiles: 0 };
  const BATCH = 500;

  for (const board of listBoards(opts.root, opts.boards)) {
    const boardDir = join(opts.root, board);
    let inTx = 0;
    db.exec("BEGIN");
    try {
      for (const { path: file, threadNo } of threadFiles(boardDir, board)) {
        let posts: ApiPost[];
        try {
          const parsed = JSON.parse(readFileSync(file, "utf8"));
          posts = parsed.posts;
          if (!Array.isArray(posts)) throw new Error("no posts array");
        } catch {
          stats.badFiles++;
          continue;
        }

        for (const p of posts) {
          if (typeof p.no !== "number") {
            stats.skippedPosts++;
            continue;
          }
          const ok = inserter.insert({
            site: opts.site,
            board,
            threadNo,
            postNo: p.no,
            isOp: p.resto === 0 || p.no === threadNo,
            tsUtc: p.time ?? null,
            name: p.name ?? null,
            tripcode: p.trip ?? null,
            subject: p.sub ? stripHtml(p.sub) : null,
            bodyText: p.com ? stripHtml(p.com) : null,
            mediaFilename: p.filename != null ? `${p.filename}${p.ext ?? ""}` : null,
            mediaMd5: p.md5 ?? null,
          });
          if (ok) stats.posts++;
          else stats.skippedPosts++;
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
  // Fold this run's tallies into post_stats before reporting.
  inserter.finish();
  return stats;
}
