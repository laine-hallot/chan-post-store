import type { InferValue } from '@optique/core/parser';

import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { withDefault } from '@optique/core/modifiers';
import { argument, command, constant, flag } from '@optique/core/primitives';
import { string } from '@optique/core/valueparser';

import { runnerOptions } from '../cli-common-args.ts';
import {
  identifierFromLink,
  fetchItem,
  humanBytes,
  downloadItem,
} from '../downloaders/archive-org.ts';
import { readSourceInfo, manifestPath } from '../manifest.ts';
import { fail } from '../utils/console.ts';
import { makeRunner } from '../utils/exec/runner.ts';
import { PROJECT_ROOT } from '../utils/paths.ts';

export const downloadCmd = command(
  'download',
  merge(
    object({
      action: constant('download' as const),
      source: argument(string({ metavar: 'SOURCE' })),
      'dry-run': withDefault(
        flag('--dry-run', {
          description: message`List what would be fetched, including what download.exclude filters out.`,
        }),
        false
      ),
      force: withDefault(
        flag('--force', {
          description: message`Re-download files already present and verified.`,
        }),
        false
      ),
      all: withDefault(
        flag('--all', {
          description: message`Include files that download.exclude skips -- image and thumbnail payloads, which on some items dwarf the text by 100x.`,
        }),
        false
      ),
    }),
    runnerOptions
  ),
  {
    description: message`Stage an archive.org item into the source's files.source directory. Runs on the NAS when NAS_HOST/NAS_ROOT are set, so the transfer goes straight to the array rather than through this machine.`,
  }
);

export type DownloadArgs = InferValue<typeof downloadCmd>;

export const execDownload = async (o: DownloadArgs): Promise<void> => {
  const id = o.source;

  const infoR = readSourceInfo(manifestPath(id, PROJECT_ROOT));
  if (infoR.isErr) {
    fail(infoR.error.message);
  }
  const info = infoR.value;
  if (!info.link) {
    fail(`${info.file}: source.link is required to download`);
  }
  const identifier = identifierFromLink(info.link);
  if (!identifier) {
    fail(`${info.file}: source.link is not an archive.org URL: ${info.link}`);
  }

  const itemR = await fetchItem(identifier);
  if (itemR.isErr) {
    fail(itemR.error.message);
  }
  const item = itemR.value;
  console.log(`${item.identifier}: ${item.title ?? '(untitled)'}`);
  console.log(`${item.files.length} files, ${humanBytes(item.totalBytes)}`);

  // Image/thumbnail payloads are excluded per-manifest; --all overrides.
  if (info.downloadExclude.length && !o.all) {
    const before = item.files.length;
    const beforeBytes = item.totalBytes;
    item.files = item.files.filter(
      (f) => !info.downloadExclude.some((re) => re.test(f.name))
    );
    item.totalBytes = item.files.reduce((n, f) => n + f.size, 0);
    const skipped = before - item.files.length;
    if (skipped > 0) {
      console.log(
        `skipping ${skipped} excluded file(s), ${humanBytes(beforeBytes - item.totalBytes)}` +
          ` — downloading ${item.files.length} files, ${humanBytes(item.totalBytes)} (--all to include)`
      );
    }
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
    const dest = runner.path(
      runner.rootIsDatasets ? info.stageDirFromDatasets : info.stageDir
    );
    console.log(`destination: ${dest} (${runner.where})\n`);
    const outcome = await downloadItem({
      item,
      dest,
      runner,
      force: o.force,
      dryRun: o['dry-run'],
    });
    if (outcome.isErr) {
      fail(outcome.error.message);
    }
    const results = outcome.value;

    const by = (s: string): number =>
      results.filter((r) => r.status === s).length;
    console.log(
      `\n${by('downloaded')} downloaded, ${by('skipped')} skipped, ${by('failed')} failed`
    );
    const failed = results.filter((r) => r.status === 'failed');
    if (failed.length) {
      for (const f of failed) {
        console.error(`  ${f.name}: ${f.detail}`);
      }
      process.exitCode = 1;
    }
  } finally {
    await runner.close();
  }
};
