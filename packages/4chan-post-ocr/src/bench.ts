import { object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { multiple, withDefault } from '@optique/core/modifiers';
import { flag, option } from '@optique/core/primitives';
import { defineProgram } from '@optique/core/program';
import { string } from '@optique/core/valueparser';
import { run } from '@optique/run';
import { resolve } from 'node:path';

import { PROJECT_ROOT, printTable } from '@chan-post-store/cli';

import {
  loadDataset,
  pairKey,
  type TruthImage,
  type TruthRow,
} from './dataset.ts';
import { LOOSE_DATE, type HeaderRead } from './header.ts';
import { findHeaders, paddleLines, type FoundHeader } from './paddle.ts';

/**
 * Scores header OCR against the hand-labelled screenshots in data/Timelines.
 *
 * Three questions, kept apart because they fail for different reasons and
 * are fixed in different places:
 *
 *   found  -- did a header-shaped line turn up where a labelled post is?
 *             (layout: is the post's header being located at all)
 *   exact  -- was that post's number AND timestamp read character-perfect?
 *             (recognition: are the characters right)
 *   wrong  -- how many confident reads name a (post, date) nobody labelled?
 *             (precision: what the pipeline would feed downstream as fact)
 *
 * The labels carry no positions, so a labelled row is matched to the header
 * line that reads most like it. `wrong` is checked against every row of the
 * image's BOARD, not just the image's own rows: a post visible in two
 * screenshots is labelled against one of them, and reading it correctly in
 * the other is not an error.
 */

const program = defineProgram({
  parser: object({
    dataset: withDefault(
      option('--dataset', string(), {
        description: message`The labelled screenshot set, relative to the repo root.`,
      }),
      'data/Timelines'
    ),
    image: multiple(
      option('--image', string(), {
        description: message`Score only this screenshot, by file name. Repeatable.`,
      })
    ),
    verbose: withDefault(
      flag('--verbose', {
        description: message`List every labelled row that was not read exactly, with what was read instead.`,
      }),
      false
    ),
  }),
  metadata: {
    name: 'bench.ts',
    brief: message`Score PaddleOCR's post-header reads against the labelled screenshots.`,
  },
});

const values = await run(program, { help: 'both' });

// ---- matching labelled rows to header lines ------------------------------

const levenshtein = (a: string, b: string): number => {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length]!;
};

/** What a row looks like in OCR text once spaces are gone. */
const canonical = (r: TruthRow): string =>
  `${r.date}${r.utcOffset ? `UTC${r.utcOffset}` : ''}No.${r.postNo}`;

/**
 * How far a header line's text is from spelling out a row. Only the part
 * from the date on is compared -- the name before it is irrelevant -- and
 * only about as much as the row is long, since a header can run on into a
 * wall of `Replies: >>…` links that would swamp any whole-line distance.
 */
const distance = (line: string, row: TruthRow): number => {
  const text = line.replace(/\s+/g, '');
  const want = canonical(row);
  const start = Math.max(0, text.search(LOOSE_DATE));
  const tail = text.slice(start, start + want.length + 4);
  let best = Infinity;
  for (let n = Math.max(1, want.length - 4); n <= tail.length; n++) {
    best = Math.min(best, levenshtein(tail.slice(0, n), want));
  }
  return best;
};

interface Scored {
  image: TruthImage;
  headers: FoundHeader[];
  /** Per labelled row: the header matched to it, if any. */
  matched: (FoundHeader | undefined)[];
  /** Per labelled row: whether any header read it exactly. */
  exact: boolean[];
  /** Strict reads naming a (post, date) not labelled anywhere on the board. */
  wrong: HeaderRead[];
  reads: number;
}

