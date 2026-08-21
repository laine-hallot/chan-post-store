import type { Pool } from 'pg';

import type { BoardTotals } from '../database/ingest.ts';

import { createReadStream, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { makeBoardFilter } from '../boards.ts';
import { collectPending, PostInserter } from '../database/ingest.ts';
import { makeBar } from '../progress.ts';
import { readLines } from '../utils/lines.ts';

/**
 * The one JSON reader. Ingests the standard staged layout,
 * `out/<board>/posts.ndjson`: one newline-delimited record per post, using
 * Asagi field names.
 *
 *   {"site":"4chan","board":"a","num":10781807,"subnum":0,
 *    "thread_num":10781807,"op":1,"timestamp":1207638960,
 *    "name":"Anonymous","trip":null,"title":null,"comment":"...",
 *    "media_filename":"chibi rei.jpg","media_hash":null}
 *
 * Asagi names rather than this codebase's own field names so that `out/`
 * stays meaningful on its own and the sql and json cases share one
 * vocabulary. `desuarchive_mlp_1_42799493` already ships exactly this format,
 * so it needs placing rather than converting.
 *
 * **`timestamp` here is TRUE UTC**, which is the one place the two halves of
 * the standard format deliberately differ: the SQL side is America/New_York
 * wall time. Whichever archive a record came from, `prepare` has already
 * normalised it, so this reader never converts and must never be given a
 * helper that does. The same producer ships both conventions -- Desuarchive's
 * 2019 SQL dumps are NY wall time while its NDJSON export is UTC -- so this
 * cannot be inferred from the data and is a property of the staged format.
 *
 * Lines are split on "\n" and nothing else. That is not incidental:
 * `JSON.stringify` escapes \n and \r but leaves U+2028 LINE SEPARATOR RAW in
 * its output, and 4chan post bodies contain it. A reader built on `readline`
 * -- which breaks on U+2028, U+2029 and a lone \r as well -- would cut a
 * record in half and then fail to parse it, losing the post silently. See
 * lines.ts, and the same defect measured on the SQL side.
 *
 * `site` comes from the record when it carries one and from the manifest
 * otherwise. Only the archives that swept up other imageboards need it, and
 * for those a per-record value is the only correct answer.
 */

interface NdjsonPost {
  site?: string;
  board?: string;
  num?: number;
  subnum?: number;
  thread_num?: number;
  op?: number;
  timestamp?: number | null;
  name?: string | null;
  trip?: string | null;
  title?: string | null;
  comment?: string | null;
  media_filename?: string | null;
  media_hash?: string | null;
}

interface IngestStats {
  boards: number;
  posts: number;
  skippedDup: number;
  skippedGhost: number;
  badLines: number;
  /** Per-board run totals, for --count-only. */
  totals: BoardTotals[];
}

/** `<root>/<board>/posts.ndjson` for every board present. */
const boardFiles = (
  root: string,
  only?: string[]
): { board: string; file: string }[] => {
  const out: { board: string; file: string }[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) {
      continue;
    }
    if (only && !only.includes(e.name)) {
      continue;
    }
    const file = join(root, e.name, 'posts.ndjson');
    try {
      if (statSync(file).isFile()) {
        out.push({ board: e.name, file });
      }
    } catch {
      // A board directory with no posts.ndjson is not this reader's business.
    }
  }
  return out.sort((a, b) => a.board.localeCompare(b.board));
};

export const ingestJson = async (
  /** Null when counting rather than storing; see PostInserter. */
  db: Pool | null,
  opts: {
    root: string;
    sourceId: number;
    site: string;
    boards?: string[];
    excludeBoards?: string[];
    /** Parse and tally, but write nothing. See PostInserter. */
    countOnly?: boolean;
  }
): Promise<IngestStats> => {
  const boardFilter = makeBoardFilter(opts.excludeBoards);
  const inserter = new PostInserter(db, opts.sourceId, opts.countOnly);
  const stats: IngestStats = {
    boards: 0,
    posts: 0,
    skippedDup: 0,
    skippedGhost: 0,
    badLines: 0,
    totals: [],
  };

  const files = boardFiles(opts.root, opts.boards);
  const total = files.reduce((n, f) => n + statSync(f.file).size, 0);
  const bar = makeBar({ max: total });
  bar.start(
    `${opts.countOnly ? 'reading' : 'ingesting'} ${files.length} board file(s)`
  );

  const COMMIT_EVERY = 50_000;
  let sinceCommit = 0;
  const pending: Promise<void>[] = [];
  let bytesRead = 0;

  for (const { board, file } of files) {
    // Tallied once per board, before the file is opened.
    if (boardFilter.reject(board)) {
      continue;
    }
    stats.boards++;

    const lines = readLines(createReadStream(file), (n) => {
      bytesRead += n;
      bar.advance(n, `/${board}/ ${stats.posts} posts`);
    });

    for await (const line of lines) {
      if (line === '') {
        continue;
      }
      let p: NdjsonPost;
      try {
        p = JSON.parse(line) as NdjsonPost;
      } catch {
        stats.badLines++;
        continue;
      }
      const { num } = p;
      if (typeof num !== 'number' || !Number.isFinite(num)) {
        stats.badLines++;
        continue;
      }
      // Ghost posts: replies made on an archive's own site rather than on
      // 4chan. Skipped here as everywhere else.
      if (p.subnum) {
        stats.skippedGhost++;
        continue;
      }
      const threadNo = p.thread_num || num;
      collectPending(
        pending,
        inserter
          .insert({
            // The directory names the board; the record's own field is there
            // for a human reading the file.
            site: p.site ?? opts.site,
            board,
            threadNo,
            postNo: num,
            isOp: p.op != null ? p.op === 1 : num === threadNo,
            tsUtc: p.timestamp ?? null,
            name: p.name ?? null,
            tripcode: p.trip ?? null,
            subject: p.title ?? null,
            bodyText: p.comment ?? null,
            mediaFilename: p.media_filename ?? null,
            mediaMd5: p.media_hash ?? null,
          })
          .then((ok) => {
            if (ok) {
              stats.posts++;
            } else {
              stats.skippedDup++;
            }
          })
      );
      if (++sinceCommit >= COMMIT_EVERY) {
        // Flush the stats tallies alongside the posts they describe, so an
        // interrupted run leaves post_stats consistent with what landed.
        await inserter.finish();
        await Promise.all(pending);
        pending.length = 0;
        sinceCommit = 0;
      }
    }
  }

  await inserter.finish();
  await Promise.all(pending);
  bar.stop(
    `${stats.posts} posts from ${stats.boards} board(s)` + boardFilter.summary()
  );
  stats.totals = inserter.report();
  return stats;
};
