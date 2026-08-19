import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { sh } from 'staging-core';

/**
 * Selects 4chan's own markup out of a mixed crawl and lands it as
 * `<to>/<board>/<name>.html`.
 *
 * A crawl can hold several markup families in one directory -- fybertech's
 * 638 thread pages are 420 classic Futaba, 197 in its own later template and
 * 20 in 4chan's own; the yotsubasociety mirror is ~85%/~10%. Splitting the
 * tree here means the `html` reader never has to skip another parser's files,
 * and `htmlToNdjson` never has to skip its.
 *
 * Filename rules, applied in order:
 *
 * | staged name                                  | board | file             |
 * | -------------------------------------------- | ----- | ---------------- |
 * | `boards.4chan.org_a_thread_231722770.html`   | `a`   | `231722770.html` |
 * | `boards.4chan.org_pol.html` (a board index)  | `pol` | `index.html`     |
 * | `<board>/<anything>` (already nested)        | dir   | unchanged        |
 * | `co_65683092.html` (third-party mirror)      | `co`  | `65683092.html`  |
 *
 * A name matching none of these is reported, not dropped silently.
 *
 * **Names are not always normalised to `<threadno>.html`, deliberately.**
 * 4chan-vp-2015-threads stages `<date>_<threadno>.html` because the same
 * thread was captured on consecutive days, and collapsing the captures to one
 * name would keep only one of them. The reader treats a digits-only filename
 * as asserting the thread number and anything else as deferring to the
 * markup, so multi-capture names still resolve -- each page's own OP supplies
 * the thread.
 */

export interface StageNativeOptions {
  from: string;
  to: string;
}

export interface StageNativeStats {
  staged: number;
  unmatched: number;
}

const PAGE = /\.html?$/i;
const ASSET_DIR = /(?:_files|^css|^js|^images|^thumbs)$/i;
/** A staged page's own image directory, `a_10781807/` next to the page. */
const PAGE_ASSET_DIR = /^[a-z0-9]+_\d+$/i;

const identify = (
  name: string,
  parent: string | null
): { board: string; file: string } | null => {
  const thread = /^boards\.4chan(?:nel)?\.org_([a-z0-9]+)_thread_(\d+)/i.exec(
    name
  );
  if (thread) {
    return { board: thread[1], file: `${thread[2]}.html` };
  }
  const index = /^boards\.4chan(?:nel)?\.org_([a-z0-9]+)\b/i.exec(name);
  if (index) {
    // A board index names no single thread; the reader reads each OP's own.
    return { board: index[1], file: 'index.html' };
  }
  if (parent !== null) {
    return { board: parent, file: name };
  }
  const mirrored = /^([a-z0-9]+)_(.+\.html?)$/i.exec(name);
  return mirrored ? { board: mirrored[1], file: mirrored[2] } : null;
};

export const stageNativeHtml = (opts: StageNativeOptions): StageNativeStats => {
  rmSync(opts.to, { recursive: true, force: true });
  mkdirSync(opts.to, { recursive: true });

  const stats = { staged: 0, unmatched: 0 };
  const consider = (
    path: string,
    name: string,
    parent: string | null
  ): void => {
    // Read only enough to classify: these trees run to 23,295 pages.
    let head: string;
    try {
      head = readFileSync(path, 'utf8');
    } catch {
      return; // non-UTF-8 filenames exist in handmade mirrors
    }
    if (!head.includes('postContainer')) {
      return;
    }
    const id = identify(name, parent);
    if (!id) {
      stats.unmatched++;
      console.error(`    unmatched filename: ${path}`);
      return;
    }
    const dest = join(opts.to, id.board);
    mkdirSync(dest, { recursive: true });
    sh(
      `cp -al ${JSON.stringify(path)} ${JSON.stringify(join(dest, id.file))} 2>/dev/null || ` +
        `cp -a ${JSON.stringify(path)} ${JSON.stringify(join(dest, id.file))}`
    );
    stats.staged++;
  };

  for (const e of readdirSync(opts.from, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (ASSET_DIR.test(e.name) || PAGE_ASSET_DIR.test(e.name)) {
        continue;
      }
      for (const f of readdirSync(join(opts.from, e.name), {
        withFileTypes: true,
      })) {
        if (f.isFile() && PAGE.test(f.name)) {
          consider(join(opts.from, e.name, f.name), f.name, e.name);
        }
      }
      continue;
    }
    if (e.isFile() && PAGE.test(e.name)) {
      consider(join(opts.from, e.name), e.name, null);
    }
  }

  if (stats.unmatched > 0) {
    console.error(
      `    ${stats.unmatched} page(s) had no recognisable board/thread name`
    );
  }
  return stats;
};
