import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openDb, getOrCreateSource, isLockedError } from "./db.ts";
import { boardList, hasStats, refreshPostStats } from "./stats.ts";
import { ingestJsonApi } from "./adapters/json-api.ts";
import { ingestFuukaSql } from "./adapters/fuuka-sql.ts";
import { ingestWarosuSql } from "./adapters/warosu-sql.ts";
import {
  ingestInputs,
  listManifestIds,
  manifestPath,
  PendingSourceError,
  readManifest,
  readSourceInfo,
  SOURCES_DIR,
} from "./manifest.ts";
import {
  downloadItem,
  fetchItem,
  humanBytes,
  identifierFromLink,
} from "./archive-org.ts";
import { makeRunner, shQuote } from "./runner.ts";
import { runPrepare } from "./prepare.ts";
import { htmlPages, uriToFilename } from "./warc.ts";

/**
 * Repo root; manifest ingest paths are resolved against it.
 *
 * Found by walking up to the directory holding `sources/` rather than by a
 * fixed number of `..` hops, so moving this package within the workspace
 * doesn't silently resolve archive paths somewhere wrong.
 */
function findProjectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, SOURCES_DIR))) return dir;
    const up = dirname(dir);
    if (up === dir) {
      throw new Error(`could not locate the repo root (no ${SOURCES_DIR}/ above ${import.meta.url})`);
    }
    dir = up;
  }
}

const PROJECT_ROOT = findProjectRoot();

const USAGE = `Usage:
  cli.ts download <source> [--remote <host>] [--local] [--dry-run] [--force]
  cli.ts prepare <source> [--remote <host>] [--local] [--dry-run] [--force]
  cli.ts warc-extract --warc <file.warc[.gz]> --out <dir> [--host <regex>]
  cli.ts ingest <source> --db <file> [--board <b> ...]
  cli.ts boards --db <file>
  cli.ts refresh-stats --db <file>
  cli.ts count --db <file> --phrase <text> [--board <b>] [--site 4chan] [--from <date>] [--to <date>] [--by month|day|year|total]
  cli.ts search --db <file> --phrase <text> [--board <b>] [--site 4chan] [--from <date>] [--to <date>] [--limit 20]
  cli.ts list boards|sites|sources|manifests --db <file> [--site <s>]

<source> names a manifest in ${SOURCES_DIR}/<source>.json (or a path to one).
The manifest supplies the source name, link, adapter, and input path;
--board still narrows which boards are read out of that input.

download stages an archive.org item into the source's files.source dir.
It runs on the NAS when NAS_HOST/NAS_ROOT are set in .env (or --remote is
given), so the transfer goes straight there; --local forces this machine.

Dates are YYYY, YYYY-MM, or YYYY-MM-DD (UTC). --from/--to are both inclusive:
--to 2018-09 means "through the end of September 2018".`;

function fail(msg: string): never {
  console.error(msg);
  console.error();
  console.error(USAGE);
  process.exit(1);
}

/**
 * Runs `fn`, turning SQLite's write-lock error into a plain explanation.
 *
 * Only one writer at a time is allowed, and ingests hold the lock for hours,
 * so a second one hitting it is an ordinary situation rather than a bug —
 * it should not surface as a stack trace.
 */
function onLockedFail<T>(dbPath: string | undefined, fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (isLockedError(e)) {
      fail(
        `${dbPath} is locked by another writer.\n` +
          `An ingest or refresh-stats is probably already running against it —\n` +
          `SQLite allows one writer at a time, so wait for that to finish.`,
      );
    }
    throw e;
  }
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

