import type { InferValue } from '@optique/core/parser';

import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { multiple, withDefault } from '@optique/core/modifiers';
import {
  argument,
  command,
  constant,
  flag,
  option,
} from '@optique/core/primitives';
import { choice, string } from '@optique/core/valueparser';
import { gunzipSync } from 'node:zlib';
import { htmlPages, uriToFilename } from 'staging-html';

import { runnerOptions } from '../cli-common-args.ts';
import { fail } from '../utils/console.ts';
import { makeRunner, shQuote } from '../utils/exec/runner.ts';
import { PROJECT_ROOT } from '../utils/paths.ts';

export const warcExtractCmd = command(
  'warc-extract',
  merge(
    object({
      action: constant('warc-extract' as const),
      warc: option('--warc', string(), {
        description: message`A .warc/.warc.gz file, or a directory of them.`,
      }),
      out: option('--out', string(), {
        description: message`Directory to write extracted pages into.`,
      }),
      host: withDefault(
        option('--host', string(), {
          description: message`Only extract records whose URL host matches this regex.`,
        }),
        'boards\\.4chan(?:nel)?\\.org'
      ),
    }),
    runnerOptions
  ),
  { description: message`Extract saved HTML pages out of a WARC capture.` }
);

export type WarcExtractArgs = InferValue<typeof warcExtractCmd>;

/**
 * Extracts HTML pages from a WARC into a directory. Invoked from manifest
 * prepare steps; the de-chunk + brotli handling is impractical in shell.
 */
export const execWarcExtract = async (o: WarcExtractArgs): Promise<void> => {
  if (!o.warc || !o.out) {
    fail('warc-extract requires --warc and --out');
  }
  const hostRe = new RegExp(o.host);

  // Parsing happens here rather than on the target: the NAS has no Node, and
  // these WARCs are single-digit MB, so the round trip is cheap.
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
    // --warc may name a single file or a directory of them; archives like
    // fybertech ship many WARCs from one crawl.
    const probe = await runner.exec(
      `test -d ${shQuote(o.warc)} && echo dir || echo file`
    );
    let warcs: string[];
    if (probe.stdout.trim() === 'dir') {
      const ls = await runner.exec(
        `find ${shQuote(o.warc)} -type f \\( -name '*.warc' -o -name '*.warc.gz' \\) | sort`
      );
      warcs = ls.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (warcs.length === 0) {
        fail(`no .warc/.warc.gz files under ${o.warc}`);
      }
      console.log(`${warcs.length} WARC file(s)`);
    } else {
      warcs = [o.warc];
    }

    const outDir = o.out.replace(/\/$/, '');
    let n = 0;
    for (const w of warcs) {
      const rawR = await runner.readFile(w);
      if (rawR.isErr) {
        fail(rawR.error.message);
      }
      const raw = rawR.value;
      // Items ship the WARC gzipped; accept either form.
      const buf = w.endsWith('.gz') ? gunzipSync(raw) : raw;
      for (const rec of htmlPages(buf, hostRe)) {
        const name = uriToFilename(rec.uri!);
        const wrote = await runner.writeFile(`${outDir}/${name}`, rec.body);
        if (wrote.isErr) {
          fail(wrote.error.message);
        }
        console.log(`  ${name} (${rec.body.length} bytes) <- ${rec.uri}`);
        n++;
      }
    }
    if (n === 0) {
      fail(`no HTML pages matching /${o.host}/ in ${o.warc}`);
    }
    console.log(`extracted ${n} page(s)`);
  } finally {
    await runner.close();
  }
};
