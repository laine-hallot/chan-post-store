import type { Pool } from 'pg';

import { createReadStream } from 'node:fs';

import { makeBoardFilter } from '../boards.ts';
import { type BoardTotals, collectPending, PostInserter } from '../ingest.ts';
import { readLines } from '../lines.ts';
import {
  CREATE_TABLE_RE,
  insertColumns,
  nyWallToUtc,
  parseTuples,
  takeCompleteTuples,
} from '../mysqldump.ts';
import { makeBar } from '../progress.ts';

/**
 * The one SQL reader. Ingests `out/<board>.sql` in the staged standard format:
 * an Asagi post table named for its board, optionally accompanied by that
 * board's `<board>_deleted` table.
 *
 * There used to be four adapters here — `fuuka-sql`, `warosu-sql`,
 * `desuarchive-sql` and `posts-threads-sql`. Three of them are gone because
 * their differences were never differences of *reading*:
 *
 *   - `fuuka-sql` vs `warosu-sql` was ~25 lines: a required-column signature
 *     and four field expressions. Original Fuuka names the thread pointer
 *     `parent` and the poster's filename `media`; Asagi calls them
 *     `thread_num` and `media_filename`. `prepare` now renames those inside
 *     the CREATE TABLE block, which remaps every field without touching a
 *     data row — those dumps carry no INSERT column list, so tuple order
 *     follows the table definition.
 *   - `desuarchive-sql` existed because mysqlchump spreads one statement over
 *     many lines. That reader is this one: it carries quote state across
 *     lines, which is a strict superset of the one-statement-per-line shape,
 *     so a classic mysqldump reads correctly through the same path.
 *   - `posts-threads-sql` read a flat `posts` table joined to `threads`.
 *     Board is only reachable through that join, so it cannot be expressed as
 *     a table-per-board file at all; `prepare` resolves the join and emits
 *     NDJSON instead, which the `json` reader takes.
 *
 * Both serializations are accepted, because both still exist in the corpus
 * and neither needs rewriting:
 *
 *   - **mysqldump** — one complete statement per line, newlines inside string
 *     literals escaped, usually no INSERT column list.
 *   - **mysqlchump** — `CREATE TABLE IF NOT EXISTS`, an explicit column list
 *     that OMITS declared columns (doc_id, media_id, poster_ip), values
 *     separated by `, ` rather than `,`, a UTF-8 BOM before each table's
 *     first INSERT, and statements spanning many lines because comments carry
 *     literal unescaped newlines. Tuple extent is only knowable with quote
 *     state, and a continuation line can itself begin with `(`.
 *
 * Two things about this that are worth not relearning. The INSERT's own
 * column list is authoritative when present, since it need not match table
 * order. And failure in this family is silent rather than loud: pointed at a
 * dialect it cannot read, a reader reports zero tables and zero posts and
 * exits 0 — indistinguishable from a source whose posts were all already
 * present. Never judge an SQL ingest by exit code; check the post count, the
 * OP count and the timestamp nulls.
 *
 * `timestamp` is America/New_York wall time in every source that reaches this
 * reader, and is converted to true UTC. That is measured, not assumed: 2,500
 * posts shared between the Desuarchive dumps and the installgentoo archive
 * run exactly 5h behind stored UTC in Nov 2011/Jan 2012 and exactly 4h behind
 * in Jun 2017, i.e. tracking EST/EDT. (The NDJSON side of the standard format
 * is the opposite — true UTC — so the two cases must not share a helper.)
 *
 * Ghost posts (subnum != 0, replies made on an archive site rather than on
 * 4chan) are skipped.
 */

const REQUIRED_COLS = ['num', 'subnum', 'thread_num', 'timestamp', 'comment'];

/** A UTF-8 BOM appears before the first INSERT of each table in mysqlchump dumps. */
const BOM = '﻿';

interface IngestStats {
  posts: number;
  skippedDup: number;
  skippedGhost: number;
  badLines: number;
  tables: string[];
  /** Per-board run totals, for --count-only. */
  totals: BoardTotals[];
}

