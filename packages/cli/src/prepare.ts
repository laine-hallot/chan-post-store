import type { SourceInfo } from "./manifest.ts";

import { LocalRunner, shQuote, type Runner } from "./runner.ts";

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
}

/**
 * Steps that shell out to this CLI (e.g. warc-extract) have to run where
 * Node is — this machine — while still addressing files on the target.
 * They are marked with a `local:` prefix and run through a local shell with
 * the same variables, including the flags needed to reach the target.
 */
const LOCAL_PREFIX = "local:";

export interface PrepareResult {
  ran: number;
  skipped: boolean;
}

const pathExists = async (runner: Runner, path: string): Promise<boolean> => {
  const r = await runner.exec(`test -e ${shQuote(path)}`);
  return r.code === 0;
};

export const runPrepare = async (opts: PrepareOptions): Promise<PrepareResult> => {
  const { info, dir, runner } = opts;
  if (info.prepare.length === 0) {
    throw new Error(
      `${info.file}: no "prepare" steps defined\n` +
        `  add a prepare array of {name, run} shell commands`,
    );
  }

  const outPath = `${dir}/${info.prepareOutput}`;
  if (!opts.force && !opts.dryRun && (await pathExists(runner, outPath))) {
    console.log(`${info.prepareOutput} already exists — nothing to do (use --force to re-run)`);
    return { ran: 0, skipped: true };
  }

  // Exported ahead of each command so steps can reference them.
  const exports = Object.entries(opts.vars ?? {})
    .map(([k, v]) => `export ${k}=${shQuote(v)}; `)
    .join("");

  let n = 0;
  for (const [i, step] of info.prepare.entries()) {
    const isLocal = step.run.startsWith(LOCAL_PREFIX);
    const body = isLocal ? step.run.slice(LOCAL_PREFIX.length).trim() : step.run;
    const label = `[${i + 1}/${info.prepare.length}] ${step.name}${isLocal ? " (local)" : ""}`;

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
      throw new Error(
        `prepare step "${step.name}" failed (exit ${r.code})\n  ${body}` +
          (r.stderr.trim() ? `\n  ${r.stderr.trim()}` : ""),
      );
    }
    n++;
  }
  return { ran: n, skipped: false };
};
