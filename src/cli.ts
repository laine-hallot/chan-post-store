import { statSync } from "node:fs";
import { parseArgs } from "node:util";
import { openDb, getOrCreateSource } from "./db.ts";
import { ingestJsonApi } from "./adapters/json-api.ts";
import { ingestFuukaSql } from "./adapters/fuuka-sql.ts";

const USAGE = `Usage:
  cli.ts ingest json-api --db <file> --root <dir> --source <name> [--link <url>] [--site 4chan] [--board <b> ...]
  cli.ts ingest fuuka-sql --db <file> --file <tables.sql|-> --source <name> [--link <url>] [--site 4chan] [--board <b> ...]
  cli.ts count --db <file> --phrase <text> [--board <b>] [--site 4chan] [--from <date>] [--to <date>] [--by month|day|year|total]
  cli.ts search --db <file> --phrase <text> [--board <b>] [--site 4chan] [--from <date>] [--to <date>] [--limit 20]
  cli.ts list boards|sites|sources --db <file> [--site <s>]

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

async function cmdIngest(argv: string[]) {
  const adapter = argv[0];
  if (adapter !== "json-api" && adapter !== "fuuka-sql") {
    fail(`unknown adapter: ${adapter ?? "(none)"}`);
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      db: { type: "string" },
      root: { type: "string" },
      file: { type: "string" },
      source: { type: "string" },
      link: { type: "string" },
      site: { type: "string", default: "4chan" },
      board: { type: "string", multiple: true },
    },
  });
  if (!values.db || !values.source) fail("ingest requires --db and --source");

  const db = openDb(values.db);
  try {
    const sourceId = getOrCreateSource(db, values.source, values.link);
    const t0 = Date.now();

    if (adapter === "json-api") {
      if (!values.root) fail("json-api requires --root");
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
    } else {
      if (!values.file) fail("fuuka-sql requires --file (path to tables.sql, or - for stdin)");
      let fileSize: number | undefined;
      if (values.file !== "-") {
        fileSize = statSync(values.file).size;
      }
      const stats = await ingestFuukaSql(db, {
        file: values.file,
        sourceId,
        site: values.site,
        boards: values.board,
        fileSize,
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `ingested ${stats.posts} posts from tables [${stats.tables.join(", ")}] in ${secs}s` +
          ` (${stats.skippedDup} already present, ${stats.skippedGhost} ghost posts skipped,` +
          ` ${stats.badLines} unparseable lines)`,
      );
    }
  } finally {
    db.close();
  }
}

const FILTER_OPTIONS = {
  db: { type: "string" },
  phrase: { type: "string" },
  board: { type: "string" },
  site: { type: "string", default: "4chan" },
  from: { type: "string" },
  to: { type: "string" },
} as const;

interface FilterValues {
  phrase?: string;
  board?: string;
  site: string;
  from?: string;
  to?: string;
}

/** WHERE clauses + params shared by `count` and `search`. */
function phraseFilters(values: FilterValues): {
  where: string;
  params: (string | number)[];
} {
  const where: string[] = ["posts_fts MATCH ?", "p.site = ?"];
  const params: (string | number)[] = [
    `"${values.phrase!.replaceAll('"', '""')}"`,
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
  return { where: where.join(" AND "), params };
}

const BUCKET_FORMATS: Record<string, string> = {
  day: "%Y-%m-%d",
  month: "%Y-%m",
  year: "%Y",
};

function cmdCount(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { ...FILTER_OPTIONS, by: { type: "string", default: "month" } },
  });
  if (!values.db || !values.phrase) fail("count requires --db and --phrase");
  if (values.by !== "total" && !(values.by in BUCKET_FORMATS)) {
    fail(`--by must be one of: ${Object.keys(BUCKET_FORMATS).join(", ")}, total`);
  }

  const { where, params } = phraseFilters(values);

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
    WHERE ${where}
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