const score = (
  image: TruthImage,
  headers: FoundHeader[],
  known: Set<string>
): Scored => {
  const reads = headers
    .map((h) => h.read)
    .filter((r): r is HeaderRead => r !== null);
  const readKeys = new Set(reads.map((r) => pairKey(r.postNo, r.date)));

  // Greedy one-to-one assignment, closest pairs first. A row matches a line
  // only within about a third of its own length in edits: close enough to be
  // a misread of it, far enough from being a different post's header.
  const pairs: { row: number; line: number; d: number }[] = [];
  for (const [ri, row] of image.rows.entries()) {
    const limit = Math.max(4, Math.floor(canonical(row).length / 3));
    for (const [li, line] of headers.entries()) {
      const d = distance(line.text, row);
      if (d <= limit) {
        pairs.push({ row: ri, line: li, d });
      }
    }
  }
  pairs.sort((a, b) => a.d - b.d);
  const matched: (FoundHeader | undefined)[] = image.rows.map(() => undefined);
  const usedLines = new Set<number>();
  for (const p of pairs) {
    if (matched[p.row] === undefined && !usedLines.has(p.line)) {
      matched[p.row] = headers[p.line];
      usedLines.add(p.line);
    }
  }

  return {
    image,
    headers,
    matched,
    exact: image.rows.map((r) => readKeys.has(pairKey(r.postNo, r.date))),
    wrong: reads.filter((r) => !known.has(pairKey(r.postNo, r.date))),
    reads: reads.length,
  };
};

// ---- running -------------------------------------------------------------

const dataset = loadDataset(resolve(PROJECT_ROOT, values.dataset));
const wanted = new Set(values.image);
const images = wanted.size
  ? dataset.images.filter((i) => wanted.has(i.name))
  : dataset.images;
const unknown = [...wanted].filter((w) => !images.some((i) => i.name === w));
if (unknown.length) {
  console.error(`no labelled screenshot named: ${unknown.join(', ')}`);
  process.exit(1);
}

console.log(`OCRing ${images.length} screenshot(s) with PaddleOCR ...`);
const t0 = Date.now();

const byPath = await paddleLines(images.map((i) => i.path));
const results = images.map((image) =>
  score(
    image,
    findHeaders(byPath.get(image.path) ?? []),
    dataset.known.get(image.board)!
  )
);
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

// ---- reporting -----------------------------------------------------------

const count = (xs: boolean[]): number => xs.filter(Boolean).length;
const pct = (n: number, of: number): string =>
  of === 0 ? '-' : `${((100 * n) / of).toFixed(1)}%`;

const rows = results.reduce((n, r) => n + r.image.rows.length, 0);
const found = results.reduce((n, r) => n + count(r.matched.map(Boolean)), 0);
const exact = results.reduce((n, r) => n + count(r.exact), 0);
const reads = results.reduce((n, r) => n + r.reads, 0);
const wrong = results.reduce((n, r) => n + r.wrong.length, 0);

// Worst first: the images that most need looking at.
const byWorst = [...results].sort(
  (a, b) =>
    count(a.exact) / a.image.rows.length - count(b.exact) / b.image.rows.length
);
printTable(
  ['screenshot', 'rows', 'found', 'exact', 'wrong'],
  byWorst.map((r) => [
    r.image.name,
    r.image.rows.length,
    count(r.matched.map(Boolean)),
    count(r.exact),
    r.wrong.length,
  ]),
  ['TOTAL', rows, found, exact, wrong]
);

console.log(`
headers found  ${found}/${rows} (${pct(found, rows)})
read exactly   ${exact}/${rows} (${pct(exact, rows)})
strict reads   ${reads}, of which ${wrong} name a post+date nobody labelled (${pct(wrong, reads)})`);

if (values.verbose) {
  console.log('\nnot read exactly:');
  for (const r of results) {
    for (const [i, row] of r.image.rows.entries()) {
      if (r.exact[i]) {
        continue;
      }
      const h = r.matched[i];
      console.log(
        `  ${r.image.name}  ${canonical(row)}\n` +
          (h ? `      ${h.text}\n` : '      no header line found\n')
      );
    }
  }

  console.log('\nconfident reads of a post+date nobody labelled:');
  for (const r of results) {
    for (const w of r.wrong) {
      const h = r.headers.find((x) => x.read === w)!;
      console.log(
        `  ${r.image.name}  read ${w.date}No.${w.postNo}\n      ${h.text}\n`
      );
    }
  }
}
