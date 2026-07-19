import { parseArgs } from "node:util";
import { openDb, getOrCreateSource } from "./db.ts";
import { ingestJsonApi } from "./adapters/json-api.ts";

const USAGE = `Usage:
  cli.ts ingest json-api --db <file> --root <dir> --source <name> [--link <url>] [--site 4chan] [--board <b> ...]
  cli.ts count --db <file> --phrase <text> [--board <b>] [--site 4chan] [--from <date>] [--to <date>] [--by month|day|year|total]

Dates are YYYY, YYYY-MM, or YYYY-MM-DD (UTC). --from/--to are both inclusive:
--to 2018-09 means "through the end of September 2018".`;

function fail(msg: string): never {
  console.error(msg);
  console.error();
  console.error(USAGE);
  process.exit(1);
}

/** Parse a date bound; returns epoch seconds. End bounds are advanced by one
 * unit of their precision so they can be used as an exclusive upper bound. */
function parseBound(s: string, end: boolean): number {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s);
  if (!m) fail(`invalid date: ${s}`);
  let [year, month, day] = [Number(m[1]), m[2] ? Number(m[2]) : null, m[3] ? Number(m[3]) : null];
  if (end) {
    if (day != null) day++;
    else if (month != null) month++;
    else year++;
  }
  return Date.UTC(year, (month ?? 1) - 1, day ?? 1) / 1000;
}

function cmdIngest(argv: string[]) {
  const adapter = argv[0];
  if (adapter !== "json-api") fail(`unknown adapter: ${adapter ?? "(none)"}`);
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      db: { type: "string" },
      root: { type: "string" },
      source: { type: "string" },
      link: { type: "string" },
      site: { type: "string", default: "4chan" },
      board: { type: "string", multiple: true },
    },
  });
  if (!values.db || !values.root || !values.source) {
    fail("ingest requires --db, --root, and --source");
  }

  const db = openDb(values.db);
  try {
    const sourceId = getOrCreateSource(db, values.source, values.link);
    const t0 = Date.now();
    const stats = ingestJsonApi(db, {
      root: values.root,
      sourceId,
      site: values.site,
      boards: values.board,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(
      `ingested ${stats.posts} posts from ${stats.threads} threads in ${secs}s` +
        ` (${stats.skippedPosts} posts already present/skipped, ${stats.badFiles} unreadable files)`,
    );
  } finally {
    db.close();
  }
}

const BUCKET_FORMATS: Record<string, string> = {
  day: "%Y-%m-%d",
  month: "%Y-%m",
  year: "%Y",
};

function cmdCount(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: "string" },
      phrase: { type: "string" },
      board: { type: "string" },
      site: { type: "string", default: "4chan" },
      from: { type: "string" },
      to: { type: "string" },
      by: { type: "string", default: "month" },
    },
  });
  if (!values.db || !values.phrase) fail("count requires --db and --phrase");
  if (values.by !== "total" && !(values.by in BUCKET_FORMATS)) {
    fail(`--by must be one of: ${Object.keys(BUCKET_FORMATS).join(", ")}, total`);
  }

  const where: string[] = ["posts_fts MATCH ?", "p.site = ?"];
  const params: (string | number)[] = [
    `"${values.phrase.replaceAll('"', '""')}"`,
    values.site,
  ];
  if (values.board) {
    where.push("p.board = ?");
    params.push(values.board);
  }
  if (values.from) {
    where.push("p.ts_utc >= ?");
    params.push(parseBound(values.from, false));
  }
  if (values.to) {
    where.push("p.ts_utc < ?");
    params.push(parseBound(values.to, true));
  }

  // COUNT(DISTINCT ...) dedupes posts that appear in more than one archive
  // source; post numbers are unique within a board.
  const bucketExpr =
    values.by === "total"
      ? "'total'"
      : `strftime('${BUCKET_FORMATS[values.by]}', p.ts_utc, 'unixepoch')`;
  const sql = `
    SELECT ${bucketExpr} AS bucket,
           COUNT(DISTINCT p.board || ':' || p.post_no) AS posts
    FROM posts_fts
    JOIN posts p ON p.id = posts_fts.rowid
    WHERE ${where.join(" AND ")}
    GROUP BY bucket
    ORDER BY bucket
  `;

  const db = openDb(values.db);
  try {
    const rows = db.prepare(sql).all(...params) as { bucket: string | null; posts: number }[];
    if (rows.length === 0) {
      console.log("no matches");
      return;
    }
    let total = 0;
    for (const r of rows) {
      console.log(`${r.bucket ?? "(no date)"}\t${r.posts}`);
      total += r.posts;
    }
    if (values.by !== "total") console.log(`total\t${total}`);
  } finally {
    db.close();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "ingest":
    cmdIngest(rest);
    break;
  case "count":
    cmdCount(rest);
    break;
  default:
    fail(cmd ? `unknown command: ${cmd}` : "no command given");
}
