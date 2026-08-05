import { log } from '@clack/prompts';
import type { Pool } from 'pg';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

import { ingestChanHtml } from './adapters/chan-html.ts';
import { ingestDesuarchiveSql } from './adapters/desuarchive-sql.ts';
import { ingestFuukaSql } from './adapters/fuuka-sql.ts';
import { ingestFybertechHtml } from './adapters/fybertech-html.ts';
import { ingestJsonApi } from './adapters/json-api.ts';
import { ingestPostsThreadsSql } from './adapters/posts-threads-sql.ts';
import { ingestWarosuSql } from './adapters/warosu-sql.ts';
import {
  downloadItem,
  fetchItem,
  humanBytes,
  identifierFromLink,
} from './archive-org.ts';
import {
  openDb,
  getOrCreateSource,
  markSourceCompleted,
  completedSources,
  QUERY_INDEXES,
  queryIndexStatus,
} from './db.ts';
import {
  ingestInputs,
  listManifestIds,
  manifestPath,
  PendingSourceError,
  readManifest,
  readSourceInfo,
  SOURCES_DIR,
} from './manifest.ts';
import type { Manifest } from './manifest.ts';
import { runPrepare } from './prepare.ts';
import { makeBar } from './progress.ts';
import { makeRunner, shQuote } from './runner.ts';
import { boardList, hasStats, refreshPostStats } from './stats.ts';
import { htmlPages, uriToFilename } from './warc.ts';

/**
 * Repo root; manifest ingest paths are resolved against it.
 *
 * Found by walking up to the directory holding `sources/` rather than by a
 * fixed number of `..` hops, so moving this package within the workspace
 * doesn't silently resolve archive paths somewhere wrong.
 */
const findProjectRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, SOURCES_DIR))) return dir;
    const up = dirname(dir);
    if (up === dir) {
      throw new Error(
        `could not locate the repo root (no ${SOURCES_DIR}/ above ${import.meta.url})`
      );
    }
    dir = up;
  }
};

const PROJECT_ROOT = findProjectRoot();

const USAGE = `Usage:
  cli.ts download <source> [--remote <host>] [--local] [--dry-run] [--force]
  cli.ts prepare <source> [--remote <host>] [--local] [--dry-run] [--force]
  cli.ts warc-extract --warc <file.warc[.gz]> --out <dir> [--host <regex>]
  cli.ts ingest <source> --db <file> [--board <b> ...]
  cli.ts ingest-all --db <file> [--dry-run] [--exclude <source> ...] [--redo <source> ...] [--force]
  cli.ts indexes build|drop|status --db <file> [--memory 4GB]
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

ingest-all skips sources whose last run finished cleanly, so an interrupted
pass resumes instead of re-reading tens of GB that ON CONFLICT would discard.
Re-staging an archive or fixing an adapter bug invalidates that: --redo
<source> re-ingests one anyway, --force re-ingests every one. Both refresh
completed_at when the run finishes.

The query-time indexes on posts are NOT created on connect — ingest only
needs the UNIQUE constraint, and maintaining the rest per-insert costs far
more than sorting them once at the end. A bulk load is therefore:
  indexes drop  ->  ingest-all  ->  indexes build
"indexes status" says which are present. Queries want them; ingest does not.

Dates are YYYY, YYYY-MM, or YYYY-MM-DD (UTC). --from/--to are both inclusive:
--to 2018-09 means "through the end of September 2018".`;

// Explicitly typed so calls still end control flow — see `bad` in manifest.ts.
const fail: (msg: string) => never = (msg) => {
  console.error(msg);
  console.error();
  console.error(USAGE);
  process.exit(1);
};

/** Parse a date bound; returns epoch seconds. End bounds are advanced by one
 * unit of their precision so they can be used as an exclusive upper bound. */
