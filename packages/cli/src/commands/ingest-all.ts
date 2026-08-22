import type { InferValue } from '@optique/core/parser';

import { log } from '@clack/prompts';
import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { multiple, withDefault } from '@optique/core/modifiers';
import {
  argument,
  command,
  constant,
  flag,
  option,
} from '@optique/core/primitives';
import { choice, string } from '@optique/core/valueparser';

import {
  openDb,
  completedSources,
  queryIndexStatus,
  getOrCreateSource,
  markSourceCompleted,
} from '../database/db.ts';
import { ingestOne } from '../database/ingest.ts';
import { humanBytes } from '../downloaders/archive-org.ts';
import { connectionString, dbOptions } from '../env.ts';
import {
  ingestInputs,
  listManifestIds,
  manifestPath,
  readManifest,
  type Manifest,
} from '../manifest.ts';
import { printTable } from '../table.ts';
import { fail } from '../utils/console.ts';
import { PROJECT_ROOT } from '../utils/paths.ts';

export const ingestAllCmd = command(
  'ingest-all',
  merge(
    object({
      action: constant('ingest-all' as const),
      'dry-run': withDefault(
        flag('--dry-run', {
          description: message`List the sources that would run, touching neither the database nor the archives.`,
        }),
        false
      ),
      exclude: multiple(
        option('--exclude', string(), {
          description: message`Skip this source on this run. Repeatable. Unrelated to whether it finished.`,
        })
      ),
      redo: multiple(
        option('--redo', string(), {
          description: message`Re-ingest this source even though it completed. Repeatable.`,
        })
      ),
      force: withDefault(
        flag('--force', {
          description: message`Re-ingest every source, completed or not.`,
        }),
        false
      ),
      'count-only': withDefault(
        flag('--count-only', {
          description: message`Run every reader and report rows, OPs and unparsed timestamps per source, writing NOTHING. Needs no --db at all, and ignores completed_at -- completion records writes, and there are none. This is the verification sweep: a plain re-ingest cannot check a staged source, because posts already in the store are rejected by ON CONFLICT and counted as zero.`,
        }),
        false
      ),
    }),
    dbOptions
  ),
  {
    description: message`Ingest every ready source in turn, skipping those whose last run finished cleanly, so an interrupted pass resumes instead of re-reading tens of GB that ON CONFLICT would discard. completed_at records COMPLETION, not progress: a source can get a long way in and still abort, so only a clean adapter return marks it. Re-staging an archive, or fixing an adapter bug that silently dropped rows, invalidates that mark -- use --redo or --force. A failure in one source does not abort the rest of the run.`,
  }
);

export type IngestAllArgs = InferValue<typeof ingestAllCmd>;

/** A source whose manifest resolves to something ingestible. */
export interface ReadySource {
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
export const readySources = (): ReadySource[] => {
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
export const execIngestAll = async (o: IngestAllArgs): Promise<void> => {
  const countOnly = o['count-only'];
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
  if (o['dry-run'] && (countOnly || !connectionString(o))) {
    console.log(
      countOnly
        ? `${ready.length} ready source(s) would be counted (completion is not consulted):`
        : `${ready.length} ready source(s) (no --db: cannot tell which are already complete):`
    );
    for (const { id, manifest } of ready) {
      console.log(`  ${id} [${manifest.adapter}] <- ${manifest.path}`);
    }
    return;
  }

  if (!countOnly && !connectionString(o)) {
    fail('ingest-all requires --db');
  }

  const results: {
    name: string;
    ok: boolean;
    posts: number;
    boards: number;
    ops: number;
    undated: number;
    ghost: number;
    bad: number;
    secs: number;
  }[] = [];
  // Count-only writes nothing, so it needs no connection at all -- not even
  // to read completion, which records writes that by definition did not
  // happen. Every ready source is surveyed on every run.
  const db = countOnly ? null : await openDb(connectionString(o));
  try {
    const done =
      o.force || !db ? new Map<string, Date>() : await completedSources(db);
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
    const present = db
      ? (await queryIndexStatus(db)).filter((i) => i.exists)
      : [];
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
        const sourceId = db
          ? await getOrCreateSource(db, manifest.name, manifest.link)
          : 0;
        const { posts, summary, totals, skipped } = await ingestOne(
          db,
          manifest,
          sourceId,
          inputs,
          undefined,
          countOnly
        );
        // Only a normal return counts. A source that threw has still written
        // rows, and marking it here would make the next run skip a source
        // that never finished.
        if (db) {
          await markSourceCompleted(db, sourceId);
        }
        const secs = (Date.now() - t0) / 1000;
        const agg = {
          boards: totals.length,
          ops: totals.reduce((n, t) => n + t.ops, 0),
          undated: totals.reduce((n, t) => n + t.nullTs, 0),
          rows: totals.reduce((n, t) => n + t.posts, 0),
        };
        log.success(
          countOnly
            ? `${agg.boards} board(s), ${agg.rows.toLocaleString()} row(s), ` +
                `${agg.ops.toLocaleString()} OP(s), ${agg.undated.toLocaleString()} without a timestamp, ` +
                `${skipped.ghost.toLocaleString()} ghost, ${skipped.bad.toLocaleString()} unparsable`
            : summary
        );
        results.push({
          name: id,
          ok: true,
          posts: countOnly ? agg.rows : posts,
          ...agg,
          ghost: skipped.ghost,
          bad: skipped.bad,
          secs,
        });
      } catch (e) {
        const secs = (Date.now() - t0) / 1000;
        const msg = String((e as Error).message);
        log.error(`${id} failed: ${msg}`);
        results.push({
          name: id,
          ok: false,
          posts: 0,
          boards: 0,
          ops: 0,
          undated: 0,
          ghost: 0,
          bad: 0,
          secs,
        });
      }
    }
  } finally {
    await db?.end();
  }

  console.log();
  printTable(
    countOnly
      ? [
          'source',
          'status',
          'boards',
          'rows',
          'ops',
          'undated',
          'ghost',
          'bad',
          'seconds',
        ]
      : ['source', 'status', 'posts', 'seconds'],
    results.map((r) =>
      countOnly
        ? [
            r.name,
            r.ok ? 'ok' : 'FAILED',
            r.boards,
            r.posts,
            r.ops,
            r.undated,
            r.ghost,
            r.bad,
            Math.round(r.secs * 10) / 10,
          ]
        : [
            r.name,
            r.ok ? 'ok' : 'FAILED',
            r.posts,
            Math.round(r.secs * 10) / 10,
          ]
    )
  );
  if (results.some((r) => !r.ok)) {
    process.exit(1);
  }
};
