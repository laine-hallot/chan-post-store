import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

/**
 * The hand-labelled screenshot set: one markdown table per board, one row
 * per legible post header, each naming the screenshot it was read from.
 *
 *   | Post ID  | Date                  | Source             |
 *   | 26666666 | 08/05/12(Sun)17:42    | [[26666666_g.png]] |
 *
 * The date is kept exactly as 4chan printed it -- weekday, and seconds when
 * the era showed them -- because that is what OCR has to reproduce. A
 * trailing ` UTC-4` is split off: it comes from a userscript that rewrites
 * times into the viewer's zone, so it is part of the screenshot but not of
 * 4chan's own format.
 */

export interface TruthRow {
  postNo: string;
  /** As printed, e.g. `05/09/15(Sat)04:04:25`, without any UTC suffix. */
  date: string;
  /** The ` UTC-4` suffix's offset, when the screenshot carries one. */
  utcOffset: string | null;
  /** Where the row was labelled, for pointing at it in a report. */
  where: string;
}

export interface TruthImage {
  /** File name, as the markdown links it. */
  name: string;
  path: string;
  /** Board slug, from the markdown file the rows came from. */
  board: string;
  rows: TruthRow[];
}

export interface Dataset {
  images: TruthImage[];
  /**
   * Every labelled (post, date) per board, as `pairKey`s. A post visible in
   * two screenshots is labelled against only one of them, so a read that
   * matches no row of ITS image may still be a correct read of a post
   * labelled elsewhere -- and must not be scored as an invention.
   */
  known: Map<string, Set<string>>;
}

export const pairKey = (postNo: string, date: string): string =>
  `${postNo} ${date}`;

const ROW = /^\|\s*(\d+)\s*\|\s*([^|]+?)\s*\|\s*\[\[([^\]]+)\]\]\s*\|\s*$/;
const UTC = /^(.*?)\s+UTC([+-]\d+)$/;

/** Every file under `dir`, by name. The markdown links by bare name. */
const filesByName = (dir: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const entry of readdirSync(dir, { recursive: true })) {
    const path = join(dir, entry.toString());
    if (statSync(path).isFile()) {
      out.set(basename(path), path);
    }
  }
  return out;
};

export const loadDataset = (dir: string): Dataset => {
  const files = filesByName(join(dir, 'Source Images'));
  const byImage = new Map<string, TruthImage>();
  const known = new Map<string, Set<string>>();

  for (const md of readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()) {
    const board = md.slice(0, -'.md'.length);
    const lines = readFileSync(join(dir, md), 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      const m = ROW.exec(line.trim());
      if (!m) {
        continue;
      }
      const [, postNo, rawDate, name] = m as unknown as [
        string,
        string,
        string,
        string,
      ];
      const utc = UTC.exec(rawDate);
      const row: TruthRow = {
        postNo,
        date: utc ? utc[1]! : rawDate,
        utcOffset: utc ? utc[2]! : null,
        where: `${md}:${i + 1}`,
      };
      const path = files.get(name);
      if (path === undefined) {
        throw new Error(`${row.where}: no screenshot named ${name}`);
      }
      let image = byImage.get(name);
      if (image === undefined) {
        image = { name, path, board, rows: [] };
        byImage.set(name, image);
      }
      image.rows.push(row);
      let set = known.get(board);
      if (set === undefined) {
        set = new Set();
        known.set(board, set);
      }
      set.add(pairKey(row.postNo, row.date));
    }
  }
  return {
    images: [...byImage.values()].sort((a, b) => a.name.localeCompare(b.name)),
    known,
  };
};
