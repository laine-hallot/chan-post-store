import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { PostInserter } from "../ingest.ts";

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

// ---- America/New_York wall time -> UTC ----------------------------------

const nyFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  timeZoneName: "longOffset",
});
const offsetCache = new Map<number, number>();

/** UTC offset of America/New_York at the given UTC time, in seconds
 * (negative; -14400 for EDT, -18000 for EST). Cached per hour. */
function nyOffsetAt(utcSec: number): number {
  const hour = Math.floor(utcSec / 3600);
  const cached = offsetCache.get(hour);
  if (cached !== undefined) return cached;
  const tzName = nyFormat
    .formatToParts(utcSec * 1000)
    .find((p) => p.type === "timeZoneName")!.value;
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzName);
  if (!m) throw new Error(`cannot parse timezone offset: ${tzName}`);
  const sign = m[1] === "-" ? -1 : 1;
  const offset = sign * (Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60);
  offsetCache.set(hour, offset);
  return offset;
}

/** Interpret `wall` (epoch-encoded New York wall clock) as true UTC. */
export function nyWallToUtc(wall: number): number {
  let utc = wall - nyOffsetAt(wall);
  utc = wall - nyOffsetAt(utc);
  return utc;
}

// ---- mysqldump INSERT tuple parsing -------------------------------------

const ESCAPES: Record<string, string> = {
  "0": "\0",
  n: "\n",
  r: "\r",
  t: "\t",
  Z: "\x1a",
  b: "\b",
};

export function* parseTuples(
  line: string,
  start: number,
): Generator<(string | null)[]> {
  let i = start;
  const n = line.length;
  while (i < n) {
    while (i < n && line[i] !== "(") i++;
    if (i >= n) return;
    i++;
    const vals: (string | null)[] = [];
    for (;;) {
      if (line[i] === "'") {
        i++;
        let out = "";
        let seg = i;
        for (;;) {
          const ch = line[i];
          if (ch === undefined) throw new Error("unterminated string");
          if (ch === "\\") {
            const esc = line[i + 1];
            out += line.slice(seg, i) + (ESCAPES[esc] ?? esc);
            i += 2;
            seg = i;
          } else if (ch === "'") {
            out += line.slice(seg, i);
            if (line[i + 1] === "'") {
              out += "'";
              i += 2;
              seg = i;
            } else {
              i++;
              break;
            }
          } else {
            i++;
          }
        }
        vals.push(out);
      } else {
        let j = i;
        while (j < n && line[j] !== "," && line[j] !== ")") j++;
        if (j >= n) throw new Error("unterminated tuple");
        const tok = line.slice(i, j);
        vals.push(tok === "NULL" ? null : tok);
        i = j;
      }
      if (line[i] === ",") {
        i++;
      } else if (line[i] === ")") {
        i++;
        break;
      } else {
        throw new Error(`unexpected character at offset ${i}`);
      }
    }
    yield vals;
  }
}

// ---- dump walking --------------------------------------------------------

export async function ingestFuukaSql(
  db: DatabaseSync,
  opts: {
    file: string;
    sourceId: number;
    site: string;
    boards?: string[];
    fileSize?: number;
  },
): Promise<IngestStats> {
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
  input.on("data", (chunk: string | Buffer) => {
    bytesRead += chunk.length;
  });
  const lines = createInterface({ input, crlfDelay: Infinity });

  const tableCols = new Map<string, string[]>();
  let creating: string | null = null;
  // column index map for the table whose INSERTs we are currently accepting
  let accept: {
    table: string;
    board: string;
    idx: Record<string, number>;
  } | null = null;
  let acceptFor = ""; // last table name we computed `accept` for

  const COMMIT_EVERY = 50_000;
  let sinceCommit = 0;
  db.exec("BEGIN");

  const progress = () => {
    const mb = (bytesRead / 1e6).toFixed(0);
    const pct = opts.fileSize
      ? ` (${((bytesRead / opts.fileSize) * 100).toFixed(1)}%)`
      : "";
    process.stderr.write(
      `\r${mb}MB${pct} read, ${stats.posts} posts, tables: ${stats.tables.join(",") || "-"}   `,
    );
  };

  try {
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

      const create = /^CREATE TABLE `([^`]+)` \($/.exec(line);
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
        progress();
      }
      if (!accept) continue;

      const { board, idx } = accept;
      const valuesAt = line.indexOf(" VALUES ", tick);
      if (valuesAt < 0) continue;

      try {
        for (const vals of parseTuples(line, valuesAt + 8)) {
          if (Number(vals[idx.subnum]) !== 0) {
            stats.skippedGhost++; // ghost posts aren't real 4chan posts
            continue;
          }
          const num = Number(vals[idx.num]);
          const threadNo = Number(vals[idx.thread_num]);
          const ts = Number(vals[idx.timestamp]);
          const ok = inserter.insert({
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
          });
          if (ok) stats.posts++;
          else stats.skippedDup++;
          if (++sinceCommit >= COMMIT_EVERY) {
            db.exec("COMMIT");
            db.exec("BEGIN");
            sinceCommit = 0;
            progress();
          }
        }
      } catch {
        stats.badLines++; // typically a truncated final line
      }
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  process.stderr.write("\n");
  return stats;
}
