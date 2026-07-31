/**
 * Hand-built SVG for the corpus-coverage chart.
 *
 * Horizontal grouped bars: one row per year, one bar per source. Not the
 * mirrored population-pyramid layout, because that form carries exactly two
 * categories (the left and right halves) and the corpus has one series per
 * archive — six and counting. Grouped bars extend to any number of them.
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
  surface: "#fcfcfb",
  textPrimary: "#0b0b0b",
  textSecondary: "#52514e",
  textMuted: "#84837c",
  grid: "#e6e5e0",
  axis: "#c9c8c1",
};

/**
 * Nice round tick values spanning [0, max].
 *
 * The final tick is always >= max, so the axis encloses the data — stopping
 * at the last tick below max would let bars run past the end of the scale.
 */
const ticks = (max: number, count = 5): number[] => {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = 0; v < max - step * 1e-9; v += step) out.push(v);
  out.push(out.length ? out[out.length - 1] + step : step);
  return out;
};

const compact = (n: number): string => {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
};

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const renderChart = (d: ChartData): string => {
  // Bars are sized first and the row derived from them, so a bar is always a
  // bar rather than a hairline however many series there are.
  const barH = 13;
  const barGap = 2; // 2px surface gap between adjacent fills
  const groupGap = 14; // space between one year and the next
  const padL = 300;
  const padR = 110;
  const padB = 64;
  const plotW = 860;

  // Only the sources actually present in a year get a bar slot, packed from the
  // top of the row. Reserving a slot per series in every year left most rows
  // mostly empty -- 18 years x 6 sources of reserved height for a corpus where
  // most years carry one or two archives -- and pushed each bar down to its
  // series index, so the year label no longer lined up with the bar it named.
  const rowsPresent = d.years.map((y) =>
    d.series.filter((s) => (d.values.get(y)?.get(s.name) ?? 0) > 0),
  );
  const rowHeights = rowsPresent.map(
    (present) => Math.max(present.length, 1) * (barH + barGap) - barGap + groupGap,
  );
  const rowTops: number[] = [];
  {
    let acc = 0;
    for (const rh of rowHeights) {
      rowTops.push(acc);
      acc += rh;
    }
  }
  const plotH = rowHeights.reduce((a, b) => a + b, 0);

  // Header height depends on how many lines the subtitle wraps to, so it is
  // measured before the canvas is sized.
  const maxChars = Math.floor((plotW + padR) / 7.4);
  const subtitleLines: string[] = [];
  {
    let line = "";
    for (const word of d.subtitle.split(" ")) {
      if (line && `${line} ${word}`.length > maxChars) {
        subtitleLines.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) subtitleLines.push(line);
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
      legendRows[legendRows.length - 1].push({ color: s.color, name: s.name, x: lx });
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

  let max = 0;
  for (const y of d.years) {
    for (const s of d.series) max = Math.max(max, d.values.get(y)?.get(s.name) ?? 0);
  }
  const tv = ticks(max);
  const scale = (v: number): number => (v / tv[tv.length - 1]) * plotW;

  const o: string[] = [];
  o.push(
    // Concrete family names only: resvg resolves through fontconfig and
    // silently drops text when nothing matches, so CSS-generic stacks
    // (ui-sans-serif, system-ui) are not usable here.
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="DejaVu Sans, Liberation Sans, Noto Sans, sans-serif">`,
  );
  o.push(`<rect width="${w}" height="${h}" fill="${PAL.surface}"/>`);

  o.push(
    `<text x="${padL}" y="40" font-size="21" font-weight="600" fill="${PAL.textPrimary}">${esc(d.title)}</text>`,
  );
  subtitleLines.forEach((l, i) => {
    o.push(
      `<text x="${padL}" y="${63 + i * 18}" font-size="13" fill="${PAL.textSecondary}">${esc(l)}</text>`,
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
        `<rect x="${padL + e.x}" y="${ly - 9}" width="10" height="10" rx="2" fill="${e.color}"/>`,
      );
      o.push(
        `<text x="${padL + e.x + 15}" y="${ly}" font-size="12" fill="${PAL.textSecondary}">${esc(e.name)}</text>`,
      );
    }
  });

  // Vertical gridlines behind the bars.
  for (const t of tv) {
    const x = padL + scale(t);
    o.push(
      `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + plotH}" stroke="${t === 0 ? PAL.axis : PAL.grid}" stroke-width="1"/>`,
    );
    o.push(
      `<text x="${x}" y="${padT + plotH + 20}" font-size="11" fill="${PAL.textMuted}" text-anchor="middle">${compact(t)}</text>`,
    );
  }
  o.push(
    `<text x="${padL + plotW / 2}" y="${padT + plotH + 44}" font-size="12" fill="${PAL.textSecondary}" text-anchor="middle">Posts</text>`,
  );

  d.years.forEach((year, i) => {
    const top = padT + rowTops[i];
    const present = rowsPresent[i];
    // Centre the year label against the bars actually drawn. An empty year
    // still gets one slot's worth of height, so its label sits where a bar
    // would have been.
    const barsH = Math.max(present.length, 1) * (barH + barGap) - barGap;
    o.push(
      `<text x="${padL - 12}" y="${top + barsH / 2 + 4}" font-size="12" fill="${PAL.textPrimary}" text-anchor="end">${esc(year)}</text>`,
    );

    present.forEach((s, j) => {
      const v = d.values.get(year)!.get(s.name)!;
      const bw = Math.max(scale(v), 2);
      const by = top + j * (barH + barGap);
      // 4px rounded data-end, square against the zero baseline.
      const r = Math.min(4, bw);
      o.push(
        `<path d="M${padL} ${by} H${padL + bw - r} a${r} ${r} 0 0 1 ${r} ${r} V${by + barH - r} a${r} ${r} 0 0 1 -${r} ${r} H${padL} Z" fill="${s.color}"/>`,
      );
      // Label each bar with its own value rather than the row sum: a total
      // sitting beside per-source bars reads as if it were the longest bar,
      // and the axis is scaled to the largest single source, not the sum.
      o.push(
        `<text x="${padL + bw + 8}" y="${by + barH - 2}" font-size="10" fill="${PAL.textMuted}">${compact(v)}</text>`,
      );
    });
  });

  o.push("</svg>");
  return o.join("\n");
};
