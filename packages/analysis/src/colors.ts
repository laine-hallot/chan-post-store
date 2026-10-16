/**
 * Series colours shared by the analysis charts, so two tools never disagree
 * about which hue means what kind of thing.
 */

// Tailwind's default palette, non-gray hues only: every 500 in Tailwind's hue
// order, then every 200 in the same order. Converted from the published
// oklch() definitions to sRGB hex because resvg renders the SVG and oklch()
// is not something to depend on there.
//
// The 500s come first because they are the saturated, readable ones; the 200s
// are pastels that only get reached past 17 sources, and on the chart's light
// surface they are low contrast. That is survivable for the same reason the
// previous six-colour set tolerated it: every bar carries its value as a
// label, so identity never rests on hue alone. (post-dates has no such
// labels; it relies on its legend, and on being given a handful of sources.)
//
// This replaced a six-colour set chosen for CVD separation (worst adjacent
// dE 9.1). Thirty-four colours cannot all be mutually distinguishable, under
// CVD or otherwise -- adjacent hues here are deliberately close. The trade is
// deliberate: the corpus outgrew six sources, and a chart that refuses to
// render is worse than one where two of fourteen archives are similar.
//
// Never cycle this list. Reusing a hue would paint two archives identically --
// the bug this whole guard exists for, where three colours across six sources
// made laza-fuuka indistinguishable from warosu-2025 and silently mislabeled a
// 72M-post bar. If the corpus ever exceeds 34 sources, add slots or chart a
// subset; do not wrap around.
export const COLORS = [
  '#fb2c36', // red-500
  '#ff6900', // orange-500
  '#fe9a00', // amber-500
  '#f0b100', // yellow-500
  '#7ccf00', // lime-500
  '#00c950', // green-500
  '#00bc7d', // emerald-500
  '#00bba7', // teal-500
  '#00b8db', // cyan-500
  '#00a6f4', // sky-500
  '#2b7fff', // blue-500
  '#615fff', // indigo-500
  '#8e51ff', // violet-500
  '#ad46ff', // purple-500
  '#e12afb', // fuchsia-500
  '#f6339a', // pink-500
  '#ff2056', // rose-500
  '#ffc9c9', // red-200
  '#ffd6a7', // orange-200
  '#fee685', // amber-200
  '#fff085', // yellow-200
  '#d8f999', // lime-200
  '#b9f8cf', // green-200
  '#a4f4cf', // emerald-200
  '#96f7e4', // teal-200
  '#a2f4fd', // cyan-200
  '#b8e6fe', // sky-200
  '#bedbff', // blue-200
  '#c6d2ff', // indigo-200
  '#ddd6ff', // violet-200
  '#e9d4ff', // purple-200
  '#f6cfff', // fuchsia-200
  '#fccee8', // pink-200
  '#ffccd3', // rose-200
] as const;

/** Hues per tier: the 500s, then the 200s, each in Tailwind's hue order. */
const HUES = 17;

/**
 * How far round the wheel a clash moves a colour. Coprime with HUES, so
 * repeated steps visit every hue before any twice; 7 of 17 is ~150 degrees,
 * as far from the clash as the wheel allows while still covering it all.
 */
const STRIDE = 7;

const FNV_PRIME = 0x01000193;
const FNV_OFFSET = 0x811c9dc5;

/** 32-bit FNV-1a: xor the byte in, then multiply. */
const fnv1a = (input: string): number => {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
};

/**
 * A name's own hue, from its hash alone: the same on every chart it appears
 * in. Scaled from the top of the hash rather than taken modulo, since FNV's
 * multiply carries its mixing upward and the high bits are the better-mixed
 * ones.
 */
const homeHue = (name: string): number =>
  Math.floor((fnv1a(name) / 2 ** 32) * HUES);

/** Steps between two hues the short way round the wheel. */
const hueDistance = (a: number, b: number): number => {
  const d = Math.abs(a - b) % HUES;
  return Math.min(d, HUES - d);
};

/**
 * A colour for each name, the same one wherever the name is charted unless
 * it clashes.
 *
 * Every name has a home hue in the saturated tier. Seventeen hues cannot
 * hold even a handful of names without clashes -- thirteen names in
 * seventeen slots share one about 99% of the time -- and a colour is never
 * used twice (see COLORS), so clashes are settled in two passes:
 *
 *   1. Every name whose home is free takes it; where names share a home the
 *      first in sorted order gets it. Only a name whose OWN home is contested
 *      ever moves. Settling one name at a time instead let a moved name land
 *      on someone else's home and push them out in turn -- on /g/, seven of
 *      thirteen sources moved where five had to.
 *   2. Each name that lost goes to the free hue farthest round the wheel
 *      from every taken one, so it lands in the emptiest part of the chart's
 *      palette rather than next to an existing colour. Ties go to whichever
 *      comes first stepping STRIDE hues at a time from its home.
 *
 * Past seventeen names the saturated tier is full and the pastels are
 * filled the same way. Sorted order throughout means the outcome depends on
 * WHICH names are charted and never on the order they were given in.
 */
export const assignColours = (names: string[]): Map<string, string> => {
  const unique = [...new Set(names)].sort();
  if (unique.length > COLORS.length) {
    throw new Error(
      `${unique.length} names but only ${COLORS.length} colours; chart a subset`
    );
  }
  const out = new Map<string, string>();
  const taken = new Set<number>();
  const give = (name: string, slot: number): void => {
    taken.add(slot);
    out.set(name, COLORS[slot]!);
  };

  const losers: string[] = [];
  for (const name of unique) {
    const home = homeHue(name);
    if (taken.has(home)) {
      losers.push(name);
    } else {
      give(name, home);
    }
  }

  for (const name of losers) {
    const home = homeHue(name);
    // The saturated tier until it is full, then the pastels.
    const tier = taken.size < HUES ? 0 : 1;
    const inTier = [...taken]
      .filter((t) => Math.floor(t / HUES) === tier)
      .map((t) => t % HUES);
    let best: { slot: number; gap: number } | undefined;
    for (let k = 0; k < HUES; k++) {
      const hue = (home + STRIDE * k) % HUES;
      const slot = tier * HUES + hue;
      if (taken.has(slot)) {
        continue;
      }
      const gap = Math.min(HUES, ...inTier.map((t) => hueDistance(t, hue)));
      if (best === undefined || gap > best.gap) {
        best = { slot, gap };
      }
    }
    give(name, best!.slot);
  }
  return out;
};
