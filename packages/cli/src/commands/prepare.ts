import type { InferValue } from '@optique/core/parser';

import type { Runner } from '../utils/exec/runner.ts';
import type { SourcePackage } from '../utils/source-package.ts';

import { Result } from '@badrap/result';
import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { withDefault } from '@optique/core/modifiers';
import { argument, command, constant, flag } from '@optique/core/primitives';
import { string } from '@optique/core/valueparser';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { basename } from 'node:path';

import { runnerOptions } from '../cli-common-args.ts';
import { readSourceInfo } from '../manifest.ts';
import { fail } from '../utils/console.ts';
import { makeRunner } from '../utils/exec/runner.ts';
import { shQuote } from '../utils/exec/runner.ts';
import { ensureNodeRuntime } from '../utils/exec/runtime.ts';
import { PROJECT_ROOT, SOURCES_DIR } from '../utils/paths.ts';
import { readSourcePackage } from '../utils/source-package.ts';

export interface PrepareOptions {
  pkg: SourcePackage;
  /** Path whose existence means staging already ran; skipped unless forced. */
  prepareOutput: string;
  /** Re-run even when the staged output is already there. */
  force?: boolean;
  /** Dataset dir as the runner sees it. */
  dir: string;
  /** Storage root as the runner sees it; where the shared runtime lives. */
  storageRoot: string;
  runner: Runner;
  projectRoot: string;
  dryRun?: boolean;
}

export interface PrepareResult {
  ran: boolean;
  skipped: boolean;
}

export const runPrepare = async (
  opts: PrepareOptions
): Promise<Result<PrepareResult, Error>> => {
  const { pkg, dir, runner } = opts;

  if (!pkg.prepare) {
    return Result.err(
      new Error(
        `${pkg.id}: package.json declares no chan.prepare\n` +
          `  add one naming the built script, e.g. "./dist/prepare.mjs"`
      )
    );
  }
  if (!existsSync(pkg.prepare)) {
    return Result.err(
      new Error(
        `${pkg.id}: ${pkg.prepare} does not exist\n` +
          `  run: npm run build:sources`
      )
    );
  }

  if (opts.dryRun) {
    console.log(`  would run ${basename(pkg.prepare)} in ${dir}`);
    return Result.ok({ ran: false, skipped: false });
  }

  // Staging a source is measured in hours -- 71GB of unzstd and awk for one
  // warosu backup -- so an accidental re-run is expensive. The check is one
  // `test -e` through the runner, never a look at the mount.
  if (!opts.force) {
    const out = `${dir}/${opts.prepareOutput}`;
    const have = await runner.exec(`test -e ${shQuote(out)}`);
    if (have.code === 0) {
      console.log(
        `  ${opts.prepareOutput} already exists — nothing to do (use --force to re-run)`
      );
      return Result.ok({ ran: false, skipped: true });
    }
  }

  const node = await ensureNodeRuntime(
    runner,
    opts.storageRoot,
    opts.projectRoot
  );
  if (node.isErr) {
    return Result.err(node.error);
  }

  // Beside the data it stages, so a half-finished run is visible where it
  // happened rather than in a temp directory nobody looks at.
  const remote = `${dir}/.prepare.mjs`;
  const w = await runner.writeFile(remote, readFileSync(pkg.prepare));
  if (w.isErr) {
    return Result.err(w.error);
  }

  const r = await runner.exec(`${shQuote(node.value)} ${shQuote(remote)}`, {
    cwd: dir,
    inherit: true,
  });
  await runner.exec(`rm -f ${shQuote(remote)}`, { cwd: dir });
  if (r.code !== 0) {
    return Result.err(
      new Error(
        `${pkg.id}: prepare exited ${r.code}` +
          (r.stderr.trim() ? `\n  ${r.stderr.trim()}` : '')
      )
    );
  }
  return Result.ok({ ran: true, skipped: false });
};

export const prepareCmd = command(
  'prepare',
  merge(
    object({
      action: constant('prepare' as const),
      source: argument(string({ metavar: 'SOURCE' })),
      'dry-run': withDefault(
        flag('--dry-run', {
          description: message`Print the steps without running them.`,
        }),
        false
      ),
      force: withDefault(
        flag('--force', {
          description: message`Re-run even though out/ already exists.`,
        }),
        false
      ),
    }),
    runnerOptions
  ),
  {
    description: message`Run a source's staging pipeline: source/ -> extracted/ -> out/. Steps must be idempotent, and are skipped when out/ already exists.`,
  }
);

export type PrepareArgs = InferValue<typeof prepareCmd>;

export const execPrepare = async (o: PrepareArgs): Promise<void> => {
  const id = o.source;

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
    const dir = runner.path(
      runner.rootIsDatasets ? info.dirFromDatasets : info.dir
    );
    // The runtime is shared across sources, so it sits beside the datasets
    // rather than inside any one of them.
    const storageRoot = runner.rootIsDatasets
      ? runner.path('.')
      : join(PROJECT_ROOT, info.dir, '..');
    console.log(`preparing ${info.name}`);
    console.log(`${dir} (${runner.where})\n`);
    const res = await runPrepare({
      pkg,
      dir,
      storageRoot,
      runner,
      projectRoot: PROJECT_ROOT,
      prepareOutput: info.prepareOutput,
      force: o.force,
      dryRun: o['dry-run'],
    });
    if (res.isErr) {
      console.error(res.error.message);
      process.exitCode = 1;
    } else if (res.value.ran) {
      console.log(`\nprepared -> ${info.prepareOutput}/`);
    }
  } catch (e) {
    console.error(String((e as Error).message));
    process.exitCode = 1;
  } finally {
    await runner.close();
  }
};
