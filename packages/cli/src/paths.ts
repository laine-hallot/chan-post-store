import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the repo root is, found rather than assumed.
 *
 * Its own module because three separate things need it before anything else
 * runs -- `env.ts` to locate `.env`, `config.ts` to locate
 * `chan.config.json`, and `cli.ts` to resolve manifest ingest paths -- and a
 * leaf module keeps that from becoming a cycle.
 *
 * NOT cwd. Walking up from this file's own location means the answer is the
 * same whether the CLI is invoked from the repo root, from `packages/analysis`
 * via `npm run coverage`, or from anywhere else; and walking up to a marker
 * directory rather than counting `..` hops means moving a package within the
 * workspace doesn't silently resolve archive paths somewhere wrong.
 */

/** Where committed source manifests live, relative to the project root. */
export const SOURCES_DIR = 'sources';

export const findProjectRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, SOURCES_DIR))) return dir;
    const up = dirname(dir);
    if (up === dir) {
      throw new Error(
        `could not locate the repo root (no ${SOURCES_DIR}/ above ${import.meta.url})`
      );
    }
    dir = up;
  }
};

export const PROJECT_ROOT = findProjectRoot();