const parseBound = (s: string, end: boolean): number => {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s);
  if (!m) fail(`invalid date: ${s}`);
  let [year, month, day] = [
    Number(m[1]),
    m[2] ? Number(m[2]) : null,
    m[3] ? Number(m[3]) : null,
  ];
  if (end) {
    if (day != null) day++;
    else if (month != null) month++;
    else year++;
  }
  return Date.UTC(year, (month ?? 1) - 1, day ?? 1) / 1000;
};

const cmdDownload = async (argv: string[]): Promise<void> => {
  const id = argv[0];
  if (!id || id.startsWith('-')) {
    const ids = listManifestIds(PROJECT_ROOT);
    fail(
      `download requires a source name\n\nKnown sources:\n` +
        (ids.length ? ids.map((s) => `  ${s}`).join('\n') : '  (none)')
    );
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      remote: { type: 'string' },
      local: { type: 'boolean' },
      key: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
      all: { type: 'boolean' },
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
  console.log(`${item.identifier}: ${item.title ?? '(untitled)'}`);
  console.log(`${item.files.length} files, ${humanBytes(item.totalBytes)}`);

  // Image/thumbnail payloads are excluded per-manifest; --all overrides.
  if (info.downloadExclude.length && !values.all) {
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

  const runner = await makeRunner({
    projectRoot: PROJECT_ROOT,
    host: values.remote,
    forceLocal: values.local,
    key: values.key,
  });
  try {
    const dest = runner.path(
      runner.rootIsDatasets ? info.stageDirFromDatasets : info.stageDir
    );
    console.log(`destination: ${dest} (${runner.where})\n`);
    const results = await downloadItem({
      item,
      dest,
      runner,
      force: values.force,
      dryRun: values['dry-run'],
    });

    const by = (s: string): number =>
      results.filter((r) => r.status === s).length;
    console.log(
      `\n${by('downloaded')} downloaded, ${by('skipped')} skipped, ${by('failed')} failed`
    );
    const failed = results.filter((r) => r.status === 'failed');
    if (failed.length) {
      for (const f of failed) console.error(`  ${f.name}: ${f.detail}`);
      process.exitCode = 1;
    }
  } finally {
    await runner.close();
  }
};

const cmdPrepare = async (argv: string[]): Promise<void> => {
  const id = argv[0];
  if (!id || id.startsWith('-')) {
    const ids = listManifestIds(PROJECT_ROOT);
    fail(
      `prepare requires a source name\n\nKnown sources:\n` +
        (ids.length ? ids.map((s) => `  ${s}`).join('\n') : '  (none)')
    );
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      remote: { type: 'string' },
      local: { type: 'boolean' },
      key: { type: 'string' },
      'dry-run': { type: 'boolean' },
      force: { type: 'boolean' },
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
      dryRun: values['dry-run'],
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
    if (!res.skipped && !values['dry-run']) {
      console.log(`\n${res.ran} step(s) completed -> ${info.prepareOutput}/`);
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
const cmdWarcExtract = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      warc: { type: 'string' },
      out: { type: 'string' },
      host: { type: 'string', default: 'boards\\.4chan(?:nel)?\\.org' },
      remote: { type: 'string' },
      local: { type: 'boolean' },
      key: { type: 'string' },
    },
  });
  if (!values.warc || !values.out)
    fail('warc-extract requires --warc and --out');
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
      `test -d ${shQuote(values.warc)} && echo dir || echo file`
    );
    let warcs: string[];
    if (probe.stdout.trim() === 'dir') {
      const ls = await runner.exec(
        `find ${shQuote(values.warc)} -type f \\( -name '*.warc' -o -name '*.warc.gz' \\) | sort`
      );
      warcs = ls.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (warcs.length === 0)
        fail(`no .warc/.warc.gz files under ${values.warc}`);
      console.log(`${warcs.length} WARC file(s)`);
    } else {
      warcs = [values.warc];
    }

    const outDir = values.out.replace(/\/$/, '');
    let n = 0;
    for (const w of warcs) {
      const raw = await runner.readFile(w);
      // Items ship the WARC gzipped; accept either form.
      const buf = w.endsWith('.gz') ? gunzipSync(raw) : raw;
      for (const rec of htmlPages(buf, hostRe)) {
        const name = uriToFilename(rec.uri!);
        await runner.writeFile(`${outDir}/${name}`, rec.body);
        console.log(`  ${name} (${rec.body.length} bytes) <- ${rec.uri}`);
        n++;
      }
    }
    if (n === 0)
      fail(`no HTML pages matching /${values.host}/ in ${values.warc}`);
    console.log(`extracted ${n} page(s)`);
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

  if (manifest.adapter === 'json-api') {
    const stats = await ingestJsonApi(db, {
      root: inputs[0],
      sourceId,
      site: manifest.site,
      boards,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    return {
      posts: stats.posts,
      summary:
        `ingested ${stats.posts} posts from ${stats.threads} threads in ${secs}s` +
        ` (${stats.skippedPosts} posts already present/skipped, ${stats.badFiles} unreadable files)`,
    };
  } else if (manifest.adapter === 'chan-html') {
    const stats = await ingestChanHtml(db, {
      root: inputs[0],
      sourceId,
      site: manifest.site,
      boards,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    return {
      posts: stats.posts,
      summary:
        `ingested ${stats.posts} posts from ${stats.files} page(s)` +
        ` (${stats.threads} thread page(s)) in ${secs}s` +
        ` (${stats.skippedDup} already present, ${stats.badFiles} unrecognized` +
        (stats.skippedForeign > 0
          ? `, ${stats.skippedForeign} not in 4chan's own markup`
          : '') +
        `)`,
    };
  } else if (manifest.adapter === 'fybertech-html') {
    const stats = await ingestFybertechHtml(db, {
      root: inputs[0],
      sourceId,
      site: manifest.site,
      boards,
    });
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    return {
      posts: stats.posts,
      summary:
        `ingested ${stats.posts} posts from ${stats.files} thread page(s) in ${secs}s` +
        ` (${stats.skippedDup} already present, ${stats.badFiles} with no posts,` +
        ` ${stats.skippedNative} in 4chan's own markup — ingest those with chan-html)`,
    };
  } else {
    const ingest =
      manifest.adapter === 'fuuka-sql'
        ? ingestFuukaSql
        : manifest.adapter === 'desuarchive-sql'
          ? ingestDesuarchiveSql
          : manifest.adapter === 'posts-threads-sql'
            ? ingestPostsThreadsSql
            : ingestWarosuSql;
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
        boards,
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

const cmdIngest = async (argv: string[]): Promise<void> => {
  const id = argv[0];
  if (!id || id.startsWith('-')) {
    const ids = listManifestIds(PROJECT_ROOT);
    fail(
      `ingest requires a source name\n\nKnown sources:\n` +
        (ids.length ? ids.map((s) => `  ${s}`).join('\n') : '  (none)')
    );
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      db: { type: 'string' },
      board: { type: 'string', multiple: true },
    },
  });
  if (!values.db) fail('ingest requires --db');

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

  const db = await openDb(values.db);
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
      values.board
    );
    console.log(summary);
    // A --board run covers part of the source, so it is progress, not
    // completion -- leaving completed_at null keeps ingest-all honest about
    // the boards this run never looked at.
    if (values.board?.length) {
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

/** Elapsed since `t0`, as a human duration. Index builds run into hours. */
const fmtSecs = (t0: number): string => {
  const s = (Date.now() - t0) / 1000;
  if (s < 90) return `${s.toFixed(1)}s`;
  if (s < 5400) return `${(s / 60).toFixed(1)}m`;
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
const cmdIndexes = async (argv: string[]): Promise<void> => {
  const action = argv[0];
  if (!action || !['build', 'drop', 'status'].includes(action)) {
    fail('indexes requires one of: build, drop, status');
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: { db: { type: 'string' }, memory: { type: 'string' } },
  });
  if (!values.db) fail('indexes requires --db');

  const db = await openDb(values.db);
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
    const memory = values.memory ?? '4GB';
    const missing = before.filter((i) => !i.exists);
    if (!missing.length) {
      console.log('all query indexes already present — nothing to build');
      return;
    }
    console.log(
      `building ${missing.length} index(es) with maintenance_work_mem=${memory}\n` +
        `  each takes an ACCESS EXCLUSIVE lock on posts; queries against it will block`
    );
    for (const i of missing) {
      const spec = QUERY_INDEXES.find((q) => q.name === i.name);
      if (!spec) continue;
      const bar = makeBar({});
      bar.start(`${i.name}`);
      const t0 = Date.now();
      // A dedicated client: SET is per-session, and a pooled query could
      // otherwise land on a connection that never saw it.
      const client = await db.connect();
      try {
        await client.query(`SET maintenance_work_mem = '${memory}'`);
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
 * throwing `PendingSourceError` -- the same "ready" definition `list
 * manifests` reports, but derived directly rather than re-deriving it from
 * the s/e/o stage probe (which goes through the runner and is about staging,
 * not about whether ingest itself can run).
 */
const readySources = (): ReadySource[] => {
  const out: ReadySource[] = [];
  for (const id of listManifestIds(PROJECT_ROOT)) {
    try {
      const manifest = readManifest(
        manifestPath(id, PROJECT_ROOT),
        PROJECT_ROOT
      );
      const inputs = ingestInputs(manifest);
      out.push({ id, manifest, inputs });
    } catch (e) {
      if (e instanceof PendingSourceError) continue; // not staged, or a dead end
      throw e; // a real problem with an otherwise-ready manifest
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
const cmdIngestAll = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: 'string' },
      'dry-run': { type: 'boolean' },
      exclude: { type: 'string', multiple: true },
      redo: { type: 'string', multiple: true },
      force: { type: 'boolean' },
    },
  });

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
  const excluded = new Set(values.exclude ?? []);
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

  const redo = new Set(values.redo ?? []);
  const unknownRedo = [...redo].filter((id) => !ready.some((r) => r.id === id));
  if (unknownRedo.length) {
    fail(`--redo names no ready source: ${unknownRedo.join(', ')}`);
  }

  // Completion lives in the database, so a dry run can only report what will
  // actually be skipped when it has one. Without --db it still lists the ready
  // set, but says plainly that it cannot see completion rather than implying
  // every source listed would run.
  if (values['dry-run'] && !values.db) {
    console.log(
      `${ready.length} ready source(s) (no --db: cannot tell which are already complete):`
    );
    for (const { id, manifest } of ready) {
      console.log(`  ${id} [${manifest.adapter}] <- ${manifest.path}`);
    }
    return;
  }

  if (!values.db) fail('ingest-all requires --db');

  const results: { name: string; ok: boolean; posts: number; secs: number }[] =
    [];
  const db = await openDb(values.db);
  try {
    const done = values.force
      ? new Map<string, Date>()
      : await completedSources(db);
    // --redo and --force only decide what the skip check below sees; neither
    // writes. A re-run that succeeds refreshes completed_at through the same
    // markSourceCompleted call every other run uses, and a re-run that fails
    // leaves the previous timestamp alone rather than destroying the record
    // of when the source last did finish.
    for (const { id, manifest } of ready) {
      if (redo.has(id)) done.delete(manifest.name);
    }

    const skipped = ready.filter((r) => done.has(r.manifest.name));
    ready = ready.filter((r) => !done.has(r.manifest.name));

    if (values['dry-run']) {
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
  if (results.some((r) => !r.ok)) process.exit(1);
};

/**
 * Registry view: what's in sources/, and how far each has got.
 *
 * Stage checks go through the runner, so a remote setup reports on the NAS
 * rather than on whatever the local SMB mount happens to be showing (that
 * mount drops periodically and would otherwise report everything missing).
 */
const cmdListManifests = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      remote: { type: 'string' },
      local: { type: 'boolean' },
      key: { type: 'string' },
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
      let adapter = '-';
      let stages = '';
      let status = 'ready';
      try {
        const info = readSourceInfo(manifestPath(id, PROJECT_ROOT));
        const base = runner.path(
          runner.rootIsDatasets ? info.dirFromDatasets : info.dir
        );

        // Read the manifest before probing, so the probe can also ask about
        // the real ingest input rather than only the conventional stage dirs.
        let ingestRel: string | null = null;
        try {
          const m = readManifest(manifestPath(id, PROJECT_ROOT), PROJECT_ROOT);
          adapter = m.adapter;
          // manifest.path is absolute once resolved; express it relative to
          // the dataset dir so it works through a datasets-rooted runner too.
          const rel = relative(resolve(PROJECT_ROOT, info.dir), m.path) || '.';
          if (!rel.startsWith('..')) ingestRel = rel;
        } catch {
          adapter = '-';
        }

        const nonEmpty = (p: string, yes: string, no: string): string =>
          `if [ -n "$(ls -A ${shQuote(p)} 2>/dev/null)" ]; then printf '${yes}'; else printf '${no}'; fi`;
        // Still one shell round-trip per source: the three stage dirs, plus
        // the ingest input when we know where it is.
        const cmds = ['source', 'extracted', 'out'].map((s) =>
          nonEmpty(`${base}/${s}`, s[0], '-')
        );
        if (ingestRel) cmds.push(nonEmpty(`${base}/${ingestRel}`, 'y', 'n'));
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
        if (info.deadEnd) status = 'dead-end';
        else status = hasInput && adapter !== '-' ? 'ready' : 'pending';
      } catch (e) {
        status = e instanceof PendingSourceError ? 'pending' : 'error';
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
const cmdBoards = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: { db: { type: 'string' } },
  });
  if (!values.db) fail('boards requires --db');
  const db = await openDb(values.db);
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
const cmdRefreshStats = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: { db: { type: 'string' } },
  });
  if (!values.db) fail('refresh-stats requires --db');
  const db = await openDb(values.db);
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
  values: FilterValues
): {
  where: string;
  params: (string | number)[];
} => {
  const where: string[] = [
    "p.search_vector @@ phraseto_tsquery('simple', $1)",
    'p.site = $2',
  ];
  const params: (string | number)[] = [values.phrase!, values.site];
  if (values.board) {
    params.push(values.board);
    where.push(`p.board = $${params.length}`);
  }
  if (values.from) {
    params.push(parseBound(values.from, false));
    where.push(`p.ts_utc >= $${params.length}`);
  }
  if (values.to) {
    params.push(parseBound(values.to, true));
    where.push(`p.ts_utc < $${params.length}`);
  }
  return { where: where.join(' AND '), params };
};

const BUCKET_FORMATS: Record<string, string> = {
  day: 'YYYY-MM-DD',
  month: 'YYYY-MM',
  year: 'YYYY',
};

const cmdCount = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: { ...FILTER_OPTIONS, by: { type: 'string', default: 'month' } },
  });
  if (!values.db || !values.phrase) fail('count requires --db and --phrase');
  if (values.by !== 'total' && !(values.by in BUCKET_FORMATS)) {
    fail(
      `--by must be one of: ${Object.keys(BUCKET_FORMATS).join(', ')}, total`
    );
  }

  const { where, params } = phraseFilters(values);

  // A plain COUNT(*) is correct because posts holds one row per post: the
  // UNIQUE (site, board, post_no) constraint means an archive that also had
  // the post contributed no second row to count.
  const bucketExpr =
    values.by === 'total'
      ? "'total'"
      : `to_char(to_timestamp(p.ts_utc) AT TIME ZONE 'UTC', '${BUCKET_FORMATS[values.by]}')`;
  const sql = `
    SELECT ${bucketExpr} AS bucket,
           COUNT(*) AS posts
    FROM posts p
    WHERE ${where}
    GROUP BY bucket
    ORDER BY bucket
  `;

  const db = await openDb(values.db);
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
    if (values.by !== 'total') console.log(`total\t${total}`);
  } finally {
    await db.end();
  }
};

