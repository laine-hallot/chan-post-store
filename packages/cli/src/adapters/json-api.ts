import type { Pool } from 'pg';

import { existsSync, opendirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeBoardFilter } from '../boards.ts';
import { stripHtml } from '../html.ts';
import { collectPending, PostInserter } from '../ingest.ts';
import { makeBar } from '../progress.ts';

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

const threadFiles = function* (
  boardDir: string,
  board: string
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
        if (!m) {
          continue;
        }
        for (const ext of ['.json', '.txt']) {
          const nested = join(path, entry.name + ext);
          if (existsSync(nested)) {
            yield { path: nested, threadNo: Number(m[1]) };
            break;
          }
        }
      } else if (entry.isFile()) {
        const m = filePat.exec(entry.name);
        if (m) {
          yield { path, threadNo: Number(m[1]) };
        }
      }
    }
  } finally {
    dir.closeSync();
  }
};

const listBoards = (root: string, only?: string[]): string[] => {
  const boards: string[] = [];
  const dir = opendirSync(root);
  try {
    let entry;
    while ((entry = dir.readSync()) !== null) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (only && !only.includes(entry.name)) {
        continue;
      }
      boards.push(entry.name);
    }
  } finally {
    dir.closeSync();
  }
  return boards.sort();
};

export const ingestJsonApi = async (
  db: Pool,
  opts: {
    root: string;
    sourceId: number;
    site: string;
    boards?: string[];
    excludeBoards?: string[];
  }
): Promise<IngestStats> => {
  const inserter = new PostInserter(db, opts.sourceId);

  const stats: IngestStats = {
    threads: 0,
    posts: 0,
    skippedPosts: 0,
    badFiles: 0,
  };
  // BATCH bounds how long a crash could lose tallies for, and forces a flush
  // so stats.posts (only incremented once a buffered insert's promise
  // resolves) doesn't lag far behind the on-disk state -- kept well under
  // PostInserter's own 2000-row auto-flush so the displayed message stays
  // current rather than jumping in one big leap when that auto-flush lands.
  // Accumulates across boards (not reset per board) so a source with many
  // small boards still flushes/refreshes regularly.
  const BATCH = 100;
  let inTx = 0;
  const pending: Promise<void>[] = [];
  // No total available without an extra directory walk (threadFiles is a
  // per-board generator over an unknown-length listing), so no bar -- just
  // a spinner that proves liveness on its own timer between updates.
  const bar = makeBar({});
  bar.start('ingesting');

  const boardFilter = makeBoardFilter(opts.excludeBoards);
  for (const board of listBoards(opts.root, opts.boards)) {
    // Whole board skipped before any thread file is opened; tallied once.
    if (boardFilter.reject(board)) {
      continue;
    }
    const boardDir = join(opts.root, board);
    for (const { path: file, threadNo } of threadFiles(boardDir, board)) {
      let posts: ApiPost[];
      try {
        const { posts: parsed } = JSON.parse(readFileSync(file, 'utf8'));
        if (!Array.isArray(parsed)) {
          // Same outcome as a parse failure, reached without throwing to a
          // catch three lines below. Only unreadable/unparseable files are
          // exceptional here; a well-formed file that is not a thread is not.
          stats.badFiles++;
          continue;
        }
        posts = parsed;
      } catch {
        stats.badFiles++;
        continue;
      }

      for (const p of posts) {
        if (typeof p.no !== 'number') {
          stats.skippedPosts++;
          continue;
        }
        collectPending(
          pending,
          inserter
            .insert({
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
              mediaFilename:
                p.filename != null ? `${p.filename}${p.ext ?? ''}` : null,
              mediaMd5: p.md5 ?? null,
            })
            .then((ok) => {
              if (ok) {
                stats.posts++;
              } else {
                stats.skippedPosts++;
              }
            })
        );
      }

      stats.threads++;
      // Cheap -- just updates the displayed text, not I/O -- so refresh it
      // every thread rather than gating it behind the flush checkpoint below.
      bar.message(`/${board}/ threads=${stats.threads} posts=${stats.posts}`);
      if (++inTx >= BATCH) {
        // Flush the stats tallies alongside the posts they describe, so an
        // interrupted run leaves post_stats consistent with what landed
        // instead of losing every tally since the run began.
        await inserter.finish();
        await Promise.all(pending);
        pending.length = 0;
        inTx = 0;
      }
    }
  }
  await inserter.finish();
  await Promise.all(pending);
  bar.stop(
    `${stats.posts} posts from ${stats.threads} thread(s)` +
      boardFilter.summary()
  );
  return stats;
};
