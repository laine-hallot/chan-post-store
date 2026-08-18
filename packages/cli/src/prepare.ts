import type { SourceInfo } from './manifest.ts';
import type { ReconcileOp } from './prepare-steps/archives-yotsubasociety-org.ts';

import { Result } from '@badrap/result';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';

import { readBoardSlugs } from './board-timeline.ts';
import { reconcileYotsubasocietyBoards } from './prepare-steps/archives-yotsubasociety-org.ts';
import { runSqlNormalize } from './prepare-steps/sql-normalize.ts';
import { LocalRunner, shQuote, type Runner } from './runner.ts';

/**
 * Runs a source's prepare steps.
 *
 * Steps are shell commands from the manifest, executed in order with the
 * dataset directory as cwd, through the same runner as everything else so
 * they run on the NAS when configured. They are expected to be idempotent:
 * the pipeline is re-run whenever a source is re-staged.
 */

export interface PrepareOptions {
  info: SourceInfo;
  /** Dataset dir as the runner sees it. */
  dir: string;
  runner: Runner;
  dryRun?: boolean;
  /** Run even when the output path already exists. */
  force?: boolean;
  /** Extra shell variables exported to each step. */
  vars?: Record<string, string>;
  /**
   * Dataset dir as THIS machine can open it, which is not `dir` when the
   * runner is remote. A builtin READS the tree directly, so it needs a local
   * path and carries the same requirement ingest does: the archives must be
   * visible through the mount. It never writes through that path -- the
   * export is read-only, and changes go back through the runner.
   */
  localDir?: string;
  /** Project root, for resolving a builtin's project-relative paths. */
  projectRoot?: string;
}

/**
 * Steps that shell out to this CLI (e.g. warc-extract) have to run where
 * Node is — this machine — while still addressing files on the target.
 * They are marked with a `local:` prefix and run through a local shell with
 * the same variables, including the flags needed to reach the target.
 */
const LOCAL_PREFIX = 'local:';

export interface PrepareResult {
  ran: number;
  skipped: boolean;
}

const pathExists = async (runner: Runner, path: string): Promise<boolean> => {
  const r = await runner.exec(`test -e ${shQuote(path)}`);
  return r.code === 0;
};

/**
 * Single-quotes raw path BYTES for POSIX sh.
 *
 * `shQuote` takes a string, and a string cannot hold this tree: one filename
 * in the mirror is not valid UTF-8, so decoding it to quote it would replace
 * the offending bytes and the generated `mv` would name a file that does not
 * exist. Single quotes are byte-transparent in sh -- everything between them
 * is literal except `'` itself -- so quoting at the Buffer level passes any
 * byte through untouched.
 */
const shQuoteBytes = (b: Buffer): Buffer => {
  const parts: Buffer[] = [Buffer.from("'")];
  let start = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 0x27) {
      parts.push(b.subarray(start, i), Buffer.from(`'\\''`));
      start = i + 1;
    }
  }
  parts.push(b.subarray(start), Buffer.from("'"));
  return Buffer.concat(parts);
};

/** Everything before the last `/`, or null when the path has no directory. */
const dirOfBytes = (b: Buffer): Buffer | null => {
  const i = b.lastIndexOf(0x2f);
  return i <= 0 ? null : b.subarray(0, i);
};

/**
 * Renders a plan as a shell script.
 *
 * `set -e` stops at the first failure. The ops are ordered -- a move may fill
 * a path an earlier op vacated -- so carrying on past an error would apply
 * later moves against a tree that is not the one they were planned for.
 * Stopping early is safe because the step is idempotent: a re-run re-plans
 * from wherever the tree actually is.
 *
 * Exported so the script can be inspected without a target to run it on,
 * which is how the quoting was checked against the two filenames in this
 * mirror containing single quotes.
 */
