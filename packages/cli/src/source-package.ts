import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SOURCES_DIR } from './paths.ts';

/**
 * A source is an npm package under `sources/<id>/`.
 *
 * It publishes two things, named in its package.json:
 *
 *     "chan": {
 *       "manifest": "./fybertech.json",
 *       "prepare":  "./dist/prepare.mjs"
 *     }
 *
 * The manifest is provenance plus ingest config. The prepare script is the
 * WHOLE staging pipeline -- there is no step list in the manifest any more,
 * because staging that needs real code cannot be expressed as one, and having
 * two mechanisms meant two places to look when staging misbehaved.
 *
 * `prepare` names a BUILT artifact, not a source file. Building is npm's job
 * (`npm run build:sources`, which runs each package's own `build`), so the
 * CLI never compiles anything: it copies the bundle to wherever the archives
 * are and runs it. A source whose script needs no bundling still declares a
 * `build`, so the command is uniform.
 */
export interface SourcePackage {
  id: string;
  /** Package directory, absolute. */
  dir: string;
  /** Absolute path to the manifest JSON. */
  manifest: string;
  /** Absolute path to the built prepare script, if the package declares one. */
  prepare?: string;
}

interface PackageJson {
  chan?: { manifest?: unknown; prepare?: unknown };
}

/**
 * Reads `sources/<id>/package.json`.
 *
 * Falls back to `<id>.json` for the manifest when `chan.manifest` is absent,
 * so a source that has not been given a `chan` block yet still resolves.
 */
export const readSourcePackage = (
  id: string,
  projectRoot: string
): SourcePackage | null => {
  const dir = resolve(projectRoot, SOURCES_DIR, id);
  const pkgFile = join(dir, 'package.json');
  if (!existsSync(pkgFile)) {
    return null;
  }
  let pkg: PackageJson = {};
  try {
    pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as PackageJson;
  } catch {
    return null;
  }
  const manifestRel =
    typeof pkg.chan?.manifest === 'string' ? pkg.chan.manifest : `./${id}.json`;
  const prepareRel =
    typeof pkg.chan?.prepare === 'string' ? pkg.chan.prepare : undefined;
  return {
    id,
    dir,
    manifest: resolve(dir, manifestRel),
    prepare: prepareRel ? resolve(dir, prepareRel) : undefined,
  };
};