const cmdSearch = async (argv: string[]): Promise<void> => {
  const { values } = parseArgs({
    args: argv,
    options: { ...FILTER_OPTIONS, limit: { type: 'string', default: '20' } },
  });
  if (!values.db || !values.phrase) fail('search requires --db and --phrase');
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1)
    fail(`invalid --limit: ${values.limit}`);

  const { where, params } = phraseFilters(values);
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
    LIMIT $${params.length + 1}
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

  const db = await openDb(values.db);
  try {
    const { rows } = await db.query<Hit>(sql, [...params, limit]);
    if (rows.length === 0) {
      console.log('no matches');
      return;
    }
    for (const r of rows) {
      const when = r.ts_utc
        ? new Date(r.ts_utc * 1000).toISOString().replace('T', ' ').slice(0, 16)
        : '(no date)';
      const who = `${r.name ?? 'Anonymous'}${r.tripcode ?? ''}`;
      let header = `[${when}] /${r.board}/${r.post_no}`;
      if (r.is_op) header += ' (OP)';
      else header += ` in ${r.thread_no}`;
      header += ` — ${who}`;
      if (r.subject) header += ` — “${r.subject}”`;
      console.log(header);
      if (r.body_text) {
        console.log(r.body_text.replace(/^/gm, '  '));
      }
      console.log();
    }
    const { rows: totalRows } = await db.query<{ n: number }>(totalSql, params);
    const total = totalRows[0]!.n;
    if (total > rows.length) {
      console.log(
        `(showing ${rows.length} of ${total} matching posts; raise --limit for more)`
      );
    }
  } finally {
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
  const fmt = (v: string | number | null): string =>
    v == null ? '-' : typeof v === 'number' ? v.toLocaleString('en-US') : v;
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
  for (const r of cells.slice(0, rows.length)) console.log(line(r));
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
        if (vals.length === 0) return null;
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

const cmdList = async (argv: string[]): Promise<void> => {
  const what = argv[0];
  // `manifests` reads sources/, not the database, so it takes no --db
  if (what === 'manifests') {
    await cmdListManifests(argv.slice(1));
    return;
  }
  const query = what ? LIST_QUERIES[what] : undefined;
  if (!query) {
    fail(
      `list expects one of: ${Object.keys(LIST_QUERIES).join(', ')}, manifests`
    );
  }
  const { values } = parseArgs({
    args: argv.slice(1),
    options: {
      db: { type: 'string' },
      site: { type: 'string' },
    },
  });
  if (!values.db) fail('list requires --db');

  const params: string[] = [];
  let where = '';
  if (values.site) {
    where = 'WHERE p.site = $1';
    params.push(values.site);
  }
  const sql = query.sql.replace('{WHERE}', where);

  const db = await openDb(values.db);
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

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case 'download':
    await cmdDownload(rest);
    break;
  case 'prepare':
    await cmdPrepare(rest);
    break;
  case 'warc-extract':
    await cmdWarcExtract(rest);
    break;
  case 'ingest':
    await cmdIngest(rest);
    break;
  case 'ingest-all':
    await cmdIngestAll(rest);
    break;
  case 'indexes':
    await cmdIndexes(rest);
    break;
  case 'boards':
    await cmdBoards(rest);
    break;
  case 'refresh-stats':
    await cmdRefreshStats(rest);
    break;
  case 'count':
    await cmdCount(rest);
    break;
  case 'search':
    await cmdSearch(rest);
    break;
  case 'list':
    await cmdList(rest);
    break;
  default:
    fail(cmd ? `unknown command: ${cmd}` : 'no command given');
}
