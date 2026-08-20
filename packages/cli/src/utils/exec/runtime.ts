import type { Runner } from './runner.ts';

import { Result } from '@badrap/result';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { shQuote } from './runner.ts';

/**
 * Pinned rather than "latest": a runtime that changes under a re-run makes an
 * unreproducible staging step, and the only feature being relied on is that
 * node runs a bundle.
 */
export const NODE_VERSION = 'v24.19.0';

/** Shared by every source, beside the datasets rather than inside one. */
const RUNTIME_DIR = '.chan-runtime';

/** Gitignored, so the download happens once per checkout rather than per run. */
const CACHE_DIR = '.cache/node';

/**
 * The dev-shell node cannot be copied to the archive host.
 *
 * Verified: nixpkgs' build is dynamically linked against `/nix/store` paths
 * (libz, libuv, libada, libsimdjson) with a nix-store interpreter, none of
 * which exist there, so the binary will not start. What gets copied has to be
 * the official portable build.
 */
const tarballUrl = (): string =>
  `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-x64.tar.xz`;

/** Path to the cached portable binary on THIS machine, downloading it once. */
export const localNodeBinary = (projectRoot: string): Result<string, Error> => {
  const cache = join(projectRoot, CACHE_DIR);
  const bin = join(cache, `node-${NODE_VERSION}-linux-x64`, 'bin', 'node');
  if (existsSync(bin)) {
    return Result.ok(bin);
  }
  console.log(`  fetching a portable node ${NODE_VERSION} (once per checkout)`);
  try {
    mkdirSync(cache, { recursive: true });
    execFileSync(
      'sh',
      [
        '-c',
        `curl -sL --max-time 600 ${shQuote(tarballUrl())} | tar xJ -C ${shQuote(cache)}`,
      ],
      { stdio: 'inherit' }
    );
  } catch (e) {
    return Result.err(
      new Error(
        `could not fetch the node runtime: ${e instanceof Error ? e.message : String(e)}`
      )
    );
  }
  if (!existsSync(bin)) {
    return Result.err(new Error(`node tarball did not contain ${bin}`));
  }
  return Result.ok(bin);
};

/**
 * Absolute path to node on the target, copying it there if absent.
 *
 * Copied from the local cache rather than fetched by the target, so staging
 * works on a machine with no outbound network. ~110MB, once per storage root:
 * every source reuses it.
 */
export const ensureNodeRuntime = async (
  runner: Runner,
  storageRoot: string,
  projectRoot: string
): Promise<Result<string, Error>> => {
  const remote = `${storageRoot}/${RUNTIME_DIR}/node-${NODE_VERSION}`;
  const have = await runner.exec(`test -x ${shQuote(remote)}`);
  if (have.code === 0) {
    return Result.ok(remote);
  }

  const local = localNodeBinary(projectRoot);
  if (local.isErr) {
    return local as unknown as Result<string, Error>;
  }
  console.log(
    `  copying node ${NODE_VERSION} to ${storageRoot}/${RUNTIME_DIR}`
  );
  const w = await runner.writeFile(remote, readFileSync(local.value));
  if (w.isErr) {
    return Result.err(w.error);
  }
  const chmod = await runner.exec(`chmod +x ${shQuote(remote)}`);
  if (chmod.code !== 0) {
    return Result.err(
      new Error(`could not make ${remote} executable: ${chmod.stderr.trim()}`)
    );
  }
  return Result.ok(remote);
};
