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
} from "../mysqldump.ts";

/**
 * Ingests a mysqldump of a Fuuka/Asagi (FoolFuuka-schema) archive database,
 * e.g. the Laza 4chan archive. Streams the .sql file directly — no MySQL
 * server involved. Board tables are recognized by their columns; the
 * side tables Asagi keeps (`x_threads`, `x_images`, `x_daily`, `x_users`)
 * lack a `comment` column and are skipped.
 *
 * Asagi stores `timestamp` shifted to America/New_York wall time ("4chan
 * time"); values are converted back to true UTC on the way in.
 */

const REQUIRED_COLS = ["num", "subnum", "thread_num", "timestamp", "comment"];

interface IngestStats {
  posts: number;
  skippedDup: number;
  skippedGhost: number;
  badLines: number;
  tables: string[];
}

// ---- dump walking --------------------------------------------------------

export const ingestFuukaSql = async (
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
  // column index map for the table whose INSERTs we are currently accepting
  let accept: {
    table: string;
    board: string;
    idx: Record<string, number>;
    /** Last INSERT column list seen, and the order it implies. See below. */
    listKey?: string;
    listIdx?: Record<string, number> | null;
  } | null = null;
  let acceptFor = ""; // last table name we computed `accept` for

  const COMMIT_EVERY = 50_000;
  let sinceCommit = 0;
  const pending: Promise<void>[] = [];

  for await (const line of lines) {
    if (creating !== null) {
      const col = /^\s*`([^`]+)`/.exec(line);
      if (col) {
        tableCols.get(creating)!.push(col[1]);
      } else if (line.startsWith(")")) {
        creating = null;
      }
      continue;
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

    if (table !== acceptFor) {
      acceptFor = table;
      accept = null;
      const cols = tableCols.get(table);
      if (cols && REQUIRED_COLS.every((c) => cols.includes(c))) {
        const board = table.replace(/_deleted$/, "");
        if (!opts.boards || opts.boards.includes(board)) {
          const idx: Record<string, number> = {};
          cols.forEach((c, i) => (idx[c] = i));
          accept = { table, board, idx };
          if (!stats.tables.includes(table)) stats.tables.push(table);
        }
      }
    }
    if (!accept) continue;

    const { board } = accept;
    const valuesAt = line.indexOf(" VALUES ", tick);
    if (valuesAt < 0) continue;

    // An explicit column list on the INSERT overrides the CREATE TABLE order,
    // because it is what the tuples actually follow. Cached on the accept
    // entry: the list is identical on every statement for a table, so this
    // rebuilds the map once rather than millions of times.
    let idx = accept.idx;
    const listed = insertColumns(line, tick + 1, valuesAt);
    if (listed) {
      const key = listed.join(",");
      if (key !== accept.listKey) {
        const m: Record<string, number> = {};
        listed.forEach((c, i) => (m[c] = i));
        // A dump may omit a column we need outright. Skipping the statement
        // is better than reading a field that is not there, and badLines
        // makes it visible instead of looking like an empty dump.
        accept.listIdx = REQUIRED_COLS.every((c) => c in m) ? m : null;
        accept.listKey = key;
      }
      if (!accept.listIdx) {
        stats.badLines++;
        continue;
      }
      idx = accept.listIdx;
    }

    try {
      for (const vals of parseTuples(line, valuesAt + 8)) {
        if (Number(vals[idx.subnum]) !== 0) {
          stats.skippedGhost++; // ghost posts aren't real 4chan posts
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
              threadNo,
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
          // Flush the stats tallies alongside the posts they describe, so
          // an interrupted run leaves post_stats consistent with what
          // landed instead of losing every tally since the run began.
          await inserter.finish();
          await Promise.all(pending);
          pending.length = 0;
          sinceCommit = 0;
        }
      }
    } catch {
      stats.badLines++; // typically a truncated final line
    }
  }
  await inserter.finish();
  await Promise.all(pending);
  bar.stop(`${stats.posts} posts from tables [${stats.tables.join(", ")}]`);
  return stats;
};