function cmdSearch(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: { ...FILTER_OPTIONS, limit: { type: "string", default: "20" } },
  });
  if (!values.db || !values.phrase) fail("search requires --db and --phrase");
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1) fail(`invalid --limit: ${values.limit}`);

  const { where, params } = phraseFilters(values);
  // GROUP BY collapses copies of the same post held by different sources
  const sql = `
    SELECT p.board, p.thread_no, p.post_no, p.is_op, p.ts_utc,
           p.name, p.tripcode, p.subject, p.body_text
    FROM posts_fts
    JOIN posts p ON p.id = posts_fts.rowid
    WHERE ${where}
    GROUP BY p.site, p.board, p.post_no
    ORDER BY p.ts_utc, p.post_no
    LIMIT ?
  `;
  const totalSql = `
    SELECT COUNT(DISTINCT p.site || ':' || p.board || ':' || p.post_no) AS n
    FROM posts_fts
    JOIN posts p ON p.id = posts_fts.rowid
    WHERE ${where}
  `;

  interface Hit {
    board: string;
    thread_no: number;
    post_no: number;
    is_op: number;
    ts_utc: number | null;
    name: string | null;
    tripcode: string | null;
    subject: string | null;
    body_text: string | null;
  }

  const db = openDb(values.db);
  try {
    const rows = db.prepare(sql).all(...params, limit) as unknown as Hit[];
    if (rows.length === 0) {
      console.log("no matches");
      return;
    }
    for (const r of rows) {
      const when = r.ts_utc
        ? new Date(r.ts_utc * 1000).toISOString().replace("T", " ").slice(0, 16)
        : "(no date)";
      const who = `${r.name ?? "Anonymous"}${r.tripcode ?? ""}`;
      let header = `[${when}] /${r.board}/${r.post_no}`;
      if (r.is_op) header += " (OP)";
      else header += ` in ${r.thread_no}`;
      header += ` — ${who}`;
      if (r.subject) header += ` — “${r.subject}”`;
      console.log(header);
      if (r.body_text) {
        console.log(r.body_text.replace(/^/gm, "  "));
      }
      console.log();
    }
    const total = (db.prepare(totalSql).get(...params) as { n: number }).n;
    if (total > rows.length) {
      console.log(`(showing ${rows.length} of ${total} matching posts; raise --limit for more)`);
    }
  } finally {
    db.close();
  }
}

function printTable(headers: string[], rows: (string | number | null)[][]) {
  const numeric = headers.map((_, i) =>
    rows.every((r) => r[i] == null || typeof r[i] === "number"),
  );
  const cells = rows.map((r) =>
    r.map((v) =>
      v == null ? "-" : typeof v === "number" ? v.toLocaleString("en-US") : v,
    ),
  );
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => r[i].length)),
  );
  const line = (row: string[]) =>
    row
      .map((c, i) => (numeric[i] ? c.padStart(widths[i]) : c.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  console.log(line(headers));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of cells) console.log(line(r));
}

const LIST_QUERIES: Record<string, { headers: string[]; sql: string }> = {
  boards: {
    headers: ["site", "board", "posts", "threads", "first", "last"],
    sql: `
      SELECT p.site, p.board,
             COUNT(DISTINCT p.post_no) AS posts,
             COUNT(DISTINCT p.thread_no) AS threads,
             date(MIN(p.ts_utc), 'unixepoch') AS first,
             date(MAX(p.ts_utc), 'unixepoch') AS last
      FROM posts p {WHERE}
      GROUP BY p.site, p.board
      ORDER BY p.site, p.board`,
  },
  sites: {
    headers: ["site", "boards", "posts", "first", "last"],
    sql: `
      SELECT p.site,
             COUNT(DISTINCT p.board) AS boards,
             COUNT(DISTINCT p.board || ':' || p.post_no) AS posts,
             date(MIN(p.ts_utc), 'unixepoch') AS first,
             date(MAX(p.ts_utc), 'unixepoch') AS last
      FROM posts p {WHERE}
      GROUP BY p.site
      ORDER BY p.site`,
  },
  sources: {
    headers: ["source", "posts", "boards", "first", "last", "link"],
    sql: `
      SELECT s.name,
             COUNT(p.id) AS posts,
             COUNT(DISTINCT p.site || '/' || p.board) AS boards,
             date(MIN(p.ts_utc), 'unixepoch') AS first,
             date(MAX(p.ts_utc), 'unixepoch') AS last,
             s.link
      FROM sources s
      LEFT JOIN posts p ON p.source_id = s.id {WHERE}
      GROUP BY s.id
      ORDER BY s.name`,
  },
};

function cmdList(argv: string[]) {
  const what = argv[0];
  const query = what ? LIST_QUERIES[what] : undefined;
  if (!query) {
    fail(`list expects one of: ${Object.keys(LIST_QUERIES).join(", ")}`);
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      db: { type: "string" },
      site: { type: "string" },
    },
  });
  if (!values.db) fail("list requires --db");

  const params: string[] = [];
  let where = "";
  if (values.site) {
    where = "WHERE p.site = ?";
    params.push(values.site);
  }
  const sql = query.sql.replace("{WHERE}", where);

  const db = openDb(values.db);
  try {
    const rows = db.prepare(sql).all(...params) as Record<
      string,
      string | number | null
    >[];
    if (rows.length === 0) {
      console.log("database is empty");
      return;
    }
    printTable(
      query.headers,
      rows.map((r) => Object.values(r)),
    );
  } finally {
    db.close();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "ingest":
    await cmdIngest(rest);
    break;
  case "count":
    cmdCount(rest);
    break;
  case "search":
    cmdSearch(rest);
    break;
  case "list":
    cmdList(rest);
    break;
  default:
    fail(cmd ? `unknown command: ${cmd}` : "no command given");
}
