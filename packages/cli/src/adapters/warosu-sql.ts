import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { DatabaseSync } from "node:sqlite";
import { PostInserter } from "../ingest.ts";
import { nyWallToUtc, parseTuples } from "../mysqldump.ts";

/**
 * Ingests the warosu.org database backups: one mysqldump per board, in the
 * original Perl-Fuuka schema (25 columns, a single table named after the
 * board). Not the same layout as the Asagi-era `fuuka-sql` adapter:
 *   - `parent` (0 for OPs) instead of `thread_num` + `op`
 *   - the poster's original filename is in `media`; `media_filename` holds
 *     the server's timestamp name
 *   - one INSERT statement per row instead of extended inserts
 * `timestamp` is New-York-shifted like all Fuuka descendants and is
 * normalized to true UTC on ingest.
 */

const REQUIRED_COLS = ["num", "subnum", "parent", "timestamp", "comment", "media"];

interface IngestStats {
  posts: number;
  skippedDup: number;
  skippedGhost: number;
  badLines: number;
  tables: string[];
}

export async function ingestWarosuSql(
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
  let accept: { board: string; idx: Record<string, number> } | null = null;
  let acceptFor = "";

  const COMMIT_EVERY = 50_000;
  let sinceCommit = 0;
  db.exec("BEGIN");

  const progress = () => {
    const mb = (bytesRead / 1e6).toFixed(0);
    const pct = opts.fileSize
      ? ` (${((bytesRead / opts.fileSize) * 100).toFixed(1)}%)`
      : "";
    process.stderr.write(
      `\r${mb}MB${pct} read, ${stats.posts} posts, boards: ${stats.tables.join(",") || "-"}   `,
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
        if (
          cols &&
          REQUIRED_COLS.every((c) => cols.includes(c)) &&
          (!opts.boards || opts.boards.includes(table))
        ) {
          const idx: Record<string, number> = {};
          cols.forEach((c, i) => (idx[c] = i));
          accept = { board: table, idx };
          if (!stats.tables.includes(table)) stats.tables.push(table);
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
          const parent = Number(vals[idx.parent]);
          const ts = Number(vals[idx.timestamp]);
          const ok = inserter.insert({
            site: opts.site,
            board,
            threadNo: parent === 0 ? num : parent,
            postNo: num,
            isOp: parent === 0,
            tsUtc: ts > 0 ? nyWallToUtc(ts) : null,
            name: vals[idx.name] ?? null,
            tripcode: vals[idx.trip] ?? null,
            subject: vals[idx.title] ?? null,
            bodyText: vals[idx.comment] ?? null,
            mediaFilename: vals[idx.media] ?? null,
            mediaMd5: vals[idx.media_hash] ?? null,
          });
          if (ok) stats.posts++;
          else stats.skippedDup++;
          if (++sinceCommit >= COMMIT_EVERY) {
            // Flush the stats tallies inside the same transaction as the
            // posts they describe, so an interrupted run leaves post_stats
            // consistent with what actually landed rather than losing every
            // tally accumulated since the run began.
            inserter.finish();
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
  // Fold this run's tallies into post_stats before reporting.
  inserter.finish();
  return stats;
}