export const ingestSql = async (
  /** Null when counting rather than storing; see PostInserter. */
  db: Pool | null,
  opts: {
    file: string;
    sourceId: number;
    site: string;
    boards?: string[];
    excludeBoards?: string[];
    /** Parse and tally, but write nothing. See PostInserter. */
    countOnly?: boolean;
    fileSize?: number;
  }
): Promise<IngestStats> => {
  const boardFilter = makeBoardFilter(opts.excludeBoards);
  const inserter = new PostInserter(db, opts.sourceId, opts.countOnly);
  const stats: IngestStats = {
    posts: 0,
    skippedDup: 0,
    skippedGhost: 0,
    badLines: 0,
    tables: [],
    totals: [],
  };

  const input =
    opts.file === '-'
      ? process.stdin
      : createReadStream(opts.file, { highWaterMark: 4 * 1024 * 1024 });
  let bytesRead = 0;
  const bar = makeBar({ max: opts.fileSize });
  bar.start(`reading ${opts.file}`);
  // Counted from inside readLines rather than via an input.on('data')
  // listener: that listener would put the stream in flowing mode and race the
  // async iteration for chunks.
  const lines = readLines(input, (n) => {
    bytesRead += n;
    bar.advance(
      n,
      `${(bytesRead / 1e6).toFixed(0)}MB read, ${stats.posts} posts,` +
        ` tables: ${stats.tables.join(',') || '-'}`
    );
  });

  const tableCols = new Map<string, string[]>();
  let creating: string | null = null;
  /** Set while inside an INSERT statement; null between statements. */
  let active: { board: string; idx: Record<string, number> } | null = null;

  const COMMIT_EVERY = 50_000;
  let sinceCommit = 0;
  const pending: Promise<void>[] = [];

  /** Unconsumed text of a statement whose last tuple is still open. */
  let buf = '';

  /** Insert every complete tuple in `buf`, keeping the trailing fragment. */
  const drainBuffer = async (): Promise<void> => {
    if (!active) {
      return;
    }
    const { board, idx } = active;
    const { tuples, rest } = takeCompleteTuples(buf);
    buf = rest;
    for (const tuple of tuples) {
      try {
        const vals = parseTuples(tuple, 0).next().value;
        if (!vals) {
          continue;
        }
        if (Number(vals[idx.subnum]) !== 0) {
          stats.skippedGhost++;
          continue;
        }
        const num = Number(vals[idx.num]);
        // Normalise BEFORE the isOp test, not after. Asagi stores an OP's own
        // number in thread_num; original Fuuka stores 0 and is renamed into
        // this column by prepare. Testing `num === threadNo` against the raw
        // value would therefore mark every converted Fuuka OP as a reply --
        // silently, since is_op has no constraint backing it.
        const rawThread = Number(vals[idx.thread_num]);
        const threadNo = rawThread === 0 ? num : rawThread;
        const ts = Number(vals[idx.timestamp]);
        collectPending(
          pending,
          inserter
            .insert({
              site: opts.site,
              board,
              threadNo,
              postNo: num,
              isOp:
                idx.op !== undefined ? vals[idx.op] === '1' : num === threadNo,
              tsUtc: ts > 0 ? nyWallToUtc(ts) : null,
              name: vals[idx.name] ?? null,
              tripcode: vals[idx.trip] ?? null,
              subject: vals[idx.title] ?? null,
              bodyText: vals[idx.comment] ?? null,
              mediaFilename: vals[idx.media_filename] ?? null,
              mediaMd5: vals[idx.media_hash] ?? null,
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
          // interrupted run leaves post_stats consistent with what landed
          // instead of losing every tally since the run began.
          await inserter.finish();
          await Promise.all(pending);
          pending.length = 0;
          sinceCommit = 0;
        }
      } catch {
        stats.badLines++; // a tuple we cannot parse
      }
    }
  };

  for await (const raw of lines) {
    const line = raw.startsWith(BOM) ? raw.slice(BOM.length) : raw;

    // --- inside a CREATE TABLE body ---------------------------------------
    if (creating !== null) {
      const col = /^\s*`([^`]+)`/.exec(line);
      if (col) {
        tableCols.get(creating)!.push(col[1]);
      } else if (line.startsWith(')')) {
        creating = null;
      }
      continue;
    }

    // --- inside a multi-line INSERT ---------------------------------------
    // Every line belongs to the open statement until its last tuple closes.
    // A line is NOT a tuple boundary here: comments carry literal newlines, so
    // the same post can span dozens of lines and a continuation can even begin
    // with "(". Only quote-aware scanning in takeCompleteTuples decides where
    // a tuple ends, and the "\n" re-added below is part of the post body.
    if (active !== null) {
      // A new statement starts only at column 0 and outside any open literal,
      // which an unbalanced buffer proves we are not.
      if (buf.length === 0 && line.startsWith('INSERT INTO `')) {
        active = null; // fall through to the INSERT handling below
      } else {
        buf += (buf.length ? '\n' : '') + line;
        await drainBuffer();
        continue;
      }
    }

    const create = CREATE_TABLE_RE.exec(line);
    if (create) {
      creating = create[1];
      tableCols.set(creating, []);
      continue;
    }

    if (!line.startsWith('INSERT INTO `')) {
      continue;
    }
    const tick = line.indexOf('`', 13);
    const table = line.slice(13, tick);
    const valuesAt = line.indexOf(' VALUES', tick);
    if (valuesAt < 0) {
      continue;
    }

    active = null;
    const cols = tableCols.get(table);
    // A board's deleted-post table holds that board's posts; both map to it.
    const board = table.replace(/_deleted$/, '');
    // Before the tuple parse, so an excluded board costs only the statement
    // header. Tallied per INSERT statement rather than per post -- extended
    // inserts mean the count is statements, not rows.
    if (boardFilter.reject(board)) {
      continue;
    }
    if (opts.boards && !opts.boards.includes(board)) {
      continue;
    }

    // The INSERT's own column list is authoritative; fall back to the
    // CREATE TABLE order only when the statement carries no list.
    const listed = insertColumns(line, tick + 1, valuesAt);
    const order = listed ?? cols;
    if (!order || !REQUIRED_COLS.every((c) => order.includes(c))) {
      // Either a side table (no `comment`) or a dump that omitted something
      // we need. Both are skips, but the latter should not look like success.
      if (listed) {
        stats.badLines++;
      }
      continue;
    }
    const idx: Record<string, number> = {};
    order.forEach((c, i) => (idx[c] = i));
    active = { board, idx };
    if (!stats.tables.includes(table)) {
      stats.tables.push(table);
    }

    // mysqlchump puts VALUES at end of line, but tolerate tuples trailing on
    // the same line so a single-line mysqldump statement still works.
    buf = line.slice(valuesAt + 7);
    await drainBuffer();
  }

  // A statement left open at EOF means the dump was truncated mid-tuple.
  if (buf.trim().length > 0) {
    stats.badLines++;
  }

  await inserter.finish();
  await Promise.all(pending);
  bar.stop(
    `${stats.posts} posts from tables [${stats.tables.join(', ')}]` +
      boardFilter.summary()
  );
  stats.totals = inserter.report();
  return stats;
};
