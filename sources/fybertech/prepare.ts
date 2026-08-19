/**
 * fybertech: a 2015 crawl of fybertech.com's rendered 4chan thread pages.
 *
 * Runs on whichever machine holds the archives, so every path here is local
 * to that machine and the dataset directory is the working directory.
 *
 * The crawl mixes three markup generations in one directory -- 420 classic
 * Futaba, 197 in fybertech's own later template, and 20 in 4chan's own. This
 * script parses the first two into NDJSON; the 20 native pages are staged as
 * HTML by the `fybertech-native` source, which reads the same `out/` tree.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { htmlToNdjson } from 'staging-html';

const sh = (cmd: string): void => {
  execFileSync('sh', ['-c', cmd], { stdio: 'inherit' });
};

// The item ships the crawl loose AND as a .7z of the same bytes; unpack only
// when the loose tree is absent, so a duplicate is never expanded.
if (
  !existsSync('extracted/www.fybertech.com') &&
  !existsSync('extracted/2015-02-16-WARC')
) {
  sh(
    'mkdir -p extracted && 7z x -aos -o./extracted source/fybertech/fybertech-2015-02-16.7z'
  );
}

// The crawl ships the rendered pages, so there is no WARC parsing to do.
sh('rm -rf out');
if (existsSync('extracted/www.fybertech.com/4thread')) {
  sh(
    'cp -al extracted/www.fybertech.com/4thread out 2>/dev/null || cp -a extracted/www.fybertech.com/4thread out'
  );
}

// Assert rather than silently staging nothing. The item also ships raw WARCs;
// if the loose tree is ever missing, those have to be extracted instead.
if (!readdirSync('out').some((f) => /\.html?$/i.test(f))) {
  console.error(
    'no pages in out/: extracted/www.fybertech.com/4thread is missing.'
  );
  console.error(
    'The item also ships the raw WARCs; extract those into out/ instead.'
  );
  process.exit(1);
}

const stats = await htmlToNdjson({ from: 'out', to: 'out-ndjson' });
console.log(
  `    ${stats.posts} post(s) from ${stats.pages} page(s) into ${stats.boards} board file(s)\n` +
    `    skipped ${stats.skippedNative} in 4chan's own markup, ` +
    `${stats.noPosts} with no posts, ${stats.unreadable} unreadable\n` +
    `    ${stats.noTimestamp} post(s) with no timestamp`
);
