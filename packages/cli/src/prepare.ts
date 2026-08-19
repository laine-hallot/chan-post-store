import type { Runner } from './runner.ts';
import type { SourcePackage } from './source-package.ts';

import { Result } from '@badrap/result';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { shQuote } from './runner.ts';
import { ensureNodeRuntime } from './runtime.ts';

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
    return Result.ok({ ran: false });
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
  return Result.ok({ ran: true });
};
