import type { Pool } from "pg";

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import { collectPending, PostInserter } from "../ingest.ts";
import { makeBar } from "../progress.ts";
import {
  CREATE_TABLE_RE,
  insertColumns,
  nyWallToUtc,
  parseTuples,
  takeCompleteTuples,
} from "../mysqldump.ts";

/**
 * Ingests the 2019 Desuarchive/RBT database dumps.
 *
 * The SCHEMA is ordinary Asagi — same columns `fuuka-sql` reads, and the two
 * adapters agree field for field. What differs is the SERIALIZATION, because
 * these dumps were not made by mysqldump but by `mysqlchump`, which the
 * uploader describes as "an experimental tool to make .sql dumps without
 * needing to include all columns from the DB". Three differences, each of
 * which defeats a line-oriented reader:
 *
 *   1. `CREATE TABLE IF NOT EXISTS \`g\` (` rather than `CREATE TABLE \`g\` (`.
 *      Handled by CREATE_TABLE_RE, shared with the other SQL adapters.
 *   2. An explicit column list on every INSERT, which OMITS columns that the
 *      CREATE TABLE declares (doc_id, media_id, poster_ip). The list, not the
 *      table definition, gives tuple order — reading positions from the
 *      CREATE TABLE shifts every field by three.
 *   3. **The statement spans many lines.** The INSERT line ends at `VALUES`
 *      and each tuple sits on its own following line, terminated by `,` or by
 *      `;` on the last. `fuuka-sql` and `warosu-sql` both assume one complete
 *      statement per line and simply find no tuples here.
 *
 * (3) is why this is a separate adapter rather than a patch to `fuuka-sql`:
 * that reader's whole shape is one-statement-per-line, and teaching it to
 * span lines would complicate the path every other SQL source takes for the
 * benefit of one dialect.
 *
 * Failure here is silent rather than loud, which is worth remembering when
 * judging a run: pointed at these dumps, `fuuka-sql` reports zero tables and
 * zero posts and exits 0 — indistinguishable from a source whose posts were
 * all already present.
 *
 * `timestamp` is America/New_York wall time and is converted to true UTC,
 * like every Fuuka descendant. That is measured, not assumed: 2,500 posts
 * shared with the installgentoo archive show the dump running exactly 5h
 * behind stored UTC in Nov 2011/Jan 2012 and exactly 4h behind in Jun 2017,
 * i.e. tracking EST/EDT.
 *
 * Ghost posts (subnum != 0, replies made on the archive site rather than
 * 4chan) are skipped, as elsewhere.
 */

const REQUIRED_COLS = ["num", "subnum", "thread_num", "timestamp", "comment"];

/** A UTF-8 BOM appears before the first INSERT of each table in these dumps. */
const BOM = "﻿";

interface IngestStats {
  posts: number;
  skippedDup: number;
  skippedGhost: number;
  badLines: number;
  tables: string[];
}