async function cmdDownload(argv: string[]) {
  const id = argv[0];
  if (!id || id.startsWith("-")) {
    const ids = listManifestIds(PROJECT_ROOT);
    fail(
      `download requires a source name\n\nKnown sources:\n` +
        (ids.length ? ids.map((s) => `  ${s}`).join("\n") : "  (none)"),
    );
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      remote: { type: "string" },
      local: { type: "boolean" },
      key: { type: "string" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      all: { type: "boolean" },
    },
  });

  let info;
  try {
    info = readSourceInfo(manifestPath(id, PROJECT_ROOT));
  } catch (e) {
    fail(String((e as Error).message));
  }
  if (!info.link) fail(`${info.file}: source.link is required to download`);
  const identifier = identifierFromLink(info.link);
  if (!identifier) {
    fail(`${info.file}: source.link is not an archive.org URL: ${info.link}`);
  }

  const item = await fetchItem(identifier);
  console.log(`${item.identifier}: ${item.title ?? "(untitled)"}`);
  console.log(`${item.files.length} files, ${humanBytes(item.totalBytes)}`);

  // Image/thumbnail payloads are excluded per-manifest; --all overrides.
  if (info.downloadExclude.length && !values.all) {
    const before = item.files.length;
    const beforeBytes = item.totalBytes;
    item.files = item.files.filter(
      (f) => !info.downloadExclude.some((re) => re.test(f.name)),
    );
    item.totalBytes = item.files.reduce((n, f) => n + f.size, 0);
    const skipped = before - item.files.length;
    if (skipped > 0) {
      console.log(
        `skipping ${skipped} excluded file(s), ${humanBytes(beforeBytes - item.totalBytes)}` +
          ` — downloading ${item.files.length} files, ${humanBytes(item.totalBytes)} (--all to include)`,
      );
    }
  }

  const runner = await makeRunner({
    projectRoot: PROJECT_ROOT,
    host: values.remote,
    forceLocal: values.local,
    key: values.key,
  });
  try {
    const dest = runner.path(
      runner.rootIsDatasets ? info.stageDirFromDatasets : info.stageDir,
    );
    console.log(`destination: ${dest} (${runner.where})\n`);
    const results = await downloadItem({
      item,
      dest,
      runner,
      force: values.force,
      dryRun: values["dry-run"],
    });

    const by = (s: string) => results.filter((r) => r.status === s).length;
    console.log(
      `\n${by("downloaded")} downloaded, ${by("skipped")} skipped, ${by("failed")} failed`,
    );
    const failed = results.filter((r) => r.status === "failed");
    if (failed.length) {
      for (const f of failed) console.error(`  ${f.name}: ${f.detail}`);
      process.exitCode = 1;
    }
  } finally {
    await runner.close();
  }
}

async function cmdPrepare(argv: string[]) {
  const id = argv[0];
  if (!id || id.startsWith("-")) {
    const ids = listManifestIds(PROJECT_ROOT);
    fail(
      `prepare requires a source name\n\nKnown sources:\n` +
        (ids.length ? ids.map((s) => `  ${s}`).join("\n") : "  (none)"),
    );
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      remote: { type: "string" },
      local: { type: "boolean" },
      key: { type: "string" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
    },
  });

  let info;
  try {
    info = readSourceInfo(manifestPath(id, PROJECT_ROOT));
  } catch (e) {
    fail(String((e as Error).message));
  }

  const runner = await makeRunner({
    projectRoot: PROJECT_ROOT,
    host: values.remote,
    forceLocal: values.local,
    key: values.key,
  });
  try {
    const dir = runner.path(
      runner.rootIsDatasets ? info.dirFromDatasets : info.dir,
    );
    console.log(`preparing ${info.name}`);
    console.log(`${dir} (${runner.where})\n`);
    // Local steps shell back into this CLI and must address the same target,
    // so they are handed the project root, the dataset dir, and the flags
    // that reproduce the current runner.
    // Not shell-quoted: this is expanded from $TARGET by the shell itself,
    // so added quotes would become part of the hostname.
    const targetFlags = runner.rootIsDatasets
      ? `--remote ${(runner as { host?: string }).host ?? ""}`
      : "--local";
    const res = await runPrepare({
      info,
      dir,
      runner,
      dryRun: values["dry-run"],
      force: values.force,
      vars: {
        PROJECT: PROJECT_ROOT,
        // Absolute path to this entry point, so manifests don't hard-code
        // where the CLI package sits in the workspace.
        CLI: fileURLToPath(import.meta.url),
        DIR: dir,
        TARGET: targetFlags,
      },
    });
    if (!res.skipped && !values["dry-run"]) {
      console.log(`\n${res.ran} step(s) completed -> ${info.prepareOutput}/`);
    }
  } catch (e) {
    console.error(String((e as Error).message));
    process.exitCode = 1;
  } finally {
    await runner.close();
  }
}

