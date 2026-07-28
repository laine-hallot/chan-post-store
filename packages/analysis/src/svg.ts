/**
 * Hand-built SVG for the corpus-coverage chart.
 *
 * Horizontal grouped bars: one row per year, one bar per source. Not the
 * mirrored population-pyramid layout, because that form encodes two mutually
 * exclusive halves — archives overlap in time and can hold the same post, so
 * mirroring would imply an exclusivity the data doesn't have.
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
function ticks(max: number, count = 5): number[] {
  if (max <= 0) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = 0; v < max - step * 1e-9; v += step) out.push(v);
  out.push(out.length ? out[out.length - 1] + step : step);
  return out;
}

function compact(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k`;
  return String(n);
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderChart(d: ChartData): string {
  // Bars are sized first and the row derived from them, so a bar is always a
  // bar rather than a hairline however many series there are.
  const barH = 13;
  const barGap = 2; // 2px surface gap between adjacent fills
  const groupGap = 14; // space between one year and the next
  const rowH = d.series.length * (barH + barGap) - barGap + groupGap;
  const padL = 300;
  const padR = 110;
  const padB = 64;
  const plotW = 860;
  const plotH = d.years.length * rowH;

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
  // Room for the header, plus a legend row only when there is a legend.
  const padT = 63 + subtitleLines.length * 18 + (d.series.length > 1 ? 46 : 20);
  const w = padL + plotW + padR;
  const h = padT + plotH + padB;

  let max = 0;
  for (const y of d.years) {
    for (const s of d.series) max = Math.max(max, d.values.get(y)?.get(s.name) ?? 0);
  }
  const tv = ticks(max);
  const scale = (v: number) => (v / tv[tv.length - 1]) * plotW;

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
  // Advance by an estimate of rendered width — DejaVu Sans at 12px averages
  // ~6.9px/char — since there is no text metrics API here. A single series
  // needs no legend: the title already names it.
  if (d.series.length > 1) {
    let lx = padL;
    for (const s of d.series) {
      o.push(`<rect x="${lx}" y="${padT - 32}" width="10" height="10" rx="2" fill="${s.color}"/>`);
      o.push(
        `<text x="${lx + 15}" y="${padT - 23}" font-size="12" fill="${PAL.textSecondary}">${esc(s.name)}</text>`,
      );
      lx += 15 + s.name.length * 6.9 + 28;
    }
  }

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
    const top = padT + i * rowH;
    const barsH = d.series.length * (barH + barGap) - barGap;
    // Centre the year label against the bar group, not the padded row.
    o.push(
      `<text x="${padL - 12}" y="${top + barsH / 2 + 4}" font-size="12" fill="${PAL.textPrimary}" text-anchor="end">${esc(year)}</text>`,
    );

    d.series.forEach((s, j) => {
      const v = d.values.get(year)?.get(s.name) ?? 0;
      if (v <= 0) return;
      const bw = Math.max(scale(v), 2);
      const by = top + j * (barH + barGap);
      // 4px rounded data-end, square against the zero baseline.
      const r = Math.min(4, bw);
      o.push(
        `<path d="M${padL} ${by} H${padL + bw - r} a${r} ${r} 0 0 1 ${r} ${r} V${by + barH - r} a${r} ${r} 0 0 1 -${r} ${r} H${padL} Z" fill="${s.color}"/>`,
      );
    });

    // Label each bar with its own value rather than the row sum: a total
    // sitting beside per-source bars reads as if it were the longest bar,
    // and the axis is scaled to the largest single source, not the sum.
    d.series.forEach((s, j) => {
      const v = d.values.get(year)?.get(s.name) ?? 0;
      if (v <= 0) return;
      const by = top + j * (barH + barGap);
      o.push(
        `<text x="${padL + Math.max(scale(v), 2) + 8}" y="${by + barH - 2}" font-size="10" fill="${PAL.textMuted}">${compact(v)}</text>`,
      );
    });
  });

  o.push("</svg>");
  return o.join("\n");
}