export const buildReconcileScript = (
  cwd: string,
  ops: readonly ReconcileOp[]
): Buffer => {
  const lines: Buffer[] = [Buffer.from(`set -e\ncd ${shQuote(cwd)}\n`)];
  for (const op of ops) {
    const from = shQuoteBytes(op.from);
    if (op.kind === 'remove') {
      lines.push(
        Buffer.concat([Buffer.from('rm -f -- '), from, Buffer.from('\n')])
      );
      continue;
    }
    const to = shQuoteBytes(op.to!);
    const destDir = dirOfBytes(op.to!);
    if (destDir !== null) {
      lines.push(
        Buffer.concat([
          Buffer.from('mkdir -p -- '),
          shQuoteBytes(destDir),
          Buffer.from('\n'),
        ])
      );
    }
    lines.push(
      Buffer.concat([
        Buffer.from('mv -- '),
        from,
        Buffer.from(' '),
        to,
        Buffer.from(op.optional ? ' || true\n' : '\n'),
      ])
    );
  }
  return Buffer.concat(lines);
};

/**
 * Applies a reconcile plan on whichever machine holds the archives.
 *
 * Through the runner, never the mount: the NFS export is read-only, so the
 * moves have to travel over SSH. The script is written to the dataset dir and
 * run there rather than passed as a command, so its size is bounded by disk
 * instead of ARG_MAX, and the whole change set costs one round trip.
 */
const applyReconcilePlan = async (
  runner: Runner,
  dir: string,
  rootRel: string,
  ops: ReconcileOp[],
  stepName: string
): Promise<Result<void, Error>> => {
  const script = buildReconcileScript(`${dir}/${rootRel}`, ops);
  const scriptPath = `${dir}/.reconcile-plan.sh`;
  const w = await runner.writeFile(scriptPath, script);
  if (w.isErr) {
    return Result.err(
      new Error(`prepare step "${stepName}": ${w.error.message}`)
    );
  }
  const r = await runner.exec(`sh ${shQuote(scriptPath)}`, { cwd: dir });
  await runner.exec(`rm -f ${shQuote(scriptPath)}`, { cwd: dir });
  if (r.code !== 0) {
    return Result.err(
      new Error(
        `prepare step "${stepName}": applying the plan failed (exit ${r.code})` +
          (r.stderr.trim() ? `\n  ${r.stderr.trim()}` : '')
      )
    );
  }
  return Result.ok(undefined);
};