/**
 * Extracts HTML pages from a WARC into a directory. Invoked from manifest
 * prepare steps; the de-chunk + brotli handling is impractical in shell.
 */
async function cmdWarcExtract(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      warc: { type: "string" },
      out: { type: "string" },
      host: { type: "string", default: "boards\\.4chan(?:nel)?\\.org" },
      remote: { type: "string" },
      local: { type: "boolean" },
      key: { type: "string" },
    },
  });
  if (!values.warc || !values.out) fail("warc-extract requires --warc and --out");
  const hostRe = new RegExp(values.host);

  // Parsing happens here rather than on the target: the NAS has no Node, and
  // these WARCs are single-digit MB, so the round trip is cheap.
  const runner = await makeRunner({
    projectRoot: PROJECT_ROOT,
    host: values.remote,
    forceLocal: values.local,
    key: values.key,
  });
  try {
    // --warc may name a single file or a directory of them; archives like
    // fybertech ship many WARCs from one crawl.
    const probe = await runner.exec(
      `test -d ${shQuote(values.warc)} && echo dir || echo file`,
    );
    let warcs: string[];
    if (probe.stdout.trim() === "dir") {
      const ls = await runner.exec(
        `find ${shQuote(values.warc)} -type f \\( -name '*.warc' -o -name '*.warc.gz' \\) | sort`,
      );
      warcs = ls.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
      if (warcs.length === 0) fail(`no .warc/.warc.gz files under ${values.warc}`);
      console.log(`${warcs.length} WARC file(s)`);
    } else {
      warcs = [values.warc];
    }

    const outDir = values.out.replace(/\/$/, "");
    let n = 0;
    for (const w of warcs) {
      const raw = await runner.readFile(w);
      // Items ship the WARC gzipped; accept either form.
      const buf = w.endsWith(".gz") ? gunzipSync(raw) : raw;
      for (const rec of htmlPages(buf, hostRe)) {
        const name = uriToFilename(rec.uri!);
        await runner.writeFile(`${outDir}/${name}`, rec.body);
        console.log(`  ${name} (${rec.body.length} bytes) <- ${rec.uri}`);
        n++;
      }
    }
    if (n === 0) fail(`no HTML pages matching /${values.host}/ in ${values.warc}`);
    console.log(`extracted ${n} page(s)`);
  } finally {
    await runner.close();
  }
}

async function cmdIngest(argv: string[]) {
  const id = argv[0];
  if (!id || id.startsWith("-")) {
    const ids = listManifestIds(PROJECT_ROOT);
    fail(
      `ingest requires a source name\n\nKnown sources:\n` +
        (ids.length ? ids.map((s) => `  ${s}`).join("\n") : "  (none)"),
    );
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      db: { type: "string" },
      board: { type: "string", multiple: true },
    },
  });
  if (!values.db) fail("ingest requires --db");

  let manifest, inputs;
  try {
    manifest = readManifest(manifestPath(id, PROJECT_ROOT), PROJECT_ROOT);
    inputs = ingestInputs(manifest);
  } catch (e) {
    // A source whose prepare step hasn't run is a normal state to hit; say so
    // plainly instead of dressing it up as a usage error.
    if (e instanceof PendingSourceError) {
      console.error(String(e.message));
      process.exit(2);
    }
    fail(String((e as Error).message));
  }

  const db = onLockedFail(values.db, () => openDb(values.db!));
  try {
    const sourceId = onLockedFail(values.db, () =>
      getOrCreateSource(db, manifest.name, manifest.link),
    );
    const t0 = Date.now();
    console.log(`ingesting ${manifest.name} [${manifest.adapter}] from ${manifest.path}`);

    if (manifest.adapter === "json-api") {
      const stats = ingestJsonApi(db, {
        root: inputs[0],
        sourceId,
        site: manifest.site,
        boards: values.board,
      });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `ingested ${stats.posts} posts from ${stats.threads} threads in ${secs}s` +
          ` (${stats.skippedPosts} posts already present/skipped, ${stats.badFiles} unreadable files)`,
      );
    } else {
      const ingest = manifest.adapter === "fuuka-sql" ? ingestFuukaSql : ingestWarosuSql;
      let posts = 0;
      const tables: string[] = [];
      for (const file of inputs) {
        // warosu backups ship one dump per board, so a source can be several
        // files; each is streamed in turn into the same source id.
        if (inputs.length > 1) console.log(`  ${file}`);
        const stats = await ingest(db, {
          file,
          sourceId,
          site: manifest.site,
          boards: values.board,
          fileSize: statSync(file).size,
        });
        posts += stats.posts;
        tables.push(...stats.tables);
      }
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(
        `ingested ${posts} posts from tables [${tables.join(", ")}]` +
          ` across ${inputs.length} file(s) in ${secs}s`,
      );
    }
  } finally {
    db.close();
  }
}

