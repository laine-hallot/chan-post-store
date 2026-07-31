import { Buffer } from "node:buffer";
import { opendirSync, readdirSync, statSync } from "node:fs";
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
  /**
   * Path to open, as raw bytes.
   *
   * A Buffer rather than a string because handmade archives contain filenames
   * whose bytes are not valid UTF-8. Such a name survives readdir -- it comes
   * back with replacement characters -- but converting it back to bytes yields
   * a *different* name, so open() fails with ENOENT on a file that plainly
   * exists. Keeping the original bytes makes those pages readable instead of
   * lost; on the Yotsuba mirror it is 2 files in one 7,646-entry directory.
   */
  path: Buffer;
  /** Filename alone, for adapters that read identity out of it. */
  name: string;
  /** Subdirectory it came from, or null when the page sits at the root. */
  board: string | null;
}

/**
 * HTML files in `dir`, as {displayName, rawName} pairs.
 *
 * Read with `encoding: "buffer"` so the true bytes survive: a name containing
 * invalid UTF-8 cannot be reconstructed from the decoded string, and open()
 * would fail on it.
 */
const htmlNamesIn = (dir: string): { name: string; raw: Buffer }[] => {
  let raws: Buffer[];
  try {
    raws = readdirSync(dir, { encoding: "buffer" });
  } catch {
    return [];
  }
  const out: { name: string; raw: Buffer }[] = [];
  for (const raw of raws) {
    const name = raw.toString("utf8");
    if (!/\.html?$/i.test(name)) continue;
    // Directories can end in .html too; only files are pages.
    try {
      if (!statSync(joinBytes(dir, raw)).isFile()) continue;
    } catch {
      continue;
    }
    out.push({ name, raw });
  }
  return out.sort((a, z) => (a.name < z.name ? -1 : a.name > z.name ? 1 : 0));
};

/** Joins a string directory and a raw filename into a byte path. */
const joinBytes = (dir: string, name: Buffer): Buffer => {
  return Buffer.concat([Buffer.from(dir.endsWith("/") ? dir : `${dir}/`), name]);
};

const subdirsIn = (dir: string): string[] => {
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
};

/**
 * Lists the HTML pages under `root`, including any inside board
 * subdirectories.
 *
 * Root-level pages and board directories are not alternatives: the Yotsuba
 * Society mirror has 63 board directories *and* 53 board index pages
 * (`a.html`, `cgl.html`) beside them. An earlier version treated "root has
 * HTML" as proof the tree was flat and so found 53 pages instead of 23,295.
 * Both are collected, and each page reports whether a directory named its
 * board.
 *
 * `boards`, when given, filters the subdirectories by name. It cannot filter
 * root-level pages -- there the board comes from the page's own filename or
 * markup, which only the adapter can read -- so callers still apply their own
 * per-page board check.
 */
export const listHtmlPages = (root: string, boards?: string[]): HtmlPageRef[] => {
  const out: HtmlPageRef[] = htmlNamesIn(root).map(({ name, raw }) => ({
    path: joinBytes(root, raw),
    name,
    board: null,
  }));

  for (const board of subdirsIn(root)) {
    if (boards && !boards.includes(board)) continue;
    const dir = join(root, board);
    for (const { name, raw } of htmlNamesIn(dir)) {
      out.push({ path: joinBytes(dir, raw), name, board });
    }
  }
  return out;
};

/** True when `path` is a directory, false for anything unreadable. */
export const isDir = (path: string): boolean => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
