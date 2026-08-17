import { object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { optional, withDefault } from '@optique/core/modifiers';
import { flag, option } from '@optique/core/primitives';
import { defineProgram } from '@optique/core/program';
import { integer, string } from '@optique/core/valueparser';
import { run } from '@optique/run';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PROJECT_ROOT } from '@chan-post-store/cli/paths';

import { renderTimeline, type Kind, type TimelineEvent } from './svg.ts';

/**
 * Charts `4chan-board-lifespans.json` as a wrapped timeline of every board
 * creation and removal.
 *
 * Unlike the other tools here this one never touches the database — the
 * lifespan registry is a committed JSON file compiled from the Bibliotheca
 * Anonoma wiki and archived 4chan news posts, so there is no `--db` and no
 * connection to configure.
 */

const program = defineProgram({
  parser: object({
    rows: withDefault(
      option('--rows', integer(), {
        description: message`How many times the line wraps. An ODD count ends the line bottom-right, which reads better; an even one ends bottom-left because the last row runs backwards. More rows is not automatically better -- each row is narrower in time, so batches have less room to fan into.`,
      }),
      5
    ),
    fontMax: withDefault(
      option('--font-max', integer(), {
        description: message`Largest label size to attempt. The layout starts here and shrinks by half-points until the whole chart fits, so this is a ceiling rather than the size you will get.`,
      }),
      16
    ),
    gapMin: withDefault(
      option('--gap-min', integer(), {
        description: message`Collapse any stretch of this many years with no events, marking it. 1 collapses four stretches and reclaims 41% of the axis; 0 disables collapsing entirely and spends that space on empty line.`,
      }),
      1
    ),
    bg: optional(
      option('--bg', string(), {
        description: message`Slide colour, used only to knock a halo out behind labels where a leader would cross the text. Omitted renders on transparency, which is the default -- the chart paints no background of its own.`,
      })
    ),
    out: optional(
      option('--out', string(), {
        description: message`Output path without extension, resolved against the repo root. Defaults to artifacts/board-timeline.`,
      })
    ),
    svg: withDefault(
      flag('--svg', {
        description: message`Keep the intermediate SVG next to the PNG. It is deleted by default.`,
      }),
      false
    ),
  }),
  metadata: {
    name: 'timeline.ts',
    brief: message`Chart every 4chan board creation and removal on one page.`,
    description: message`A serpentine timeline of the board registry: the line runs left to right, U-turns, and comes back, so 22.8 years fit one 16:9 slide. Creations sit above the line and removals below, which is what carries the distinction -- colour only reinforces it. Quiet stretches longer than --gap-min collapse to a marked break captioned with the time skipped, because 41% of the span has no events in it. April Fools boards, created on 1 April and deleted within days, merge into one mark per year; a joke board that SURVIVED (/s4s/, 2013) stays an ordinary creation, which is why the rule tests for the deletion rather than the date. Writes a PNG (via resvg) into artifacts/.`,
  },
});

const values = run(program, { help: 'both' });

const REGISTRY = join(PROJECT_ROOT, '4chan-board-lifespans.json');

interface RawEvent {
  type: 'created' | 'removed';
  slug: string;
  name?: string;
  date?: string;
  note?: string;
}

interface Registry {
  cited: RawEvent[];
  citation_needed: RawEvent[];
}

let registry: Registry;
try {
  registry = JSON.parse(readFileSync(REGISTRY, 'utf8')) as Registry;
} catch (e) {
  console.error(
    `could not read ${REGISTRY}: ${(e as Error).message}\n` +
      '  the board registry is committed at the repo root; this tool needs no database'
  );
  process.exit(1);
}

/** "2004-03-15" or "2004-03" -> decimal year. Month precision is kept. */
const toYear = (d: string): number => {
  const [y, m = '1', day = '1'] = d.split('-');
  return Number(y) + (Number(m) - 1) / 12 + (Number(day) - 1) / 365.25;
};
const dayNum = (d: string): number => Date.parse(`${d}T00:00:00Z`) / 86400000;

const dated = registry.cited.filter((e) => e.date);
const fullyDated = dated.filter((e) => e.date!.length === 10);