/**
 * Registry view: what's in sources/, and how far each has got.
 *
 * Stage checks go through the runner, so a remote setup reports on the NAS
 * rather than on whatever the local SMB mount happens to be showing (that
 * mount drops periodically and would otherwise report everything missing).
 */
async function cmdListManifests(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      remote: { type: "string" },
      local: { type: "boolean" },
      key: { type: "string" },
    },
  });
  const ids = listManifestIds(PROJECT_ROOT);
  if (ids.length === 0) {
    console.log(`no manifests in ${SOURCES_DIR}/`);
    return;
  }

  const runner = await makeRunner({
    projectRoot: PROJECT_ROOT,
    host: values.remote,
    forceLocal: values.local,
    key: values.key,
  });
  try {
    const rows: (string | number | null)[][] = [];
    for (const id of ids) {
      let adapter = "-";
      let stages = "";
      let status = "ready";
      try {
        const info = readSourceInfo(manifestPath(id, PROJECT_ROOT));
        const base = runner.path(
          runner.rootIsDatasets ? info.dirFromDatasets : info.dir,
        );
        // One shell round-trip per source: which stage dirs are non-empty.
        const probe = await runner.exec(
          ["source", "extracted", "out"]
            .map(
              (s) =>
                `if [ -n "$(ls -A ${shQuote(`${base}/${s}`)} 2>/dev/null)" ]; then printf '${s[0]}'; else printf '-'; fi`,
            )
            .join("; "),
        );
        stages = probe.stdout.trim();
        try {
          adapter = readManifest(manifestPath(id, PROJECT_ROOT), PROJECT_ROOT).adapter;
        } catch {
          adapter = "-";
        }
        // "ready" means out/ has content and an adapter is declared.
        status = stages.endsWith("o") && adapter !== "-" ? "ready" : "pending";
      } catch (e) {
        status = e instanceof PendingSourceError ? "pending" : "error";
      }
      rows.push([id, adapter, stages, status]);
    }
    printTable(["source", "adapter", "s/e/o", "status"], rows);
  } finally {
    await runner.close();
  }
}

/**
 * Rebuilds the post_stats summary table.
 *
 * Ingest keeps it current, so this is for backfilling a store that predates
 * the table. One full pass over `posts`.
 */
/**
 * Board list from the summary table.
 *
 * Distinct from `list boards`, which dedupes post/thread numbers across
 * overlapping archives by scanning `posts` — accurate but minutes-long on a
 * large store. This reads pre-rolled counts instead, so it answers "which
 * boards exist and when is their data from" immediately; the counts are raw
 * per-archive contributions and can double-count a post held twice.
 */
function cmdBoards(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { db: { type: "string" } } });
  if (!values.db) fail("boards requires --db");
  const db = openDb(values.db);
  try {
    if (!hasStats(db)) {
      fail("post_stats is empty — run: cli.ts refresh-stats --db <file>");
    }
    const rows = boardList(db);
    if (rows.length === 0) {
      console.log("no boards recorded");
      return;
    }
    // Years are rendered as strings: printTable group-separates numbers,
    // which would print 2015 as "2,015".
    const body = rows.map((r) => [
      r.site,
      r.board,
      r.posts,
      r.firstYear == null ? null : String(r.firstYear),
      r.lastYear == null ? null : String(r.lastYear),
    ]);
    printTable(
      ["site", "board", "posts", "first", "last"],
      body,
      body.length > 1
        ? totalsRow(["label", "blank", "sum", "min", "max"], body)
        : undefined,
    );
  } finally {
    db.close();
  }
}

