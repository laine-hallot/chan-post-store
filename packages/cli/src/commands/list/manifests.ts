import type { InferValue } from '@optique/core/parser';

import { bindConfig } from '@optique/config';
import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { multiple, optional, withDefault } from '@optique/core/modifiers';
import {
  argument,
  command,
  constant,
  flag,
  option,
} from '@optique/core/primitives';
import { choice, integer, string } from '@optique/core/valueparser';
import { relative, resolve } from 'path';

import { runnerOptions } from '../../cli-common-args.ts';
import {
  listManifestIds,
  ManifestError,
  manifestPath,
  readManifest,
  readSourceInfo,
} from '../../manifest.ts';
import { printTable } from '../../table.ts';
import { fail } from '../../utils/console.ts';
import { makeRunner, shQuote } from '../../utils/exec/runner.ts';
import { PROJECT_ROOT, SOURCES_DIR } from '../../utils/paths.ts';

export const listManifestsCmd = command(
  'manifests',
  merge(object({ action: constant('list-manifests' as const) }), runnerOptions),
  {
    description: message`Every source manifest, its adapter, which stage directories hold data (s/e/o), and whether it is ready, pending, a dead end, or in error.`,
  }
);

export type ListManifestsArgs = InferValue<typeof listManifestsCmd>;

/**
 * Registry view: what's in sources/, and how far each has got.
 *
 * Stage checks go through the runner, so a remote setup reports on the NAS
 * rather than on whatever the local SMB mount happens to be showing (that
 * mount drops periodically and would otherwise report everything missing).
 */
export const execListManifests = async (
  o: ListManifestsArgs
): Promise<void> => {
  const ids = listManifestIds(PROJECT_ROOT);
  if (ids.length === 0) {
    console.log(`no manifests in ${SOURCES_DIR}/`);
    return;
  }

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
    const rows: (string | number | null)[][] = [];
    for (const id of ids) {
      let adapter = '-';
      let stages = '';
      let status = 'ready';
      try {
        const infoR = readSourceInfo(manifestPath(id, PROJECT_ROOT));
        if (infoR.isErr) {
          throw infoR.error;
        }
        const info = infoR.value;
        const base = runner.path(
          runner.rootIsDatasets ? info.dirFromDatasets : info.dir
        );

        // Read the manifest before probing, so the probe can also ask about
        // the real ingest input rather than only the conventional stage dirs.
        let ingestRel: string | null = null;
        // A manifest that is *wrong* is not a manifest that is *unstaged*.
        // Both used to collapse to "pending" here, because the read threw and
        // one catch swallowed either kind -- so a typo in an adapter name
        // looked exactly like a source waiting on its prepare step. The
        // Result carries the distinction, so keep it.
        let broken = false;
        const mR = readManifest(manifestPath(id, PROJECT_ROOT), PROJECT_ROOT);
        if (mR.isOk) {
          const m = mR.value;
          adapter = m.adapter;
          // manifest.path is absolute once resolved; express it relative to
          // the dataset dir so it works through a datasets-rooted runner too.
          const rel = relative(resolve(PROJECT_ROOT, info.dir), m.path) || '.';
          if (!rel.startsWith('..')) {
            ingestRel = rel;
          }
        } else {
          adapter = '-';
          broken = mR.error.kind === 'invalid';
        }

        const nonEmpty = (p: string, yes: string, no: string): string =>
          `if [ -n "$(ls -A ${shQuote(p)} 2>/dev/null)" ]; then printf '${yes}'; else printf '${no}'; fi`;
        // Still one shell round-trip per source: the three stage dirs, plus
        // the ingest input when we know where it is.
        const cmds = ['source', 'extracted', 'out'].map((s) =>
          nonEmpty(`${base}/${s}`, s[0], '-')
        );
        if (ingestRel) {
          cmds.push(nonEmpty(`${base}/${ingestRel}`, 'y', 'n'));
        }
        const probe = await runner.exec(cmds.join('; '));
        const outv = probe.stdout.trim();
        stages = outv.slice(0, 3);

        // "ready" means the ingest input actually holds something and an
        // adapter is declared. Testing out/ specifically was wrong: ingest.path
        // does not have to be out/ -- 4chan-threads points at a directory
        // inside dir -- so a fully ingested source reported "pending" and
        // invited someone to download it all over again. Fall back to the out/
        // test only when the manifest could not be read at all.
        const hasInput = ingestRel
          ? outv.slice(3) === 'y'
          : stages.endsWith('o');
        // A dead end outranks both: it is not waiting on anything, so listing
        // it as "pending" would invite a repeat survey of the item.
        if (broken) {
          status = 'error';
        } else if (info.deadEnd) {
          status = 'dead-end';
        } else {
          status = hasInput && adapter !== '-' ? 'ready' : 'pending';
        }
      } catch (e) {
        status =
          e instanceof ManifestError && e.kind === 'pending'
            ? 'pending'
            : 'error';
      }
      rows.push([id, adapter, stages, status]);
    }
    printTable(['source', 'adapter', 's/e/o', 'status'], rows);
  } finally {
    await runner.close();
  }
};
