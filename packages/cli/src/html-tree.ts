import { opendirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Finds saved HTML pages for the HTML adapters, in either of the two layouts
 * the archives use:
 *
 *   flat:   <root>/<page>.html                     (perma.cc, fybertech)
 *   nested: <root>/<board>/<threadno>.html         (Yotsuba Society)
 *
 * A nested tree is detected rather than declared: if the root holds no .html
 * files but its subdirectories do, those subdirectory names are boards. That
 * keeps one adapter working across both shapes instead of needing a manifest
 * flag whose value could disagree with the tree.
 *
 * Asset directories are skipped. Yotsuba Society puts a `<threadno>_files/`
 * beside every page, and BASC-Archiver-style trees use css/js/images/thumbs;
 * descending into those would read thousands of files that hold no posts.
 */

const ASSET_DIR = /(?:_files|^css|^js|^images|^thumbs)$/i;

export interface HtmlPageRef {
  /** Absolute path to the page. */
  path: string;
  /** Filename alone, for adapters that read identity out of it. */
  name: string;
  /** Subdirectory it came from, or null when the tree is flat. */
  board: string | null;
}

function htmlNamesIn(dir: string): string[] {
  const out: string[] = [];
  let d;
  try {
    d = opendirSync(dir);
  } catch {
    return out;
  }
  try {
    let e;
    while ((e = d.readSync()) !== null) {
      if (e.isFile() && /\.html?$/i.test(e.name)) out.push(e.name);
    }
  } finally {
    d.closeSync();
  }
  return out.sort();
}

function subdirsIn(dir: string): string[] {
  const out: string[] = [];
  let d;
  try {
    d = opendirSync(dir);
  } catch {
    return out;
  }
  try {
    let e;
    while ((e = d.readSync()) !== null) {
      if (!e.isDirectory()) continue;
      if (ASSET_DIR.test(e.name)) continue;
      out.push(e.name);
    }
  } finally {
    d.closeSync();
  }
  return out.sort();
}

/**
 * Lists the HTML pages under `root`, descending one level into board
 * directories when the root itself holds none.
 *
 * `boards`, when given, filters nested trees by directory name. It cannot
 * filter a flat tree -- there the board comes from each page's own filename or
 * markup, which only the adapter can read -- so callers still apply their own
 * per-page board check.
 */
export function listHtmlPages(root: string, boards?: string[]): HtmlPageRef[] {
  const flat = htmlNamesIn(root);
  if (flat.length > 0) {
    return flat.map((name) => ({ path: join(root, name), name, board: null }));
  }

  const out: HtmlPageRef[] = [];
  for (const board of subdirsIn(root)) {
    if (boards && !boards.includes(board)) continue;
    const dir = join(root, board);
    for (const name of htmlNamesIn(dir)) {
      out.push({ path: join(dir, name), name, board });
    }
  }
  return out;
}

/** True when `path` is a directory, false for anything unreadable. */
export function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
