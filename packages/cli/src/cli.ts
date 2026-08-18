import type { InferValue } from '@optique/core/parser';
import type { Pool } from 'pg';

import type { Adapter, Manifest } from './manifest.ts';

import { log } from '@clack/prompts';
import { runAsync } from '@optique/run';
import { once } from 'node:events';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { ingestHtml } from './adapters/html.ts';
import { ingestJson } from './adapters/json.ts';
import { ingestSql } from './adapters/sql.ts';
import {
  downloadItem,
  fetchItem,
  humanBytes,
  identifierFromLink,
} from './archive-org.ts';
import { configContext, CONFIG_FILE } from './config.ts';
import {
  openDb,
  getOrCreateSource,
  markSourceCompleted,
  completedSources,
  QUERY_INDEXES,
  queryIndexStatus,
} from './db.ts';
import { connectionString, envContext } from './env.ts';
import {
  ingestInputs,
  listManifestIds,
  manifestPath,
  ManifestError,
  payloadDir,
  readManifest,
  readSourceInfo,
} from './manifest.ts';
import { cli } from './parsers.ts';
import { PROJECT_ROOT, SOURCES_DIR } from './paths.ts';
import { ensureNodeRuntime, NODE_VERSION } from './prepare-steps/payload.ts';
import { runPrepare } from './prepare.ts';
import { makeBar } from './progress.ts';
import { makeRunner, shQuote } from './runner.ts';
import { boardList, hasStats, refreshPostStats } from './stats.ts';
import { htmlPages, uriToFilename } from './warc.ts';

/**
 * Per-command argument types, narrowed out of the one grammar in parsers.ts.
 *
 * Derived rather than declared: the parser is the single source of truth, so
 * adding an option there is a type error here until it is handled, and the
 * two cannot drift the way the old hand-written USAGE banner drifted from
 * the twelve separate parseArgs calls it was supposed to describe.
 */
type Args = InferValue<typeof cli>;
type Pick_<A extends Args['action']> = Extract<Args, { action: A }>;
type DownloadArgs = Pick_<'download'>;
type PrepareArgs = Pick_<'prepare'>;
type PrepareRuntimeArgs = Pick_<'prepare-runtime'>;
type WarcExtractArgs = Pick_<'warc-extract'>;
type IngestArgs = Pick_<'ingest'>;
type IngestAllArgs = Pick_<'ingest-all'>;
type IndexesArgs = Pick_<'indexes'>;
type BoardsArgs = Pick_<'boards'>;
type RefreshStatsArgs = Pick_<'refresh-stats'>;
type CountArgs = Pick_<'count'>;
type SearchArgs = Pick_<'search'>;
type ListManifestsArgs = Pick_<'list-manifests'>;
type ListQueryArgs = Pick_<'list-boards' | 'list-sites' | 'list-sources'>;

/**
 * Abort with a message. Explicitly typed `never` so calls still end control
 * flow -- see `bad` in manifest.ts.
 *
 * No longer prints a usage banner: Optique owns usage and help now, and
 * reprinting the whole grammar after a runtime failure ("no such manifest")
 * buried the actual error.
 */
const fail: (msg: string) => never = (msg) => {
  console.error(msg);
  process.exit(1);
};

/** Parse a date bound; returns epoch seconds. End bounds are advanced by one
 * unit of their precision so they can be used as an exclusive upper bound. */
const parseBound = (s: string, end: boolean): number => {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s);
  if (!m) {
    fail(`invalid date: ${s}`);
  }
  let [year, month, day] = [
    Number(m[1]),
    m[2] ? Number(m[2]) : null,
    m[3] ? Number(m[3]) : null,
  ];
  if (end) {
    if (day != null) {
      day++;
    } else if (month != null) {
      month++;
    } else {
      year++;
    }
  }
  return Date.UTC(year, (month ?? 1) - 1, day ?? 1) / 1000;
};

