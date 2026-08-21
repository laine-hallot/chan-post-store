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
import { join } from 'path';

import { runnerOptions } from '../cli-common-args.ts';
import { fail } from '../utils/console.ts';
import { makeRunner } from '../utils/exec/runner.ts';
import { ensureNodeRuntime, NODE_VERSION } from '../utils/exec/runtime.ts';
import { PROJECT_ROOT } from '../utils/paths.ts';

/**
 * `list manifests` is the odd one: it probes the archive tree rather than the
 * database, so it takes the runner flags and no --db. That asymmetry used to
 * be a bug -- USAGE advertised --db for every `list` subcommand and this one
 * rejected it -- and is now simply what the grammar says.
 */
export const prepareRuntimeCmd = command(
  'prepare-runtime',
  merge(
    object({ action: constant('prepare-runtime' as const) }),
    runnerOptions
  ),
  {
    description: message`Install the Node runtime that payload prepare steps run under, on whichever machine holds the archives. Idempotent, and done automatically by the first payload step that needs it.`,
  }
);

export type PrepareRuntimeArgs = InferValue<typeof prepareRuntimeCmd>;

/**
 * Installs the runtime that payload prepare steps execute under.
 *
 * Exposed as its own command so it can be done deliberately -- it fetches
 * ~50MB on the target -- rather than only as a side effect of the first
 * source that needs it. Idempotent either way.
 */
export const execPrepareRuntime = async (
  o: PrepareRuntimeArgs
): Promise<void> => {
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
    const root = runner.rootIsDatasets
      ? runner.path('.')
      : join(PROJECT_ROOT, 'nas-data', 'Datasets', '4chan');
    console.log(`runtime root: ${root} (${runner.where})`);
    const r = await ensureNodeRuntime(runner, root, PROJECT_ROOT);
    if (r.isErr) {
      fail(r.error.message);
    }
    console.log(`node ${NODE_VERSION} ready at ${r.value}`);
  } finally {
    await runner.close();
  }
};