export const runPrepare = async (
  opts: PrepareOptions
): Promise<Result<PrepareResult, Error>> => {
  const { info, dir, runner } = opts;
  if (info.prepare.length === 0) {
    return Result.err(
      new Error(
        `${info.file}: no "prepare" steps defined\n` +
          `  add a prepare array of {name, run} shell commands`
      )
    );
  }

  const outPath = `${dir}/${info.prepareOutput}`;
  if (!opts.force && !opts.dryRun && (await pathExists(runner, outPath))) {
    console.log(
      `${info.prepareOutput} already exists — nothing to do (use --force to re-run)`
    );
    return Result.ok({ ran: 0, skipped: true });
  }

  // Exported ahead of each command so steps can reference them.
  const exports = Object.entries(opts.vars ?? {})
    .map(([k, v]) => `export ${k}=${shQuote(v)}; `)
    .join('');

  let n = 0;
  for (const [i, step] of info.prepare.entries()) {
    const label0 = `[${i + 1}/${info.prepare.length}] ${step.name}`;

    // Splits a dump into the standard one-file-per-board layout. A builtin so
    // the awk program lives in one place instead of being pasted into every
    // SQL manifest, but the work itself runs THROUGH THE RUNNER: the inputs
    // reach 21GB in a single file, and rewriting them in this process would
    // drag every byte across the mount and back.
    if (step.sqlNormalize !== undefined) {
      const c = step.sqlNormalize;
      console.log(`${label0} (builtin)`);
      if (opts.dryRun) {
        console.log(
          `    would split ${c.from}/*.sql into ${c.to}/<board>.sql` +
            ` (rename: ${c.rename})`
        );
        n++;
        continue;
      }
      const r = await runSqlNormalize(runner, dir, c, step.name);
      if (r.isErr) {
        return Result.err(r.error);
      }
      console.log(`    wrote ${r.value} board file(s) to ${c.to}`);
      n++;
      continue;
    }

    // Builtins run in this process rather than through a shell: the work is
    // per-file decisions over tens of thousands of pages, which is not a
    // command a runner can carry.
    if (step.reconcileBoards !== undefined) {
      const c = step.reconcileBoards;
      if (!opts.localDir || !opts.projectRoot) {
        return Result.err(
          new Error(
            `prepare step "${step.name}" is a builtin and needs local paths\n` +
              `  (caller did not supply localDir/projectRoot)`
          )
        );
      }
      const root = join(opts.localDir, c.root);
      console.log(`${label0} (builtin)`);
      // Read before the walk, so a missing or unreadable timeline fails the
      // step immediately rather than after several minutes over the mount.
      let knownBoards;
      try {
        knownBoards = readBoardSlugs(join(opts.projectRoot, c.boardsFrom));
      } catch (e) {
        return Result.err(
          new Error(
            `prepare step "${step.name}": ${e instanceof Error ? e.message : String(e)}`
          )
        );
      }
      // A dry run still WALKS the tree, reporting what it would do without
      // touching anything -- a shell step can only be echoed, but this one
      // can be previewed properly, and the preview is what catches a title
      // rule that has stopped fitting the archive.
      const { stats, ops } = reconcileYotsubasocietyBoards({
        root,
        knownBoards,
      });
      const moved = stats.relocated + stats.relocatedSnapshot;
      console.log(
        `    ${opts.dryRun ? 'would move' : 'moved'} ${moved}, ` +
          `${stats.duplicateRemoved} identical duplicate(s) ${opts.dryRun ? 'to remove' : 'removed'}, ` +
          `${stats.matched} already correct, ${stats.undetermined} unjudgeable`
      );
      if (stats.unknownBoard > 0) {
        const tags = [...stats.unknownTags]
          .sort((a, z) => z[1] - a[1])
          .map(([t, k]) => `/${t}/ ${k}`)
          .join(', ');
        console.log(
          `    ${stats.unknownBoard} page(s) resolve to an unrecognised board, left in place: ${tags}`
        );
      }
      // Printed every run, not just when something looks wrong: these are
      // pages whose title names a different board than their links do, which
      // is normal (joke renames, thread abbreviations) but is also the only
      // place a NEW such name would show itself.
      if (stats.costumes.size > 0) {
        const names = [...stats.costumes]
          .sort((a, z) => z[1] - a[1])
          .map(([t, k]) => `${t} ${k}`)
          .join(', ');
        console.log(`    display names differing from the links: ${names}`);
      }
      if (opts.dryRun) {
        continue;
      }

      // APPLIED THROUGH THE RUNNER, NOT THE MOUNT. The module above only
      // reads; every change goes over SSH, because the NFS export is
      // read-only and a local rename dies with EROFS on the first page. The
      // ops cross as one generated script rather than a command each: ~1,000
      // SSH round-trips would dominate the runtime, and a single command line
      // holding them all would be hundreds of kilobytes.
      if (ops.length > 0) {
        const applyR = await applyReconcilePlan(
          runner,
          dir,
          c.root,
          ops,
          step.name
        );
        if (applyR.isErr) {
          return Result.err(applyR.error);
        }
      }
      n++;
      continue;
    }

    const isLocal = step.run.startsWith(LOCAL_PREFIX);
    const body = isLocal
      ? step.run.slice(LOCAL_PREFIX.length).trim()
      : step.run;
    const label = `[${i + 1}/${info.prepare.length}] ${step.name}${isLocal ? ' (local)' : ''}`;

    if (opts.dryRun) {
      console.log(`${label}\n    ${body}`);
      continue;
    }
    console.log(label);

    // PWD is set explicitly: a local step's cwd is this checkout, but the
    // paths it manipulates are on the target.
    const cmd = `${exports}${body}`;
    const r = isLocal
      ? await new LocalRunner(process.cwd()).exec(cmd, { inherit: true })
      : await runner.exec(cmd, { cwd: dir, inherit: true });

    if (r.code !== 0) {
      // Stops at the first failing step: later steps consume earlier output,
      // so continuing would compound one failure into several confusing ones.
      return Result.err(
        new Error(
          `prepare step "${step.name}" failed (exit ${r.code})\n  ${body}` +
            (r.stderr.trim() ? `\n  ${r.stderr.trim()}` : '')
        )
      );
    }
    n++;
  }
  return Result.ok({ ran: n, skipped: false });
};