export const ingestDesuarchiveSql = async (
  db: Pool,
  opts: {
    file: string;
    sourceId: number;
    site: string;
    boards?: string[];
    fileSize?: number;
  },
): Promise<IngestStats> => {
  const inserter = new PostInserter(db, opts.sourceId);
  const stats: IngestStats = {
    posts: 0,
    skippedDup: 0,
    skippedGhost: 0,
    badLines: 0,
    tables: [],
  };

  const input =
    opts.file === "-"
      ? process.stdin
      : createReadStream(opts.file, { highWaterMark: 4 * 1024 * 1024 });
  let bytesRead = 0;
  const bar = makeBar({ max: opts.fileSize });
  bar.start(`reading ${opts.file}`);
  input.on("data", (chunk: string | Buffer) => {
    bytesRead += chunk.length;
    bar.advance(
      chunk.length,
      `${(bytesRead / 1e6).toFixed(0)}MB read, ${stats.posts} posts,` +
        ` tables: ${stats.tables.join(",") || "-"}`,
    );
  });
  const lines = createInterface({ input, crlfDelay: Infinity });

  const tableCols = new Map<string, string[]>();
  let creating: string | null = null;
  /** Set while inside a multi-line INSERT; null between statements. */
  let active: { board: string; idx: Record<string, number> } | null = null;

  const COMMIT_EVERY = 50_000;
  let sinceCommit = 0;
  const pending: Promise<void>[] = [];

  /** Unconsumed text of a statement whose last tuple is still open. */
  let buf = "";

  /** Insert every complete tuple in `buf`, keeping the trailing fragment. */
  const drainBuffer = async (): Promise<void> => {
    if (!active) return;
    const { board, idx } = active;
    const { tuples, rest } = takeCompleteTuples(buf);
    buf = rest;
    for (const tuple of tuples) {
      try {
        const vals = parseTuples(tuple, 0).next().value;
        if (!vals) continue;
        if (Number(vals[idx.subnum]) !== 0) {
          stats.skippedGhost++;
          continue;
        }
        const num = Number(vals[idx.num]);
        const threadNo = Number(vals[idx.thread_num]);
        const ts = Number(vals[idx.timestamp]);
        collectPending(
          pending,
          inserter
            .insert({
              site: opts.site,
              board,
              threadNo: threadNo === 0 ? num : threadNo,
              postNo: num,
              isOp: idx.op !== undefined ? vals[idx.op] === "1" : num === threadNo,
              tsUtc: ts > 0 ? nyWallToUtc(ts) : null,
              name: vals[idx.name] ?? null,
              tripcode: vals[idx.trip] ?? null,
              subject: vals[idx.title] ?? null,
              bodyText: vals[idx.comment] ?? null,
              mediaFilename: vals[idx.media_filename] ?? null,
              mediaMd5: vals[idx.media_hash] ?? null,
            })
            .then((ok) => {
              if (ok) stats.posts++;
              else stats.skippedDup++;
            }),
        );
        if (++sinceCommit >= COMMIT_EVERY) {
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
      if (col) tableCols.get(creating)!.push(col[1]);
      else if (line.startsWith(")")) creating = null;
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
      if (buf.length === 0 && line.startsWith("INSERT INTO `")) {
        active = null; // fall through to the INSERT handling below
      } else {
        buf += (buf.length ? "\n" : "") + line;
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

    if (!line.startsWith("INSERT INTO `")) continue;
    const tick = line.indexOf("`", 13);
    const table = line.slice(13, tick);
    const valuesAt = line.indexOf(" VALUES", tick);
    if (valuesAt < 0) continue;

    active = null;
    const cols = tableCols.get(table);
    const board = table.replace(/_deleted$/, "");
    if (opts.boards && !opts.boards.includes(board)) continue;

    // The INSERT's own column list is authoritative; fall back to the
    // CREATE TABLE order only when the statement carries no list.
    const listed = insertColumns(line, tick + 1, valuesAt);
    const order = listed ?? cols;
    if (!order || !REQUIRED_COLS.every((c) => order.includes(c))) {
      // Either a side table (no `comment`) or a dump that omitted something
      // we need. Both are skips, but the latter should not look like success.
      if (listed) stats.badLines++;
      continue;
    }
    const idx: Record<string, number> = {};
    order.forEach((c, i) => (idx[c] = i));
    active = { board, idx };
    if (!stats.tables.includes(table)) stats.tables.push(table);

    // mysqlchump puts VALUES at end of line, but tolerate tuples trailing on
    // the same line so a single-line statement still works.
    buf = line.slice(valuesAt + 7);
    await drainBuffer();
  }

  // A statement left open at EOF means the dump was truncated mid-tuple.
  if (buf.trim().length > 0) stats.badLines++;

  await inserter.finish();
  await Promise.all(pending);
  bar.stop(`${stats.posts} posts from tables [${stats.tables.join(", ")}]`);
  return stats;
};
