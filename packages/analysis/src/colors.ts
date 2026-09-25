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
];
