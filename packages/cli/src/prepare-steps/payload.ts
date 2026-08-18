/**
 * Runs a source's own prepare code on whichever machine holds the archives.
 *
 * Some staging cannot be a shell one-liner. Turning 26,000 saved pages in
 * three markup generations into NDJSON needs a real parser, and doing it from
 * this machine would mean reading the tree over the NFS mount -- the thing
 * that mount demonstrably cannot take. So the code goes to the data instead:
 * a source that needs one becomes a directory,
 *
 *     sources/<id>/manifest.json
 *     sources/<id>/payload/<entry>.ts
 *
 * and `payload/` is uploaded and executed on the target.
 *
 * **A payload may not import anything from this repo.** It is a self-contained
 * tree by construction -- only `node:` builtins and files sitting beside it.
 * Shared helpers are therefore copied in rather than imported, which is a real
 * cost and the reason payloads are the exception rather than the rule.
 *
 * No bundler and no build step. Node 24 strips TypeScript types natively, so
 * the payload is committed and shipped as the `.ts` a person reads -- verified
 * on the NAS, which runs it directly. The same "no syntax that emits code"
 * rule the rest of the repo follows applies here for the same reason: no
 * enums, no namespaces, no constructor parameter properties.
 *
 * The runtime is fetched BY THE TARGET rather than pushed: Node is ~110MB and
 * the NAS has working HTTPS, so it curls the official tarball once into a
 * shared directory and every source reuses it. Nothing large crosses SSH.
 */

import type { Runner } from '../runner.ts';

import { Result } from '@badrap/result';

import { shQuote } from '../runner.ts';

/** Pinned rather than "latest": a runtime that changes under a re-run makes
 * an unreproducible staging step, and type stripping is the only feature
 * being relied on. */
export const NODE_VERSION = 'v24.19.0';

/** Shared across sources, beside the datasets rather than inside one. */
const RUNTIME_DIR = '.chan-runtime';

export interface PayloadStep {
  /** Entry file inside `payload/`, e.g. `html-to-ndjson.ts`. */
  entry: string;
  /** Arguments passed after the entry, expanded by the remote shell. */
  args: string[];
}

/** Absolute path to the node binary on the target, installing it if absent. */
export const ensureNodeRuntime = async (
  runner: Runner,
  datasetsRoot: string
): Promise<Result<string, Error>> => {
  const base = `${datasetsRoot}/${RUNTIME_DIR}`;
  const dir = `${base}/node-${NODE_VERSION}-linux-x64`;
  const node = `${dir}/bin/node`;

  const have = await runner.exec(`test -x ${shQuote(node)}`);
  if (have.code === 0) {
    return Result.ok(node);
  }

  console.log(`    installing node ${NODE_VERSION} on the target (once)`);
  const url =
    `https://nodejs.org/dist/${NODE_VERSION}/` +
    `node-${NODE_VERSION}-linux-x64.tar.xz`;
  const r = await runner.exec(
    `mkdir -p ${shQuote(base)} && ` +
      `curl -sL --max-time 600 ${shQuote(url)} | tar xJ -C ${shQuote(base)} && ` +
      `test -x ${shQuote(node)}`,
    { inherit: true }
  );
  if (r.code !== 0) {
    return Result.err(
      new Error(
        `could not install the node runtime on the target (exit ${r.code})\n` +
          `  tried ${url}` +
          (r.stderr.trim() ? `\n  ${r.stderr.trim()}` : '')
      )
    );
  }
  return Result.ok(node);
};

export const runPayload = async (
  runner: Runner,
  dir: string,
  datasetsRoot: string,
  localPayloadDir: string,
  step: PayloadStep,
  stepName: string
): Promise<Result<void, Error>> => {
  const nodeR = await ensureNodeRuntime(runner, datasetsRoot);
  if (nodeR.isErr) {
    return Result.err(
      new Error(`prepare step "${stepName}": ${nodeR.error.message}`)
    );
  }

  // Under the dataset dir, so a payload and the data it works on are on the
  // same filesystem and a half-finished upload is visible where it happened.
  const remote = `${dir}/.payload`;
  const up = await runner.uploadDir(localPayloadDir, remote);
  if (up.isErr) {
    return Result.err(
      new Error(`prepare step "${stepName}": ${up.error.message}`)
    );
  }

  const cmd =
    `${shQuote(nodeR.value)} ${shQuote(`${remote}/${step.entry}`)} ` +
    step.args.join(' ');
  const r = await runner.exec(cmd, { cwd: dir, inherit: true });
  if (r.code !== 0) {
    return Result.err(
      new Error(
        `prepare step "${stepName}": payload exited ${r.code}` +
          (r.stderr.trim() ? `\n  ${r.stderr.trim()}` : '')
      )
    );
  }
  return Result.ok(undefined);
};
