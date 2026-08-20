import type { Runner } from '../utils/exec/runner.ts';
import type { SourcePackage } from '../utils/source-package.ts';

import { Result } from '@badrap/result';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { shQuote } from '../utils/exec/runner.ts';
import { ensureNodeRuntime } from '../utils/exec/runtime.ts';

/**
 * Runs a source's prepare script.
 *
 * A source package publishes one built script and that is the whole staging
 * pipeline. There is no step list any more: staging that needs real code
 * cannot be expressed as one, and keeping both meant two mechanisms doing the
 * same job and two places to look when staging misbehaved.
 *
 * **The script runs where the archives are.** With `storage.type: remote`
 * that is the NAS, which has no checkout, no node_modules and no node -- so
 * the script is a self-contained bundle (npm's job, `npm run build:sources`)
 * and the runtime is copied next to the datasets. That is not an
 * optimisation: reading the trees from here means walking them over NFS, and
 * that mount cannot take it. Running the code where the data is is the whole
 * point.
 *
 * The dataset directory is the working directory, so every path a prepare
 * script uses is relative to it and the same script works under either
 * storage type.
 */

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
