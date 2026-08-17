/**
 * Hand-built SVG for the corpus-coverage chart.
 *
 * Horizontal stacked bars: one bar per year, segmented by the archive that
 * supplied each post. Not the mirrored population-pyramid layout, because that
 * form carries exactly two categories (the left and right halves) and the
 * corpus has one series per archive — six and counting.
 *
 * Stacked rather than grouped, because the question the chart answers is "how
 * much of this year do we hold, and who supplied it" — a part-to-whole reading
 * per year. That makes the bar length the year's total, which is the number
 * worth comparing across rows, and each segment a share of it. The cost is the
 * usual one for stacked bars: only the first segment sits on a common
 * baseline, so comparing a middle archive *between* years is genuinely hard.
 * If that becomes the question, this wants to be small multiples instead.
 *
 * Segments are separated by a 2px surface gap and the bar's far end is
 * rounded, so a stack reads as one bar rather than a run of abutting blocks.
 */

export interface Series {
  name: string;
  color: string;
}

export interface ChartData {
  /** Row labels, top to bottom. */
  years: string[];
  series: Series[];
  /** value[year][series] */
  values: Map<string, Map<string, number>>;
  title: string;
  subtitle: string;
}

const PAL = {
  surface: '#fcfcfb',
  textPrimary: '#0b0b0b',
  textSecondary: '#52514e',
  textMuted: '#84837c',
  grid: '#e6e5e0',
  axis: '#c9c8c1',
};

/**
 * Nice round tick values spanning [0, max].
 *
 * The final tick is always >= max, so the axis encloses the data — stopping
 * at the last tick below max would let bars run past the end of the scale.
 */
const ticks = (max: number, count = 5): number[] => {
  if (max <= 0) {
    return [0, 1];
  }
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = ([1, 2, 5].find((n) => norm <= n) ?? 10) * mag;
  const out: number[] = [];
  for (let v = 0; v < max - step * 1e-9; v += step) {
    out.push(v);
  }
  out.push(out.length ? out[out.length - 1] + step : step);
  return out;
};