function cmdRefreshStats(argv: string[]) {
  const { values } = parseArgs({ args: argv, options: { db: { type: "string" } } });
  if (!values.db) fail("refresh-stats requires --db");
  const db = openDb(values.db);
  try {
    console.log("rebuilding post_stats (one full pass over posts) ...");
    const t0 = Date.now();
    const rows = refreshPostStats(db);
    console.log(`wrote ${rows} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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

function printTable(
  headers: string[],
  rows: (string | number | null)[][],
  footer?: (string | number | null)[],
) {
  const bodyAndFoot = footer ? [...rows, footer] : rows;
  const numeric = headers.map((_, i) =>
    rows.every((r) => r[i] == null || typeof r[i] === "number"),
  );
  const fmt = (v: string | number | null) =>
    v == null ? "-" : typeof v === "number" ? v.toLocaleString("en-US") : v;
  const cells = bodyAndFoot.map((r) => r.map(fmt));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => r[i].length)),
  );
  const line = (row: string[]) =>
    row
      .map((c, i) => (numeric[i] ? c.padStart(widths[i]) : c.padEnd(widths[i])))
      .join("  ")
      .trimEnd();
  const rule = line(widths.map((w) => "-".repeat(w)));
  console.log(line(headers));
  console.log(rule);
  for (const r of cells.slice(0, rows.length)) console.log(line(r));
  if (footer) {
    console.log(rule);
    console.log(line(cells[rows.length]));
  }
}

// How each column of the totals row is derived from the body rows. "sum"
// adds the values, "min"/"max" span dates, "label" holds the "TOTAL" tag,
// and "blank" leaves free-text columns (e.g. a source link) empty.
type TotalRule = "sum" | "min" | "max" | "label" | "blank";

function totalsRow(
  rules: TotalRule[],
  rows: (string | number | null)[][],
): (string | number | null)[] {
  return rules.map((rule, i) => {
    switch (rule) {
      case "label":
        return "TOTAL";
      case "blank":
        return null;
      case "sum":
        return rows.reduce((acc, r) => acc + (Number(r[i]) || 0), 0);
      case "min":
      case "max": {
        const vals = rows.map((r) => r[i]).filter((v): v is string => v != null);
        if (vals.length === 0) return null;
        return rule === "min"
          ? vals.reduce((a, b) => (a < b ? a : b))
          : vals.reduce((a, b) => (a > b ? a : b));
      }
    }
  });
}

const LIST_QUERIES: Record<
  string,
  { headers: string[]; totals: TotalRule[]; sql: string }
> = {
  boards: {
    headers: ["site", "board", "posts", "threads", "first", "last"],
    // posts/threads sum cleanly since each belongs to exactly one board
    totals: ["label", "blank", "sum", "sum", "min", "max"],
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
    totals: ["label", "sum", "sum", "min", "max"],
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
    // posts are raw per-source contributions and may overlap across sources,
    // so the summed total can exceed the deduped site total by design
    totals: ["label", "sum", "sum", "min", "max", "blank"],
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

async function cmdList(argv: string[]) {
  const what = argv[0];
  // `manifests` reads sources/, not the database, so it takes no --db
  if (what === "manifests") {
    await cmdListManifests(argv.slice(1));
    return;
  }
  const query = what ? LIST_QUERIES[what] : undefined;
  if (!query) {
    fail(`list expects one of: ${Object.keys(LIST_QUERIES).join(", ")}, manifests`);
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
    const body = rows.map((r) => Object.values(r));
    // a totals row only adds signal when there's more than one row to total
    const footer = body.length > 1 ? totalsRow(query.totals, body) : undefined;
    printTable(query.headers, body, footer);
  } finally {
    db.close();
  }
}

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "download":
    await cmdDownload(rest);
    break;
  case "prepare":
    await cmdPrepare(rest);
    break;
  case "warc-extract":
    await cmdWarcExtract(rest);
    break;
  case "ingest":
    await cmdIngest(rest);
    break;
  case "boards":
    cmdBoards(rest);
    break;
  case "refresh-stats":
    cmdRefreshStats(rest);
    break;
  case "count":
    cmdCount(rest);
    break;
  case "search":
    cmdSearch(rest);
    break;
  case "list":
    await cmdList(rest);
    break;
  default:
    fail(cmd ? `unknown command: ${cmd}` : "no command given");
}