// April Fools batches: created on 1 April and gone within the week.
//
// This tests for the matching REMOVAL rather than trusting the date, because
// /s4s/ launched as an April Fools board on 2013-04-01 and is still up. Date
// alone would have quietly merged a live board into a joke mark.
const foolsPairs: { c: RawEvent; r: RawEvent }[] = [];
for (const c of fullyDated) {
  if (c.type !== 'created') {
    continue;
  }
  const [, m, dd] = c.date!.split('-').map(Number);
  if (m !== 4 || dd > 2) {
    continue;
  }
  const r = fullyDated.find(
    (x) =>
      x.type === 'removed' &&
      x.slug === c.slug &&
      dayNum(x.date!) > dayNum(c.date!) &&
      dayNum(x.date!) - dayNum(c.date!) <= 7
  );
  if (r) {
    foolsPairs.push({ c, r });
  }
}
const merged = new Set<RawEvent>(foolsPairs.flatMap(({ c, r }) => [c, r]));

const byYear = new Map<number, { c: RawEvent; r: RawEvent }[]>();
for (const p of foolsPairs) {
  const y = Number(p.c.date!.slice(0, 4));
  byYear.set(y, [...(byYear.get(y) ?? []), p]);
}
const foolsEvents: TimelineEvent[] = [...byYear.entries()].map(([y, ps]) => ({
  t: toYear(ps[0].c.date!),
  kind: 'fools' as Kind,
  label:
    ps.length === 1
      ? `April Fools ${y} · ${ps[0].c.slug}`
      : `April Fools ${y} · ${ps.length} boards`,
}));

const events: TimelineEvent[] = dated
  .filter((e) => !merged.has(e))
  .map((e) => ({
    t: toYear(e.date!),
    label: e.slug,
    kind: (e.type === 'created' ? 'created' : 'removed') as Kind,
  }))
  .concat(foolsEvents);

if (events.length === 0) {
  console.error(`${REGISTRY} holds no dated events`);
  process.exit(1);
}

// Only events with NO date at all are omitted. The YYYY-MM entries are
// month-precision rather than undated, and are plotted at the start of the
// month -- counting them here would overstate what the chart leaves out.
const undated =
  registry.cited.filter((e) => !e.date).length +
  registry.citation_needed.length;
const created = dated.filter((e) => e.type === 'created').length;
const removed = dated.length - created;
const nFools = foolsPairs.length;

// "Today" rather than a hardcoded year, so the axis does not go stale.
const now = new Date();
const nowYear = now.getUTCFullYear() + now.getUTCMonth() / 12;

const plural = (n: number, one: string, many: string): string =>
  n === 1 ? one : many;

const svg = renderTimeline(
  {
    events,
    now: nowYear,
    title: 'Every 4chan board, created and removed',
    subtitle:
      `${dated.length} dated events, Oct ${Math.floor(Math.min(...events.map((e) => e.t)))} to today — ` +
      `${created} boards created, ${removed} removed. The line wraps like text; ` +
      `quiet stretches over ${values.gapMin === 1 ? 'a year' : `${values.gapMin} years`} collapse at the ⁄⁄ marks.`,
    footer:
      "Source: Bibliotheca Anonoma 4chan/History timeline, cross-checked against archived 4chan news posts and moot's Something Awful posts" +
      ` · ${nFools} April Fools boards merged into ${byYear.size} marks` +
      ` · ${undated} undated ${plural(undated, 'event', 'events')} omitted`,
  },
  {
    rows: values.rows,
    fontMax: values.fontMax,
    gapMin: values.gapMin,
    bg: values.bg ?? null,
  }
);

const outDir = join(PROJECT_ROOT, 'artifacts');
mkdirSync(outDir, { recursive: true });
const base = values.out
  ? resolve(PROJECT_ROOT, values.out)
  : join(outDir, 'board-timeline');
const svgPath = `${base}.svg`;
const pngPath = `${base}.png`;
writeFileSync(svgPath, svg);

// resvg comes from the flake rather than a native npm module, so the toolchain
// stays declarative. --zoom 2 because the labels are small by necessity and a
// 1x render is not readable projected.
const r = spawnSync('resvg', ['--zoom', '2', svgPath, pngPath], {
  stdio: 'inherit',
});
if (r.error || r.status !== 0) {
  console.error(
    `resvg failed (${r.error?.message ?? `exit ${r.status}`}); SVG written to ${svgPath}`
  );
  process.exit(1);
}
if (!values.svg) {
  unlinkSync(svgPath);
}
console.log(`wrote ${pngPath}`);