const compact = (n: number): string => {
  if (n >= 1e9) {
    return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 3)}B`;
  }
  if (n >= 1e6) {
    return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 3)}M`;
  }
  if (n >= 1e3) {
    return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 3)}k`;
  }
  return String(n);
};

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const renderChart = (d: ChartData): string => {
  // One bar per year now, so every row is the same height and the bar can be
  // thicker than it was when a row had to hold up to six of them.
  const barH = 18;
  const segGap = 2; // 2px surface gap between adjacent fills
  const groupGap = 10; // space between one year and the next
  const padL = 300;
  const padR = 110;
  const padB = 64;
  const plotW = 860;

  // Which sources appear in a year, in series order — the series list is
  // sorted largest-total-first, so the heaviest archive sits against the
  // baseline where it is easiest to read and the stack order is stable from
  // row to row.
  const rowsPresent = d.years.map((y) =>
    d.series.filter((s) => (d.values.get(y)?.get(s.name) ?? 0) > 0)
  );
  const rowH = barH + groupGap;
  const rowTops = d.years.map((_, i) => i * rowH);
  const plotH = rowH * d.years.length;

  // Header height depends on how many lines the subtitle wraps to, so it is
  // measured before the canvas is sized.
  const maxChars = Math.floor((plotW + padR) / 7.4);
  const subtitleLines: string[] = [];
  {
    let line = '';
    for (const word of d.subtitle.split(' ')) {
      if (line && `${line} ${word}`.length > maxChars) {
        subtitleLines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) {
      subtitleLines.push(line);
    }
  }
  // Lay the legend out before sizing the canvas: with six sources the entries
  // do not fit on one row, and the header has to reserve height for however
  // many rows they wrap onto.
  const LEGEND_ROW_H = 20;
  const legendRows: { color: string; name: string; x: number }[][] =
    d.series.length > 1 ? [[]] : [];
  if (d.series.length > 1) {
    let lx = 0;
    for (const s of d.series) {
      const entryW = 15 + s.name.length * 6.9 + 28;
      // Wrap rather than run off the canvas, but never leave a row empty --
      // an entry wider than the plot still has to go somewhere.
      if (lx > 0 && lx + entryW > plotW) {
        legendRows.push([]);
        lx = 0;
      }
      legendRows[legendRows.length - 1].push({
        color: s.color,
        name: s.name,
        x: lx,
      });
      lx += entryW;
    }
  }
  // Room for the header, plus however many legend rows there are.
  const padT =
    63 +
    subtitleLines.length * 18 +
    (d.series.length > 1 ? 26 + legendRows.length * LEGEND_ROW_H : 20);
  const w = padL + plotW + padR;
  const h = padT + plotH + padB;

  // The scale is set by the largest year TOTAL, not the largest single source:
  // the bar now runs to the sum, and scaling to a single source would push
  // every stacked bar off the end of the axis.
  const rowTotal = (y: string): number =>
    d.series.reduce((n, s) => n + (d.values.get(y)?.get(s.name) ?? 0), 0);
  const max = Math.max(0, ...d.years.map(rowTotal));
  const tv = ticks(max);
  const scale = (v: number): number => (v / tv[tv.length - 1]) * plotW;

  const o: string[] = [];
  o.push(
    // Concrete family names only: resvg resolves through fontconfig and
    // silently drops text when nothing matches, so CSS-generic stacks
    // (ui-sans-serif, system-ui) are not usable here.
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="DejaVu Sans, Liberation Sans, Noto Sans, sans-serif">`
  );
  o.push(`<rect width="${w}" height="${h}" fill="${PAL.surface}"/>`);

  o.push(
    `<text x="${padL}" y="40" font-size="21" font-weight="600" fill="${PAL.textPrimary}">${esc(d.title)}</text>`
  );
  subtitleLines.forEach((l, i) => {
    o.push(
      `<text x="${padL}" y="${63 + i * 18}" font-size="13" fill="${PAL.textSecondary}">${esc(l)}</text>`
    );
  });

  // Legend: identity is never colour-alone, so each swatch is labelled.
  // Widths come from an estimate of the rendered text — DejaVu Sans at 12px
  // averages ~6.9px/char — since there is no text metrics API here. A single
  // series needs no legend: the title already names it.
  legendRows.forEach((row, ri) => {
    const ly = padT - 26 - (legendRows.length - 1 - ri) * LEGEND_ROW_H;
    for (const e of row) {
      o.push(
        `<rect x="${padL + e.x}" y="${ly - 9}" width="10" height="10" rx="2" fill="${e.color}"/>`
      );
      o.push(
        `<text x="${padL + e.x + 15}" y="${ly}" font-size="12" fill="${PAL.textSecondary}">${esc(e.name)}</text>`
      );
    }
  });

  // Vertical gridlines behind the bars.
  for (const t of tv) {
    const x = padL + scale(t);
    o.push(
      `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${t === 0 ? PAL.axis : PAL.grid}" stroke-width="1"/>`
    );
    o.push(
      `<text x="${x}" y="${padT + plotH + 20}" font-size="11" fill="${PAL.textMuted}" text-anchor="middle">${compact(t)}</text>`
    );
  }
  o.push(
    `<text x="${padL + plotW / 2}" y="${padT + plotH + 44}" font-size="12" fill="${PAL.textSecondary}" text-anchor="middle">Posts</text>`
  );

  d.years.forEach((year, i) => {
    const top = padT + rowTops[i];
    const present = rowsPresent[i];
    o.push(
      `<text x="${padL - 12}" y="${top + barH / 2 + 4}" font-size="12" fill="${PAL.textPrimary}" text-anchor="end">${esc(year)}</text>`
    );

    // Segments run from the baseline in series order. `cursor` advances by the
    // segment's TRUE width while the drawn rect is shortened by the gap, so
    // the separators never lengthen the bar or shift what follows.
    let cursor = padL;
    present.forEach((s, j) => {
      const v = d.values.get(year)!.get(s.name)!;
      const full = scale(v);
      const last = j === present.length - 1;
      // A sliver stays visible rather than disappearing under the gap: a
      // source that contributed to a year should be findable in that year's
      // bar, even when its share rounds to under a pixel.
      const drawn = Math.max(last ? full : full - segGap, 0.8);
      if (last) {
        // 4px rounded data-end on the far end only; the stack is square
        // against the zero baseline.
        const r = Math.min(4, drawn);
        o.push(
          `<path d="M${cursor} ${top} H${cursor + drawn - r} a${r} ${r} 0 0 1 ${r} ${r} V${top + barH - r} a${r} ${r} 0 0 1 -${r} ${r} H${cursor} Z" fill="${s.color}"/>`
        );
      } else {
        o.push(
          `<rect x="${cursor}" y="${top}" width="${drawn}" height="${barH}" fill="${s.color}"/>`
        );
      }
      cursor += full;
    });

    // One number per bar, and it is the year's total -- which is what the bar
    // length now means. Per-segment values would need six labels on a 4px
    // sliver; the legend plus segment length carries the split.
    const total = rowTotal(year);
    if (total > 0) {
      o.push(
        `<text x="${padL + scale(total) + 8}" y="${top + barH - 4}" font-size="10" fill="${PAL.textMuted}">${compact(total)}</text>`
      );
    }
  });

  o.push('</svg>');
  return o.join('\n');
};