const cmdDownload = async (o: DownloadArgs): Promise<void> => {
  const id = o.source;

  const infoR = readSourceInfo(manifestPath(id, PROJECT_ROOT));
  if (infoR.isErr) {
    fail(infoR.error.message);
  }
  const info = infoR.value;
  if (!info.link) {
    fail(`${info.file}: source.link is required to download`);
  }
  const identifier = identifierFromLink(info.link);
  if (!identifier) {
    fail(`${info.file}: source.link is not an archive.org URL: ${info.link}`);
  }

  const itemR = await fetchItem(identifier);
  if (itemR.isErr) {
    fail(itemR.error.message);
  }
  const item = itemR.value;
  console.log(`${item.identifier}: ${item.title ?? '(untitled)'}`);
  console.log(`${item.files.length} files, ${humanBytes(item.totalBytes)}`);

  // Image/thumbnail payloads are excluded per-manifest; --all overrides.
  if (info.downloadExclude.length && !o.all) {
    const before = item.files.length;
    const beforeBytes = item.totalBytes;
    item.files = item.files.filter(
      (f) => !info.downloadExclude.some((re) => re.test(f.name))
    );
    item.totalBytes = item.files.reduce((n, f) => n + f.size, 0);
    const skipped = before - item.files.length;
    if (skipped > 0) {
      console.log(
        `skipping ${skipped} excluded file(s), ${humanBytes(beforeBytes - item.totalBytes)}` +
          ` — downloading ${item.files.length} files, ${humanBytes(item.totalBytes)} (--all to include)`
      );
    }
  }

  const runnerR = await makeRunner({
    projectRoot: PROJECT_ROOT,
    host: o.remote,
    forceLocal: o.local,
    key: o.key,
  });
  if (runnerR.isErr) {
    fail(runnerR.error.message);
  }
  const runner = runnerR.value;
  try {
    const dest = runner.path(
      runner.rootIsDatasets ? info.stageDirFromDatasets : info.stageDir
    );
    console.log(`destination: ${dest} (${runner.where})\n`);
    const outcome = await downloadItem({
      item,
      dest,
      runner,
      force: o.force,
      dryRun: o['dry-run'],
    });
    if (outcome.isErr) {
      fail(outcome.error.message);
    }
    const results = outcome.value;

    const by = (s: string): number =>
      results.filter((r) => r.status === s).length;
    console.log(
      `\n${by('downloaded')} downloaded, ${by('skipped')} skipped, ${by('failed')} failed`
    );
    const failed = results.filter((r) => r.status === 'failed');
    if (failed.length) {
      for (const f of failed) {
        console.error(`  ${f.name}: ${f.detail}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await runner.close();
  }
};

const cmdPrepare = async (o: PrepareArgs): Promise<void> => {
  const id = o.source;

  const infoR = readSourceInfo(manifestPath(id, PROJECT_ROOT));
  if (infoR.isErr) {
    fail(infoR.error.message);
  }
  const info = infoR.value;

  const runnerR = await makeRunner({
    projectRoot: PROJECT_ROOT,
    host: o.remote,
    forceLocal: o.local,
    key: o.key,
  });
  if (runnerR.isErr) {
    fail(runnerR.error.message);
  }
  const runner = runnerR.value;
  try {
    const dir = runner.path(
      runner.rootIsDatasets ? info.dirFromDatasets : info.dir
    );
    console.log(`preparing ${info.name}`);
    console.log(`${dir} (${runner.where})\n`);
    // Local steps shell back into this CLI and must address the same target,
    // so they are handed the project root, the dataset dir, and the flags
    // that reproduce the current runner.
    // Not shell-quoted: this is expanded from $TARGET by the shell itself,
    // so added quotes would become part of the hostname.
    const targetFlags = runner.rootIsDatasets
      ? `--remote ${(runner as { host?: string }).host ?? ''}`
      : '--local';
    const res = await runPrepare({
      info,
      dir,
      runner,
      dryRun: o['dry-run'],
      force: o.force,
      vars: {
        PROJECT: PROJECT_ROOT,
        // Absolute path to this entry point, so manifests don't hard-code
        // where the CLI package sits in the workspace.
        CLI: fileURLToPath(import.meta.url),
        DIR: dir,
        TARGET: targetFlags,
      },
      localDir: join(PROJECT_ROOT, info.dir),
      projectRoot: PROJECT_ROOT,
      payloadDir: payloadDir(manifestPath(id, PROJECT_ROOT)),
      sourcesDir: join(PROJECT_ROOT, SOURCES_DIR),
      // The runtime is shared across sources, so it sits beside the datasets
      // rather than inside any one of them.
      datasetsRoot: runner.rootIsDatasets
        ? runner.path('.')
        : join(PROJECT_ROOT, info.dir, '..'),
    });
    if (res.isErr) {
      console.error(res.error.message);
      process.exitCode = 1;
    } else if (!res.value.skipped && !o['dry-run']) {
      console.log(
        `\n${res.value.ran} step(s) completed -> ${info.prepareOutput}/`
      );
    }
  } catch (e) {
    console.error(String((e as Error).message));
    process.exitCode = 1;
  } finally {
    await runner.close();
  }
};

/**
 * Extracts HTML pages from a WARC into a directory. Invoked from manifest
 * prepare steps; the de-chunk + brotli handling is impractical in shell.
 */
const cmdWarcExtract = async (o: WarcExtractArgs): Promise<void> => {
  if (!o.warc || !o.out) {
    fail('warc-extract requires --warc and --out');
  }
  const hostRe = new RegExp(o.host);

  // Parsing happens here rather than on the target: the NAS has no Node, and
  // these WARCs are single-digit MB, so the round trip is cheap.
  const runnerR = await makeRunner({
    projectRoot: PROJECT_ROOT,
    host: o.remote,
    forceLocal: o.local,
    key: o.key,
  });
  if (runnerR.isErr) {
    fail(runnerR.error.message);
  }
  const runner = runnerR.value;
  try {
    // --warc may name a single file or a directory of them; archives like
    // fybertech ship many WARCs from one crawl.
    const probe = await runner.exec(
      `test -d ${shQuote(o.warc)} && echo dir || echo file`
    );
    let warcs: string[];
    if (probe.stdout.trim() === 'dir') {
      const ls = await runner.exec(
        `find ${shQuote(o.warc)} -type f \\( -name '*.warc' -o -name '*.warc.gz' \\) | sort`
      );
      warcs = ls.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (warcs.length === 0) {
        fail(`no .warc/.warc.gz files under ${o.warc}`);
      }
      console.log(`${warcs.length} WARC file(s)`);
    } else {
      warcs = [o.warc];
    }

    const outDir = o.out.replace(/\/$/, '');
    let n = 0;
    for (const w of warcs) {
      const rawR = await runner.readFile(w);
      if (rawR.isErr) {
        fail(rawR.error.message);
      }
      const raw = rawR.value;
      // Items ship the WARC gzipped; accept either form.
      const buf = w.endsWith('.gz') ? gunzipSync(raw) : raw;
      for (const rec of htmlPages(buf, hostRe)) {
        const name = uriToFilename(rec.uri!);
        const wrote = await runner.writeFile(`${outDir}/${name}`, rec.body);
        if (wrote.isErr) {
          fail(wrote.error.message);
        }
        console.log(`  ${name} (${rec.body.length} bytes) <- ${rec.uri}`);
        n++;
      }
    }
    if (n === 0) {
      fail(`no HTML pages matching /${o.host}/ in ${o.warc}`);
    }
    console.log(`extracted ${n} page(s)`);
  } finally {
    await runner.close();
  }
};

/**
 * Installs the runtime that payload prepare steps execute under.
 *
 * Exposed as its own command so it can be done deliberately -- it fetches
 * ~50MB on the target -- rather than only as a side effect of the first
 * source that needs it. Idempotent either way.
 */
const cmdPrepareRuntime = async (o: PrepareRuntimeArgs): Promise<void> => {
  const runnerR = await makeRunner({
    projectRoot: PROJECT_ROOT,
    host: o.remote,
    forceLocal: o.local,
    key: o.key,
  });
  if (runnerR.isErr) {
    fail(runnerR.error.message);
  }
  const runner = runnerR.value;
  try {
    const root = runner.rootIsDatasets
      ? runner.path('.')
      : join(PROJECT_ROOT, 'Memetic Sociology', 'Datasets', '4chan');
    console.log(`runtime root: ${root} (${runner.where})`);
    const r = await ensureNodeRuntime(runner, root);
    if (r.isErr) {
      fail(r.error.message);
    }
    console.log(`node ${NODE_VERSION} ready at ${r.value}`);
  } finally {
    await runner.close();
  }
};

/**
 * Runs one manifest's adapter and returns a formatted summary line, shared
 * by `cmdIngest` (single source, given on the command line) and
 * `cmdIngestAll` (every `ready` source, run in sequence).
 */
const ingestOne = async (
  db: Pool,
  manifest: Manifest,
  sourceId: number,
  inputs: string[],
  boards: string[] | undefined
): Promise<{ posts: number; summary: string }> => {
  const t0 = Date.now();

  if (manifest.adapter === 'json') {
    const stats = await ingestJson(db, {
      root: inputs[0],
      sourceId,
      site: manifest.site,
      boards,
      excludeBoards: manifest.excludeBoards,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    return {
      posts: stats.posts,
      summary:
        `ingested ${stats.posts} posts from ${stats.boards} board(s) in ${secs}s` +
        ` (${stats.skippedDup} already present, ${stats.skippedGhost} ghost,` +
        ` ${stats.badLines} unparsable line(s))`,
    };
  } else if (manifest.adapter === 'html') {
    const stats = await ingestHtml(db, {
      root: inputs[0],
      sourceId,
      site: manifest.site,
      boards,
      excludeBoards: manifest.excludeBoards,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    return {
      posts: stats.posts,
      summary:
        `ingested ${stats.posts} posts from ${stats.files} page(s)` +
        ` (${stats.threads} thread(s)) in ${secs}s` +
        ` (${stats.skippedDup} already present, ${stats.badFiles} unreadable` +
        ` or not in 4chan's own markup)`,
    };
  } else {
    let posts = 0;
    const tables: string[] = [];
    for (const file of inputs) {
      // The standard SQL layout is one file per board, so a source is
      // normally several files; each is streamed in turn into the same
      // source id.
      if (inputs.length > 1) {
        console.log(`  ${file}`);
      }
      const stats = await ingestSql(db, {
        file,
        sourceId,
        site: manifest.site,
        boards,
        excludeBoards: manifest.excludeBoards,
        fileSize: statSync(file).size,
      });
      posts += stats.posts;
      tables.push(...stats.tables);
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    return {
      posts,
      summary:
        `ingested ${posts} posts from tables [${tables.join(', ')}]` +
        ` across ${inputs.length} file(s) in ${secs}s`,
    };
  }
};

const cmdIngest = async (o: IngestArgs): Promise<void> => {
  const id = o.source;
  if (!connectionString(o)) {
    fail('ingest requires --db');
  }

  // A source whose prepare step hasn't run is a normal state to hit; say so
  // plainly instead of dressing it up as a usage error.
  const resolved = readManifest(
    manifestPath(id, PROJECT_ROOT),
    PROJECT_ROOT
  ).chain((m) => ingestInputs(m).map((inputs) => ({ manifest: m, inputs })));
  if (resolved.isErr) {
    if (resolved.error.kind === 'pending') {
      console.error(resolved.error.message);
      process.exit(2);
    }
    fail(resolved.error.message);
  }
  const { manifest, inputs } = resolved.value;

  const db = await openDb(connectionString(o));
  try {
    const sourceId = await getOrCreateSource(db, manifest.name, manifest.link);
    console.log(
      `ingesting ${manifest.name} [${manifest.adapter}] from ${manifest.path}`
    );
    const { summary } = await ingestOne(
      db,
      manifest,
      sourceId,
      inputs,
      o.board.length ? [...o.board] : undefined
    );
    console.log(summary);
    // A --board run covers part of the source, so it is progress, not
    // completion -- leaving completed_at null keeps ingest-all honest about
    // the boards this run never looked at.
    if (o.board?.length) {
      console.log(
        'not marked complete: --board ingests only part of the source'
      );
    } else {
      await markSourceCompleted(db, sourceId);
    }
  } finally {
    await db.end();
  }
};

/**
 * A SQL identifier, double-quoted with embedded quotes doubled.
 *
 * `SET default_tablespace` takes an identifier, not a value, so it cannot be
 * a bound parameter -- the name has to go into the statement text. Quoting it
 * here rather than interpolating raw keeps a tablespace name off the command
 * line and straight into SQL.
 */
const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * A SQL string literal, single-quoted with embedded quotes doubled.
 *
 * `temp_tablespaces` is a list GUC rather than an identifier one, so it takes
 * a literal -- the documented spelling is `SET temp_tablespaces = 'a, b'`.
 */
const quoteLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Elapsed since `t0`, as a human duration. Index builds run into hours. */
const fmtSecs = (t0: number): string => {
  const s = (Date.now() - t0) / 1000;
  if (s < 90) {
    return `${s.toFixed(1)}s`;
  }
  if (s < 5400) {
    return `${(s / 60).toFixed(1)}m`;
  }
  return `${(s / 3600).toFixed(2)}h`;
};

/**
 * Build, drop, or report the query-time indexes on `posts`.
 *
 * These are not part of the connect-time schema, so they have to be managed
 * on purpose. The cycle for a bulk load is `indexes drop`, ingest, `indexes
 * build`: maintaining them per-insert costs far more than sorting them once
 * at the end, and on the current corpus they are ~72GB of write amplification
 * that ingest gets nothing from.
 */
const cmdIndexes = async (o: IndexesArgs): Promise<void> => {
  const action = o.subcommand;
  if (!connectionString(o)) {
    fail('indexes requires --db');
  }

  const db = await openDb(connectionString(o));
  try {
    const before = await queryIndexStatus(db);

    if (action === 'status') {
      printTable(
        ['index', 'present', 'size'],
        before.map((i) => [
          i.name,
          i.exists ? 'yes' : 'no',
          i.exists ? humanBytes(i.bytes) : '-',
        ])
      );
      return;
    }

    if (action === 'drop') {
      const present = before.filter((i) => i.exists);
      if (!present.length) {
        console.log('no query indexes present — nothing to drop');
        return;
      }
      for (const i of present) {
        const t0 = Date.now();
        await db.query(`DROP INDEX IF EXISTS ${i.name}`);
        log.success(
          `dropped ${i.name} (${humanBytes(i.bytes)}) in ${fmtSecs(t0)}`
        );
      }
      console.log(
        `freed ${humanBytes(present.reduce((n, i) => n + i.bytes, 0))}`
      );
      return;
    }

    // build. maintenance_work_mem is set per session rather than cluster-wide
    // because autovacuum_work_mem inherits the global, and three autovacuum
    // workers each holding several GB alongside an ingest is not the trade
    // being made here.
    const memory = o.memory ?? '4GB';
    // Which disk the indexes land on. Set as default_tablespace on the build
    // session rather than written into QUERY_INDEXES, for the same reason
    // maintenance_work_mem is: it is a property of this machine's disks, not
    // of the schema, and hardcoding it would make the DDL untrue anywhere
    // else. It also keeps drop/status working unchanged -- they match on
    // index name, which does not depend on location.
    const { tablespace } = o;
    // Where the build's *sort* spills, which is not the same disk question as
    // where the finished index lands. Postgres writes temp files to the
    // database's default tablespace, and here that is the data-dir disk --
    // the smallest of the three, and the one WAL is also on. Since PG18
    // builds GIN indexes in parallel, every index entry now goes through a
    // tuplesort on the way in, so the spill scales with lexemes rather than
    // rows: filling that disk would take WAL down with it.
    const { tempTablespace } = o;
    // Build a subset. The GIN full-text index is the bulk of the total and
    // scales with text volume rather than row count, so its size is the least
    // predictable; building the cheap btrees first tells you what is left
    // before the expensive one commits to it.
    const { only } = o;
    let missing = before.filter((i) => !i.exists);
    if (only?.length) {
      const known = new Set(QUERY_INDEXES.map((q) => q.name));
      for (const n of only) {
        if (!known.has(n)) {
          fail(
            `unknown index ${n}; --only takes one of: ` +
              QUERY_INDEXES.map((q) => q.name).join(', ')
          );
        }
      }
      missing = missing.filter((i) => only.includes(i.name));
    }
    if (!missing.length) {
      console.log('all query indexes already present — nothing to build');
      return;
    }
    console.log(
      `building ${missing.length} index(es) with maintenance_work_mem=${memory}` +
        (tablespace ? ` in tablespace ${tablespace}` : '') +
        (tempTablespace ? `, sorting in ${tempTablespace}` : '') +
        `\n  each takes an ACCESS EXCLUSIVE lock on posts; queries against it will block`
    );
    for (const i of missing) {
      const spec = QUERY_INDEXES.find((q) => q.name === i.name);
      if (!spec) {
        continue;
      }
      const bar = makeBar({});
      bar.start(`${i.name}`);
      const t0 = Date.now();
      // A dedicated client: SET is per-session, and a pooled query could
      // otherwise land on a connection that never saw it.
      const client = await db.connect();
      try {
        await client.query(`SET maintenance_work_mem = '${memory}'`);
        if (tablespace) {
          // Identifier, so it cannot be parameterized; quote it instead.
          await client.query(
            `SET default_tablespace = ${quoteIdent(tablespace)}`
          );
        }
        if (tempTablespace) {
          // A comma-separated *list* GUC, not an identifier one, so it takes
          // a string literal -- quoteIdent's double quotes would be read as
          // part of the name.
          await client.query(
            `SET temp_tablespaces = ${quoteLiteral(tempTablespace)}`
          );
        }
        await client.query(spec.sql);
      } finally {
        client.release();
      }
      bar.stop(`${i.name} built in ${fmtSecs(t0)}`);
    }

    const after = await queryIndexStatus(db);
    printTable(
      ['index', 'size'],
      after.filter((i) => i.exists).map((i) => [i.name, humanBytes(i.bytes)])
    );
  } finally {
    await db.end();
  }
};

/** A source whose manifest resolves to something ingestible. */
interface ReadySource {
  id: string;
  manifest: Manifest;
  inputs: string[];
}

/**
 * Every manifest that `readManifest` + `ingestInputs` resolve without
 * returning a `pending` ManifestError -- the same "ready" definition `list
 * manifests` reports, but derived directly rather than re-deriving it from
 * the s/e/o stage probe (which goes through the runner and is about staging,
 * not about whether ingest itself can run).
 */
const readySources = (): ReadySource[] => {
  const out: ReadySource[] = [];
  for (const id of listManifestIds(PROJECT_ROOT)) {
    const r = readManifest(manifestPath(id, PROJECT_ROOT), PROJECT_ROOT).chain(
      (manifest) =>
        ingestInputs(manifest).map((inputs) => ({ id, manifest, inputs }))
    );
    if (r.isOk) {
      out.push(r.value);
    } else if (r.error.kind === 'invalid') {
      // Not staged (or a dead end) is expected and skipped; a manifest that is
      // actually wrong is not something to walk past silently.
      throw r.error;
    }
  }
  return out;
};

/**
 * Ingests every source `list manifests` would report as `ready`, one at a
 * time so each adapter's live progress bar/spinner stays legible.
 *
 * Unlike single-source `ingest` -- which is expected to be babysat -- a
 * failure in one source here must not abort the rest of an unattended,
 * possibly hours-long run: each source is wrapped in its own try/catch and
 * recorded, and the run only exits non-zero at the end if something failed.
 *
 * Sources that already completed are skipped, so an interrupted pass resumes
 * where it stopped rather than restarting from the top. That matters because
 * re-reading a done source is not free even though it is harmless: a resumed
 * run once spent hours re-parsing 4chan-threads to insert zero rows, every
 * one of them rejected by ON CONFLICT. Only a clean adapter return marks a
 * source done -- see markSourceCompleted.
 */
const cmdIngestAll = async (o: IngestAllArgs): Promise<void> => {
  let ready: ReadySource[];
  try {
    ready = readySources();
  } catch (e) {
    fail(String((e as Error).message));
  }
  if (ready.length === 0) {
    console.log(
      "no ready sources — run `list manifests` to see what's pending"
    );
    return;
  }

  // Stopgap for resuming a partial run: skip sources already known to be
  // done. A typo here silently re-ingests something you meant to skip (which
  // is slow but not wrong, since ingest is idempotent), so unmatched names
  // are called out rather than ignored.
  const excluded = new Set(o.exclude ?? []);
  const unknown = [...excluded].filter((id) => !ready.some((r) => r.id === id));
  if (unknown.length) {
    fail(`--exclude names no ready source: ${unknown.join(', ')}`);
  }
  if (excluded.size) {
    ready = ready.filter((r) => !excluded.has(r.id));
    console.log(
      `excluding ${excluded.size} source(s): ${[...excluded].join(', ')}`
    );
  }

  const redo = new Set(o.redo ?? []);
  const unknownRedo = [...redo].filter((id) => !ready.some((r) => r.id === id));
  if (unknownRedo.length) {
    fail(`--redo names no ready source: ${unknownRedo.join(', ')}`);
  }

  // Completion lives in the database, so a dry run can only report what will
  // actually be skipped when it has one. Without --db it still lists the ready
  // set, but says plainly that it cannot see completion rather than implying
  // every source listed would run.
  if (o['dry-run'] && !connectionString(o)) {
    console.log(
      `${ready.length} ready source(s) (no --db: cannot tell which are already complete):`
    );
    for (const { id, manifest } of ready) {
      console.log(`  ${id} [${manifest.adapter}] <- ${manifest.path}`);
    }
    return;
  }

  if (!connectionString(o)) {
    fail('ingest-all requires --db');
  }

  const results: { name: string; ok: boolean; posts: number; secs: number }[] =
    [];
  const db = await openDb(connectionString(o));
  try {
    const done = o.force ? new Map<string, Date>() : await completedSources(db);
    // --redo and --force only decide what the skip check below sees; neither
    // writes. A re-run that succeeds refreshes completed_at through the same
    // markSourceCompleted call every other run uses, and a re-run that fails
    // leaves the previous timestamp alone rather than destroying the record
    // of when the source last did finish.
    for (const { id, manifest } of ready) {
      if (redo.has(id)) {
        done.delete(manifest.name);
      }
    }

    const skipped = ready.filter((r) => done.has(r.manifest.name));
    ready = ready.filter((r) => !done.has(r.manifest.name));

    if (o['dry-run']) {
      for (const { id, manifest } of skipped) {
        const at = done
          .get(manifest.name)
          ?.toISOString()
          .replace('T', ' ')
          .slice(0, 19);
        console.log(`  skip  ${id} — completed ${at}`);
      }
      console.log(`${ready.length} source(s) would be ingested:`);
      for (const { id, manifest } of ready) {
        console.log(`  run   ${id} [${manifest.adapter}] <- ${manifest.path}`);
      }
      return;
    }

    // Not an error and not auto-fixed -- dropping an index is the user's
    // call, and rebuilding one costs hours. But a long unattended run that
    // is silently paying for them is worth one line up front.
    const present = (await queryIndexStatus(db)).filter((i) => i.exists);
    if (present.length) {
      log.warn(
        `${present.length} query index(es) present ` +
          `(${humanBytes(present.reduce((n, i) => n + i.bytes, 0))}) — ingest maintains ` +
          `these per row for no benefit.\n  \`indexes drop\` first, \`indexes build\` after, ` +
          `if this is a bulk load.`
      );
    }

    if (skipped.length) {
      console.log(
        `skipping ${skipped.length} already-complete source(s): ` +
          `${skipped.map((r) => r.id).join(', ')}\n` +
          `  (re-run one with --redo <source>, or every one with --force)`
      );
    }
    if (ready.length === 0) {
      console.log(
        'nothing left to ingest — every ready source is already complete'
      );
      return;
    }

    for (const { id, manifest, inputs } of ready) {
      log.step(`${id} [${manifest.adapter}] <- ${manifest.path}`);
      const t0 = Date.now();
      try {
        const sourceId = await getOrCreateSource(
          db,
          manifest.name,
          manifest.link
        );
        const { posts, summary } = await ingestOne(
          db,
          manifest,
          sourceId,
          inputs,
          undefined
        );
        // Only a normal return counts. A source that threw has still written
        // rows, and marking it here would make the next run skip a source
        // that never finished.
        await markSourceCompleted(db, sourceId);
        const secs = (Date.now() - t0) / 1000;
        log.success(summary);
        results.push({ name: id, ok: true, posts, secs });
      } catch (e) {
        const secs = (Date.now() - t0) / 1000;
        const msg = String((e as Error).message);
        log.error(`${id} failed: ${msg}`);
        results.push({ name: id, ok: false, posts: 0, secs });
      }
    }
  } finally {
    await db.end();
  }

  console.log();
  printTable(
    ['source', 'status', 'posts', 'seconds'],
    results.map((r) => [
      r.name,
      r.ok ? 'ok' : 'FAILED',
      r.posts,
      Math.round(r.secs * 10) / 10,
    ])
  );
  if (results.some((r) => !r.ok)) {
    process.exit(1);
  }
};

/**
 * Registry view: what's in sources/, and how far each has got.
 *
 * Stage checks go through the runner, so a remote setup reports on the NAS
 * rather than on whatever the local SMB mount happens to be showing (that
 * mount drops periodically and would otherwise report everything missing).
 */
const cmdListManifests = async (o: ListManifestsArgs): Promise<void> => {
  const ids = listManifestIds(PROJECT_ROOT);
  if (ids.length === 0) {
    console.log(`no manifests in ${SOURCES_DIR}/`);
    return;
  }

  const runnerR = await makeRunner({
    projectRoot: PROJECT_ROOT,
    host: o.remote,
    forceLocal: o.local,
    key: o.key,
  });
  if (runnerR.isErr) {
    fail(runnerR.error.message);
  }
  const runner = runnerR.value;
  try {
    const rows: (string | number | null)[][] = [];
    for (const id of ids) {
      let adapter = '-';
      let stages = '';
      let status = 'ready';
      try {
        const infoR = readSourceInfo(manifestPath(id, PROJECT_ROOT));
        if (infoR.isErr) {
          throw infoR.error;
        }
        const info = infoR.value;
        const base = runner.path(
          runner.rootIsDatasets ? info.dirFromDatasets : info.dir
        );

        // Read the manifest before probing, so the probe can also ask about
        // the real ingest input rather than only the conventional stage dirs.
        let ingestRel: string | null = null;
        // A manifest that is *wrong* is not a manifest that is *unstaged*.
        // Both used to collapse to "pending" here, because the read threw and
        // one catch swallowed either kind -- so a typo in an adapter name
        // looked exactly like a source waiting on its prepare step. The
        // Result carries the distinction, so keep it.
        let broken = false;
        const mR = readManifest(manifestPath(id, PROJECT_ROOT), PROJECT_ROOT);
        if (mR.isOk) {
          const m = mR.value;
          adapter = m.adapter;
          // manifest.path is absolute once resolved; express it relative to
          // the dataset dir so it works through a datasets-rooted runner too.
          const rel = relative(resolve(PROJECT_ROOT, info.dir), m.path) || '.';
          if (!rel.startsWith('..')) {
            ingestRel = rel;
          }
        } else {
          adapter = '-';
          broken = mR.error.kind === 'invalid';
        }

        const nonEmpty = (p: string, yes: string, no: string): string =>
          `if [ -n "$(ls -A ${shQuote(p)} 2>/dev/null)" ]; then printf '${yes}'; else printf '${no}'; fi`;
        // Still one shell round-trip per source: the three stage dirs, plus
        // the ingest input when we know where it is.
        const cmds = ['source', 'extracted', 'out'].map((s) =>
          nonEmpty(`${base}/${s}`, s[0], '-')
        );
        if (ingestRel) {
          cmds.push(nonEmpty(`${base}/${ingestRel}`, 'y', 'n'));
        }
        const probe = await runner.exec(cmds.join('; '));
        const outv = probe.stdout.trim();
        stages = outv.slice(0, 3);

        // "ready" means the ingest input actually holds something and an
        // adapter is declared. Testing out/ specifically was wrong: ingest.path
        // does not have to be out/ -- 4chan-threads points at a directory
        // inside dir -- so a fully ingested source reported "pending" and
        // invited someone to download it all over again. Fall back to the out/
        // test only when the manifest could not be read at all.
        const hasInput = ingestRel
          ? outv.slice(3) === 'y'
          : stages.endsWith('o');
        // A dead end outranks both: it is not waiting on anything, so listing
        // it as "pending" would invite a repeat survey of the item.
        if (broken) {
          status = 'error';
        } else if (info.deadEnd) {
          status = 'dead-end';
        } else {
          status = hasInput && adapter !== '-' ? 'ready' : 'pending';
        }
      } catch (e) {
        status =
          e instanceof ManifestError && e.kind === 'pending'
            ? 'pending'
            : 'error';
      }
      rows.push([id, adapter, stages, status]);
    }
    printTable(['source', 'adapter', 's/e/o', 'status'], rows);
  } finally {
    await runner.close();
  }
};

/**
 * Board list from the summary table.
 *
 * Distinct from `list boards`, which dedupes post/thread numbers across
 * overlapping archives by scanning `posts` — accurate but minutes-long on a
 * large store. This reads pre-rolled counts instead, so it answers "which
 * boards exist and when is their data from" immediately; the counts are raw
 * per-archive contributions and can double-count a post held twice.
 */
const cmdBoards = async (o: BoardsArgs): Promise<void> => {
  if (!connectionString(o)) {
    fail('boards requires --db');
  }
  const db = await openDb(connectionString(o));
  try {
    if (!(await hasStats(db))) {
      fail('post_stats is empty — run: cli.ts refresh-stats --db <file>');
    }
    const rows = await boardList(db);
    if (rows.length === 0) {
      console.log('no boards recorded');
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
      ['site', 'board', 'posts', 'first', 'last'],
      body,
      body.length > 1
        ? totalsRow(['label', 'blank', 'sum', 'min', 'max'], body)
        : undefined
    );
  } finally {
    await db.end();
  }
};

/**
 * Rebuilds the post_stats summary table.
 *
 * Ingest keeps it current, so this is for backfilling a store that predates
 * the table. One full pass over `posts`.
 */
const cmdRefreshStats = async (o: RefreshStatsArgs): Promise<void> => {
  if (!connectionString(o)) {
    fail('refresh-stats requires --db');
  }
  const db = await openDb(connectionString(o));
  try {
    console.log('rebuilding post_stats (one full pass over posts) ...');
    const t0 = Date.now();
    const rows = await refreshPostStats(db);
    console.log(
      `wrote ${rows} rows in ${((Date.now() - t0) / 1000).toFixed(1)}s`
    );
  } finally {
    await db.end();
  }
};

const FILTER_OPTIONS = {
  db: { type: 'string' },
  phrase: { type: 'string' },
  board: { type: 'string' },
  site: { type: 'string', default: '4chan' },
  from: { type: 'string' },
  to: { type: 'string' },
} as const;

interface FilterValues {
  phrase?: string;
  board?: string;
  site: string;
  from?: string;
  to?: string;
}

/** WHERE clauses + params shared by `count` and `search`. */
const phraseFilters = (
  o: FilterValues
): {
  where: string;
  params: (string | number)[];
} => {
  const where: string[] = [
    "p.search_vector @@ phraseto_tsquery('simple', $1)",
    'p.site = $2',
  ];
  const params: (string | number)[] = [o.phrase!, o.site];
  if (o.board) {
    params.push(o.board);
    where.push(`p.board = $${params.length}`);
  }
  if (o.from) {
    params.push(parseBound(o.from, false));
    where.push(`p.ts_utc >= $${params.length}`);
  }
  if (o.to) {
    params.push(parseBound(o.to, true));
    where.push(`p.ts_utc < $${params.length}`);
  }
  return { where: where.join(' AND '), params };
};

const BUCKET_FORMATS: Record<string, string> = {
  day: 'YYYY-MM-DD',
  month: 'YYYY-MM',
  year: 'YYYY',
};

const cmdCount = async (o: CountArgs): Promise<void> => {
  if (!connectionString(o) || !o.phrase) {
    fail('count requires --db and --phrase');
  }
  if (o.by !== 'total' && !(o.by in BUCKET_FORMATS)) {
    fail(
      `--by must be one of: ${Object.keys(BUCKET_FORMATS).join(', ')}, total`
    );
  }

  const { where, params } = phraseFilters(o);

  // A plain COUNT(*) is correct because posts holds one row per post: the
  // UNIQUE (site, board, post_no) constraint means an archive that also had
  // the post contributed no second row to count.
  const bucketExpr =
    o.by === 'total'
      ? "'total'"
      : `to_char(to_timestamp(p.ts_utc) AT TIME ZONE 'UTC', '${BUCKET_FORMATS[o.by]}')`;
  const sql = `
    SELECT ${bucketExpr} AS bucket,
           COUNT(*) AS posts
    FROM posts p
    WHERE ${where}
    GROUP BY bucket
    ORDER BY bucket
  `;

  const db = await openDb(connectionString(o));
  try {
    const { rows } = await db.query<{ bucket: string | null; posts: number }>(
      sql,
      params
    );
    if (rows.length === 0) {
      console.log('no matches');
      return;
    }
    let total = 0;
    for (const r of rows) {
      console.log(`${r.bucket ?? '(no date)'}\t${r.posts}`);
      total += r.posts;
    }
    if (o.by !== 'total') {
      console.log(`total\t${total}`);
    }
  } finally {
    await db.end();
  }
};

/**
 * Write to stdout, waiting when the pipe is full.
 *
 * `console.log` returns before the bytes are gone and queues the rest in
 * memory, which is invisible at twenty rows and is the whole problem at two
 * million: the process grows to hold output the terminal has not read yet.
 * Honouring `drain` bounds it.
 *
 * EPIPE is not an error here. `search | head` closes the pipe on purpose, and
 * the useful behaviour is to stop, not to print a stack trace over the output
 * the user asked for.
 */
const write = async (s: string): Promise<void> => {
  if (!s) {
    return;
  }
  try {
    if (!process.stdout.write(s)) {
      await once(process.stdout, 'drain');
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EPIPE') {
      process.exit(0);
    }
    throw e;
  }
};

const cmdSearch = async (o: SearchArgs): Promise<void> => {
  if (!connectionString(o) || !o.phrase) {
    fail('search requires --db and --phrase');
  }
  // Unset means every match. `optional` gives undefined, and Number(undefined)
  // is NaN rather than 0, so the guard below must test for the absence first
  // or "no limit" reads as "invalid limit".
  const limit = o.limit == null ? null : Number(o.limit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) {
    fail(`invalid --limit: ${o.limit}`);
  }

  const { where, params } = phraseFilters(o);
  // No GROUP BY: posts holds one row per post, so there are no copies to
  // collapse. Dropping it also lets the LIMIT short-circuit -- grouping
  // forced every match to be materialized and sorted before the first row
  // could be returned.
  const sql = `
    SELECT p.board, p.thread_no, p.post_no, p.is_op, p.ts_utc,
           p.name, p.tripcode, p.subject, p.body_text
    FROM posts p
    WHERE ${where}
    ORDER BY p.ts_utc, p.post_no
    ${limit === null ? '' : `LIMIT $${params.length + 1}`}
  `;
  const totalSql = `
    SELECT COUNT(*) AS n
    FROM posts p
    WHERE ${where}
  `;

  interface Hit {
    board: string;
    thread_no: number;
    post_no: number;
    is_op: boolean;
    ts_utc: number | null;
    name: string | null;
    tripcode: string | null;
    subject: string | null;
    body_text: string | null;
  }

  const renderHit = (r: Hit): string => {
    const when = r.ts_utc
      ? new Date(r.ts_utc * 1000).toISOString().replace('T', ' ').slice(0, 16)
      : '(no date)';
    const who = `${r.name ?? 'Anonymous'}${r.tripcode ?? ''}`;
    let header = `[${when}] /${r.board}/${r.post_no}`;
    if (r.is_op) {
      header += ' (OP)';
    } else {
      header += ` in ${r.thread_no}`;
    }
    header += ` — ${who}`;
    if (r.subject) {
      header += ` — “${r.subject}”`;
    }
    const body = r.body_text ? `${r.body_text.replace(/^/gm, '  ')}\n` : '';
    return `${header}\n${body}\n`;
  };

  const db = await openDb(connectionString(o));
  // A server-side cursor rather than one buffered result set. With no default
  // limit a broad phrase can match millions of posts, and node-postgres
  // materializes an entire result before handing it back -- the row count is
  // the user's business, but running the process out of memory is not.
  const client = await db.connect();
  let seen = 0;
  try {
    await client.query('BEGIN');
    await client.query(
      `DECLARE search_hits NO SCROLL CURSOR FOR ${sql}`,
      limit === null ? params : [...params, limit]
    );
    for (;;) {
      const { rows } = await client.query<Hit>('FETCH FORWARD 500 search_hits');
      if (rows.length === 0) {
        break;
      }
      for (const r of rows) {
        if (o.json) {
          await write(seen === 0 ? '[\n' : ',\n');
          await write(JSON.stringify(r));
        } else {
          await write(renderHit(r));
        }
        seen++;
      }
    }
    if (o.json) {
      await write(seen === 0 ? '[]\n' : '\n]\n');
    }
    if (seen === 0 && !o.json) {
      console.log('no matches');
      return;
    }
    // Only when the limit is what stopped us. Previously this COUNT(*) ran on
    // every search, including ones that had already returned every match --
    // a second full pass over the matching rows, which on this store is the
    // expensive half of the query (the GIN lookup is milliseconds; the heap
    // recheck is minutes).
    if (!o.json && limit !== null && seen === limit) {
      const { rows } = await client.query<{ n: number }>(totalSql, params);
      const total = rows[0]!.n;
      if (total > seen) {
        console.log(
          `(showing ${seen} of ${total} matching posts; raise or drop --limit for more)`
        );
      }
    }
  } finally {
    // The cursor dies with the transaction; ending it explicitly keeps the
    // pooled connection clean for release.
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
    await db.end();
  }
};

const printTable = (
  headers: string[],
  rows: (string | number | null)[][],
  footer?: (string | number | null)[]
): void => {
  const bodyAndFoot = footer ? [...rows, footer] : rows;
  const numeric = headers.map((_, i) =>
    rows.every((r) => r[i] == null || typeof r[i] === 'number')
  );
  const fmt = (v: string | number | null): string => {
    if (v == null) {
      return '-';
    }
    return typeof v === 'number' ? v.toLocaleString('en-US') : v;
  };
  const cells = bodyAndFoot.map((r) => r.map(fmt));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => r[i].length))
  );
  const line = (row: string[]): string =>
    row
      .map((c, i) => (numeric[i] ? c.padStart(widths[i]) : c.padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  const rule = line(widths.map((w) => '-'.repeat(w)));
  console.log(line(headers));
  console.log(rule);
  for (const r of cells.slice(0, rows.length)) {
    console.log(line(r));
  }
  if (footer) {
    console.log(rule);
    console.log(line(cells[rows.length]));
  }
};

// How each column of the totals row is derived from the body rows. "sum"
// adds the values, "min"/"max" span dates, "label" holds the "TOTAL" tag,
// and "blank" leaves free-text columns (e.g. a source link) empty.
type TotalRule = 'sum' | 'min' | 'max' | 'label' | 'blank';

const totalsRow = (
  rules: TotalRule[],
  rows: (string | number | null)[][]
): (string | number | null)[] => {
  return rules.map((rule, i) => {
    switch (rule) {
      case 'label':
        return 'TOTAL';
      case 'blank':
        return null;
      case 'sum':
        return rows.reduce((acc, r) => acc + (Number(r[i]) || 0), 0);
      case 'min':
      case 'max': {
        const vals = rows
          .map((r) => r[i])
          .filter((v): v is string => v != null);
        if (vals.length === 0) {
          return null;
        }
        return rule === 'min'
          ? vals.reduce((a, b) => (a < b ? a : b))
          : vals.reduce((a, b) => (a > b ? a : b));
      }
    }
  });
};

const LIST_QUERIES: Record<
  string,
  { headers: string[]; totals: TotalRule[]; sql: string }
> = {
  boards: {
    headers: ['site', 'board', 'posts', 'threads', 'first', 'last'],
    // posts/threads sum cleanly since each belongs to exactly one board
    totals: ['label', 'blank', 'sum', 'sum', 'min', 'max'],
    sql: `
      SELECT p.site, p.board,
             COUNT(*) AS posts,
             COUNT(DISTINCT p.thread_no) AS threads,
             to_char(to_timestamp(MIN(p.ts_utc)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS first,
             to_char(to_timestamp(MAX(p.ts_utc)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last
      FROM posts p {WHERE}
      GROUP BY p.site, p.board
      ORDER BY p.site, p.board`,
  },
  sites: {
    headers: ['site', 'boards', 'posts', 'first', 'last'],
    totals: ['label', 'sum', 'sum', 'min', 'max'],
    sql: `
      SELECT p.site,
             COUNT(DISTINCT p.board) AS boards,
             COUNT(*) AS posts,
             to_char(to_timestamp(MIN(p.ts_utc)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS first,
             to_char(to_timestamp(MAX(p.ts_utc)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last
      FROM posts p {WHERE}
      GROUP BY p.site
      ORDER BY p.site`,
  },
  sources: {
    headers: ['source', 'posts', 'boards', 'first', 'last', 'link'],
    // Each post belongs to exactly one source -- whichever archive supplied
    // it first -- so these sum cleanly and reconcile with the site totals.
    totals: ['label', 'sum', 'sum', 'min', 'max', 'blank'],
    sql: `
      SELECT s.name,
             COUNT(p.id) AS posts,
             COUNT(DISTINCT p.site || '/' || p.board) AS boards,
             to_char(to_timestamp(MIN(p.ts_utc)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS first,
             to_char(to_timestamp(MAX(p.ts_utc)) AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS last,
             s.link
      FROM sources s
      LEFT JOIN posts p ON p.source_id = s.id {WHERE}
      GROUP BY s.id
      ORDER BY s.name`,
  },
};

const cmdList = async (o: ListQueryArgs): Promise<void> => {
  // The grammar already picked the subcommand, so there is nothing left to
  // validate here -- 'list-boards' etc. map straight onto the query table.
  const query = LIST_QUERIES[o.action.slice('list-'.length)];

  const params: string[] = [];
  let where = '';
  if (o.site) {
    where = 'WHERE p.site = $1';
    params.push(o.site);
  }
  const sql = query.sql.replace('{WHERE}', where);

  const db = await openDb(connectionString(o));
  try {
    const { rows } = await db.query<Record<string, string | number | null>>(
      sql,
      params
    );
    if (rows.length === 0) {
      console.log('database is empty');
      return;
    }
    const body = rows.map((r) => Object.values(r));
    // a totals row only adds signal when there's more than one row to total
    const footer = body.length > 1 ? totalsRow(query.totals, body) : undefined;
    printTable(query.headers, body, footer);
  } finally {
    await db.end();
  }
};

const args = await runAsync(cli, {
  contexts: [envContext, configContext],
  contextOptions: { getConfigPath: () => join(PROJECT_ROOT, CONFIG_FILE) },
  programName: 'cli.ts',
  // Both spellings: `cli.ts --help` and `cli.ts help indexes`. Without this
  // Optique registers neither and --help is just an unknown option.
  help: 'both',
});

// Exhaustive over the grammar's discriminant: a command added to parsers.ts
// without a case here is a compile error, not a silent no-op.
switch (args.action) {
  case 'download':
    await cmdDownload(args);
    break;
  case 'prepare':
    await cmdPrepare(args);
    break;
  case 'prepare-runtime':
    await cmdPrepareRuntime(args);
    break;
  case 'warc-extract':
    await cmdWarcExtract(args);
    break;
  case 'ingest':
    await cmdIngest(args);
    break;
  case 'ingest-all':
    await cmdIngestAll(args);
    break;
  case 'indexes':
    await cmdIndexes(args);
    break;
  case 'boards':
    await cmdBoards(args);
    break;
  case 'refresh-stats':
    await cmdRefreshStats(args);
    break;
  case 'count':
    await cmdCount(args);
    break;
  case 'search':
    await cmdSearch(args);
    break;
  case 'list-manifests':
    await cmdListManifests(args);
    break;
  case 'list-boards':
  case 'list-sites':
  case 'list-sources':
    await cmdList(args);
    break;
  default: {
    const never: never = args;
    throw new Error(`unhandled command: ${JSON.stringify(never)}`);
  }
}
