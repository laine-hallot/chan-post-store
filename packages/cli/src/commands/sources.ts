import type { InferValue } from '@optique/core/parser';

import type { Runner } from '../utils/exec/runner.ts';

import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { withDefault } from '@optique/core/modifiers';
import { argument, command, constant, flag } from '@optique/core/primitives';
import { choice, string } from '@optique/core/valueparser';

import { runnerOptions } from '../cli-common-args.ts';
import { readSourceInfo } from '../manifest.ts';
import { fail } from '../utils/console.ts';
import { makeRunner, shQuote } from '../utils/exec/runner.ts';
import { PROJECT_ROOT, SOURCES_DIR } from '../utils/paths.ts';
import { readSourcePackage } from '../utils/source-package.ts';

/**
 * The three staging stages, and what it costs to get each one back.
 *
 * That difference is the whole reason this command asks for --yes rather
 * than just doing it: `extracted` and `out` are reproducible in an afternoon
 * by re-running `prepare`, while `source` is a re-download of an
 * archive.org item measured in hundreds of gigabytes.
 */
const STAGES = ['source', 'extracted', 'out'] as const;
type Stage = (typeof STAGES)[number];

/** How to rebuild each stage, shown before anything is removed. */
const RECOVERY: Record<Stage, string> = {
  source: 'download <source>  -- refetches the item from archive.org',
  extracted: 'prepare <source> --force',
  out: 'prepare <source> --force',
};

export const sourcesCmd = command(
  'sources',
  merge(
    object({
      action: constant('sources-delete' as const),
      source: argument(string({ metavar: 'SOURCE' })),
      // A literal rather than a subcommand parser: Optique matches commands
      // before positional arguments, so `sources <SOURCE> delete <STAGE>`
      // cannot be expressed as command('delete', ...) nested under an
      // argument. Spelling it as an argument keeps the requested word order.
      verb: argument(choice(['delete'], { metavar: 'delete' })),
      stage: argument(choice([...STAGES], { metavar: 'STAGE' })),
      yes: withDefault(
        flag('--yes', {
          description: message`Actually delete. Without it, this only reports.`,
        }),
        false
      ),
    }),
    runnerOptions
  ),
  {
    description: message`Delete one of a source's staging trees (source/, extracted/, out*/) to reclaim disk. Reports the size and exits without --yes.`,
  }
);

export type SourcesArgs = InferValue<typeof sourcesCmd>;

/**
 * Every directory a stage covers, as paths on the runner's target.
 *
 * `out` is plural on purpose: a source may stage more than one tree
 * (fybertech writes out/, out-ndjson/ and out-native/), and deleting only
 * the one named `out` would leave the bulk of the staged bytes behind while
 * reporting success.
 */
const stageDirs = async (
  runner: Runner,
  base: string,
  stage: Stage
): Promise<string[]> => {
  if (stage !== 'out') {
    return [`${base}/${stage}`];
  }
  // -maxdepth/-mindepth 1 so the dataset dir itself can never match.
  const r = await runner.exec(
    `find ${shQuote(base)} -mindepth 1 -maxdepth 1 -type d -name 'out*' 2>/dev/null | sort`
  );
  return r.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
};

/** Apparent size of a directory, or null when it does not exist. */
const sizeOf = async (
  runner: Runner,
  dir: string
): Promise<{ human: string; bytes: number } | null> => {
  const r = await runner.exec(
    `if [ -d ${shQuote(dir)} ]; then du -sb ${shQuote(dir)} 2>/dev/null | cut -f1; else echo MISSING; fi`
  );
  const out = r.stdout.trim();
  if (out === 'MISSING' || out === '') {
    return null;
  }
  const bytes = Number(out);
  if (!Number.isFinite(bytes)) {
    return null;
  }
  return { human: humanBytes(bytes), bytes };
};

const humanBytes = (n: number): string => {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)}${units[i]}`;
};

export const execSources = async (o: SourcesArgs): Promise<void> => {
  const id = o.source;
  const stage = o.stage as Stage;

  const pkg = readSourcePackage(id, PROJECT_ROOT);
  if (!pkg) {
    fail(`no source package at ${SOURCES_DIR}/${id}/`);
  }
  const infoR = readSourceInfo(pkg.manifest);
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
    // Never through the local NFS mount: a delete is file work, and file
    // work goes over SSH. The mount is only for seeing which sources exist.
    const base = runner.path(
      runner.rootIsDatasets ? info.dirFromDatasets : info.dir
    );
    const dirs = await stageDirs(runner, base, stage);

    if (dirs.length === 0) {
      console.log(`${id}: no ${stage}/ to delete (${runner.where})`);
      return;
    }

    let total = 0;
    const present: string[] = [];
    for (const d of dirs) {
      const s = await sizeOf(runner, d);
      if (s === null) {
        console.log(`  ${d}  (absent)`);
        continue;
      }
      present.push(d);
      total += s.bytes;
      console.log(`  ${d}  ${s.human}`);
    }

    if (present.length === 0) {
      console.log(`${id}: nothing to delete for stage ${stage}`);
      return;
    }

    if (!o.yes) {
      console.log(
        `\n${id}: would free ${humanBytes(total)} on ${runner.where}` +
          `\n  rebuild with: ${RECOVERY[stage]}` +
          `\n  re-run with --yes to delete`
      );
      return;
    }

    for (const d of present) {
      // Guard against ever handing rm -rf a path that is not under the
      // dataset dir -- a manifest with an odd `dir` would otherwise be a
      // very expensive typo.
      if (!d.startsWith(`${base}/`)) {
        fail(`refusing to delete ${d}: outside the dataset dir ${base}`);
      }
      const r = await runner.exec(`rm -rf ${shQuote(d)}`);
      if (r.code !== 0) {
        fail(`failed to delete ${d}: ${r.stderr.trim()}`);
      }
      console.log(`  deleted ${d}`);
    }
    console.log(
      `${id}: freed ${humanBytes(total)} on ${runner.where}` +
        `\n  rebuild with: ${RECOVERY[stage]}`
    );
  } finally {
    await runner.close();
  }
};
