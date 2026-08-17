/**
 * Hand-built SVG for the board-lifespan timeline.
 *
 * Form: point events on a time axis, wrapped boustrophedon-style — the line
 * runs left to right, U-turns, and comes back. 22.8 years of board history at
 * a readable event density does not fit one straight line across 16:9.
 *
 * Encoding: position carries the category — above the line is a creation,
 * below is a removal, straddling is an April Fools batch — so identity
 * survives greyscale, print, a bad projector and colour blindness. Colour only
 * reinforces it. That is load-bearing here rather than decorative: the mark
 * colours are red against green (deutan separation dE 8.7, right on the >= 8
 * line), and they are only legal because the geometry already separates them.
 * Anything that later puts two categories on the same side of the line has to
 * re-solve the colour problem first.
 *
 * Labels wear ink, never the mark colour: the mark beside them carries the
 * identity, so the text does not have to.
 *
 * Three layout problems drove the design, each measured rather than guessed:
 *
 *  1. Event density is wildly uneven — 76 events in 2003-06, three in
 *     2022-26 — so rows are laid out at VARIABLE height, each given exactly
 *     what its own label stack needs. Uniform rows either overflow the dense
 *     ones or spend half the canvas on the empty ones.
 *
 *  2. 41% of the axis is dead air. Stretches longer than `gapMin` with no
 *     events collapse to a stub carrying a visible break mark and the duration
 *     skipped. An unmarked broken axis lies about the data; a marked one just
 *     stops wasting the page.
 *
 *  3. Same-day mass events (4chan launched eight boards on 2006-04-08) used to
 *     stack in one tall column. They now fan out HORIZONTALLY into whatever is
 *     free in each lane, every label keeping its own angled leader back to the
 *     single tick. This is what pays for readable type: it took the worst rows
 *     from ten lanes to three and the labels from 10px to 16px.
 *
 *     The trick is that the free window is measured PER LANE. Asking "how much
 *     room is there between this batch and the next event" finds nothing —
 *     in a dense stretch neighbours are 10-60px apart — but three lanes up
 *     those neighbours do not exist, which is exactly where a wide fan goes.
 */

export type Kind = 'created' | 'removed' | 'fools';

export interface TimelineEvent {
  /** Decimal year, e.g. 2003.75. */
  t: number;
  /** What to print — a board slug, or a batch summary. */
  label: string;
  kind: Kind;
}

export interface TimelineChart {
  events: TimelineEvent[];
  /** Decimal year the axis runs to; the end of the line is labelled "today". */
  now: number;
  title: string;
  subtitle: string;
  footer: string;
}

export interface TimelineOptions {
  rows: number;
  /** Largest label size to try; the layout shrinks from here until it fits. */
  fontMax: number;
  /**
   * Slide colour, used only to knock a halo out behind labels where a leader
   * would otherwise cross the text. Null renders on transparency, which is the
   * default: the chart paints no ground of its own.
   */
  bg: string | null;
  /** Quiet stretches longer than this (in years) collapse to a break mark. */
  gapMin: number;
}

const W = 1600;
const H = 900;
const PAD_L = 74;
const PAD_R = 74;
const HEADER = 104;
const FOOTER = 34;
const TICK = 9;
const LEAD = 13;
const YEAR_DROP = 15;
const BREAK_W = 0.28;
const BREAK_GAP = 7;
const LB = 8;
const RB = W - 8;
const MIN_GAP = 10;

// Yotsuba-family palette. Two validator findings are accepted deliberately and
// recorded here so they are not rediscovered as bugs:
//   - #cc1105 against #117743 is red/green: deutan separation dE 8.7, right on
//     the >= 8 line. Legal only because position and triangle direction
//     already carry created-vs-removed (see the header comment).
//   - #000080 sits at L 0.271, below the 0.43-0.77 lightness band, so it reads
//     heavier than the other two. It is parked on the April Fools mark, the
//     rarest of the three, where the imbalance shows least.
// Contrast against a light slide passes for all three.
const INK = '#800000';
const CREATED = '#117743';
const REMOVED = '#cc1105';
const FOOLS = '#000080';
const INK2_OP = 1; // secondary text stays at full strength
const INK3_OP = 0.72; // muted text
const AXIS_OP = 0.45; // the serpentine line
const RULE_OP = 0.3; // leaders and year ticks

// Concrete family names only: resvg resolves through fontconfig and silently
// drops text when nothing matches, so CSS-generic stacks (ui-sans-serif,
// system-ui) are not usable here. Inter leads because the width estimate in
// `widthOf` is calibrated against it.
const FONT = 'Inter, DejaVu Sans, Liberation Sans, Noto Sans, sans-serif';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Rendered width of a label, estimated — there is no text metrics API here. */
const widthOf = (s: string, fs: number): number => s.length * fs * 0.55 + 8;

interface Placed extends TimelineEvent {
  r: number;
  /** Where the label sits. */
  x: number;
  /** Where its event sits — the leader runs between them. */
  x0: number;
  lane: number;
  up: boolean;
}

interface Layout {
  placed: Placed[];
  above: number[];
  below: number[];
  slack: number;
  lane: number;
  fs: number;
  fits: boolean;
}

export const renderTimeline = (
  chart: TimelineChart,
  opts: TimelineOptions
): string => {
  const { rows: ROWS } = opts;
  const events = [...chart.events].sort((a, b) => a.t - b.t);
  const T0 = events[0].t;
  const T1 = chart.now;

  // ---- piecewise axis: collapse the quiet stretches to a stub
  const breaks: { from: number; to: number; v: number }[] = [];
  {
    const ts = events.map((e) => e.t);
    for (let i = 1; i < ts.length; i++) {
      if (ts[i] - ts[i - 1] > opts.gapMin) {
        breaks.push({ from: ts[i - 1], to: ts[i], v: 0 });
      }
    }
    const last = ts[ts.length - 1];
    if (T1 - last > opts.gapMin) {
      breaks.push({ from: last, to: T1, v: 0 });
    }
  }
  /** Real year -> position along the compressed axis, in "virtual years". */
  const vOf = (t: number): number => {
    let v = t - T0;
    for (const b of breaks) {
      if (t <= b.from) {
        break;
      }
      const inside = Math.min(t, b.to) - b.from;
      v -= inside;
      v += Math.min(1, inside / (b.to - b.from)) * BREAK_W;
    }
    return v;
  };
  for (const b of breaks) {
    b.v = vOf(b.from) + BREAK_W / 2;
  }
  const inBreak = (t: number): boolean =>
    breaks.some((b) => t > b.from + 1e-9 && t < b.to - 1e-9);

  const V = vOf(T1);
  const span = V / ROWS;
  const rowW = W - PAD_L - PAD_R;
  const rowOf = (t: number): number =>
    Math.min(ROWS - 1, Math.floor(vOf(t) / span));
  const xAtV = (v: number, r: number): number => {
    const f = (v - r * span) / span;
    return PAD_L + (r % 2 === 0 ? f : 1 - f) * rowW;
  };
  const xOf = (t: number, r: number): number => xAtV(vOf(t), r);

  // ---- Lay the whole chart out at one candidate font size.
  //
  // Label width and font size are circular: the packer needs widths to decide
  // how many lanes it uses, and the lane count decides how much type will fit.
  // So this does not solve it, it searches it — largest size first, keeping
  // the first that fits. Getting this wrong is not subtle: widths calibrated
  // for 11px text with the font at 16px silently overlapped every batch label.
  const layoutAt = (fs: number): Layout => {
    const lane = fs + 3;
    const placed: Placed[] = [];

    const groups = new Map<
      string,
      { r: number; up: boolean; x0: number; items: TimelineEvent[] }
    >();
    for (const e of events) {
      const r = rowOf(e.t);
      const x0 = xOf(e.t, r);
      const up = e.kind !== 'removed';
      const k = `${r}|${up}|${x0.toFixed(1)}`;
      const g = groups.get(k) ?? { r, up, x0, items: [] };
      g.items.push(e);
      groups.set(k, g);
    }

    // lanes[row][side][lane] = occupied [start, end] spans
    const lanes = Array.from({ length: ROWS }, () => ({
      a: [] as [number, number][][],
      b: [] as [number, number][][],
    }));

    // Widest batches first: they need the empty lanes most, and a small group
    // can always tuck in afterwards.
    const ordered = [...groups.values()].sort(
      (x, y) => y.items.length - x.items.length || x.x0 - y.x0
    );
    for (const g of ordered) {
      const side = g.up ? lanes[g.r].a : lanes[g.r].b;
      let rest = [...g.items];
      for (let ln = 0; rest.length; ln++) {
        if (!side[ln]) {
          side[ln] = [];
        }
        const occ = [...side[ln]].sort((p, q) => p[0] - q[0]);
        if (occ.some(([s, e2]) => g.x0 > s && g.x0 < e2)) {
          continue;
        }
        // The free window straddling this group's point, in THIS lane.
        const freeL = Math.max(
          LB,
          ...occ.filter(([, e2]) => e2 <= g.x0).map(([, e2]) => e2)
        );
        const freeR = Math.min(
          RB,
          ...occ.filter(([s]) => s >= g.x0).map(([s]) => s)
        );
        const room = freeR - freeL;
        let take = 0;
        let wSum = 0;
        while (
          take < rest.length &&
          wSum + widthOf(rest[take].label, fs) <= room
        ) {
          wSum += widthOf(rest[take].label, fs);
          take++;
        }
        if (take === 0) {
          continue;
        }
        // Centre the run on the point, then slide it inside the window.
        let start = Math.min(Math.max(g.x0 - wSum / 2, freeL), freeR - wSum);
        side[ln].push([start, start + wSum]);
        for (const e of rest.slice(0, take)) {
          const w = widthOf(e.label, fs);
          placed.push({
            ...e,
            r: g.r,
            x: start + w / 2,
            x0: g.x0,
            lane: ln,
            up: g.up,
          });
          start += w;
        }
        rest = rest.slice(take);
      }
    }

    const maxA = Array(ROWS).fill(-1);
    const maxB = Array(ROWS).fill(-1);
    for (const p of placed) {
      if (p.up) {
        maxA[p.r] = Math.max(maxA[p.r], p.lane);
      } else {
        maxB[p.r] = Math.max(maxB[p.r], p.lane);
      }
    }
    const above = maxA.map((n: number) =>
      n < 0 ? 6 : TICK + LEAD + (n + 1) * lane
    );
    const below = maxB.map((n: number) =>
      n < 0 ? YEAR_DROP + 8 : YEAR_DROP + TICK + LEAD + (n + 1) * lane
    );
    const need = above.reduce((s, v, i) => s + v + below[i], 0);
    const slack = H - HEADER - FOOTER - need;
    return {
      placed,
      above,
      below,
      slack,
      lane,
      fs,
      fits: slack >= MIN_GAP * (ROWS - 1),
    };
  };

  let L = layoutAt(opts.fontMax);
  for (let fs = opts.fontMax; fs >= 8.5 && !L.fits; fs -= 0.5) {
    L = layoutAt(fs);
  }
  const { placed, above, below, slack, lane: LANE, fs: FS } = L;
  const gap = Math.max(MIN_GAP, slack / Math.max(1, ROWS - 1));

  const lineY: number[] = [];
  {
    let cursor = HEADER;
    for (let r = 0; r < ROWS; r++) {
      cursor += above[r];
      lineY.push(cursor);
      cursor += below[r] + gap;
    }
  }

  const o: string[] = [];
  o.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="${FONT}">`
  );
  // No background rect on purpose — see TimelineOptions.bg.
  o.push(
    `<text x="${PAD_L}" y="50" font-size="29" font-weight="600" fill="${INK}">${esc(chart.title)}</text>`
  );
  o.push(
    `<text x="${PAD_L}" y="76" font-size="14" fill="${INK}" fill-opacity="${INK2_OP}">${esc(chart.subtitle)}</text>`
  );

  // Legend: identity is never colour-alone, so each mark is labelled and each
  // entry repeats the shape that actually carries the category.
  const lx = W - PAD_R - 268;
  o.push(`<g transform="translate(${lx},32)">`);
  o.push(
    `<path d="M0,-3 l5,9 h-10 z" fill="${CREATED}"/><text x="14" y="3" font-size="13" fill="${INK}" fill-opacity="${INK2_OP}">created (above the line)</text>`
  );
  o.push(
    `<path d="M0,20 l5,-9 h-10 z" fill="${REMOVED}"/><text x="14" y="22" font-size="13" fill="${INK}" fill-opacity="${INK2_OP}">removed (below)</text>`
  );
  o.push(
    `<path d="M0,34 l5,6 l-5,6 l-5,-6 z" fill="${FOOLS}"/><text x="14" y="44" font-size="13" fill="${INK}" fill-opacity="${INK2_OP}">April Fools batch, gone within days</text>`
  );
  o.push('</g>');

  // ---- the serpentine axis. The gap at each break is cut out of the PATH
  // rather than painted over: on a transparent ground there is nothing to
  // paint with, and a rect in some assumed surface colour would show as an
  // opaque chip on the slide.
  let d = '';
  for (let r = 0; r < ROWS; r++) {
    const y = lineY[r];
    const rt = PAD_L + rowW;
    const cuts = breaks
      .filter((b) => Math.min(ROWS - 1, Math.floor(b.v / span)) === r)
      .map((b) => xAtV(b.v, r))
      .sort((a, b2) => a - b2);
    let from = PAD_L;
    for (const cx of cuts) {
      if (cx - BREAK_GAP > from) {
        d += ` M${from},${y} L${(cx - BREAK_GAP).toFixed(1)},${y}`;
      }
      from = cx + BREAK_GAP;
    }
    if (rt > from) {
      d += ` M${from.toFixed(1)},${y} L${rt},${y}`;
    }
    if (r < ROWS - 1) {
      const y2 = lineY[r + 1];
      const bow = (y2 - y) * 0.55;
      d +=
        r % 2 === 0
          ? ` M${rt},${y} C${rt + bow},${y} ${rt + bow},${y2} ${rt},${y2}`
          : ` M${PAD_L},${y} C${PAD_L - bow},${y} ${PAD_L - bow},${y2} ${PAD_L},${y2}`;
    }
  }
  o.push(
    `<path d="${d}" fill="none" stroke="${INK}" stroke-opacity="${AXIS_OP}" stroke-width="2" stroke-linecap="round"/>`
  );

  // Direction cue: without it the reversed rows read as running backwards.
  for (let r = 0; r < ROWS; r++) {
    const y = lineY[r];
    const mid = PAD_L + rowW / 2;
    const fwd = r % 2 === 0;
    o.push(
      `<path d="M${fwd ? mid + 6 : mid - 6},${y} l${fwd ? -9 : 9},-5 v10 z" fill="${INK}" fill-opacity="${AXIS_OP}"/>`
    );
  }

  // Where the line begins and ends. With an even row count the last row runs
  // right-to-left, so the timeline terminates bottom-LEFT, which needs saying.
  {
    const yS = lineY[0];
    const yE = lineY[ROWS - 1];
    const endLeft = ROWS % 2 === 0;
    const endX = endLeft ? PAD_L : PAD_L + rowW;
    o.push(
      `<circle cx="${PAD_L}" cy="${yS}" r="3.5" fill="${INK}" fill-opacity="${INK3_OP}"/><circle cx="${endX}" cy="${yE}" r="3.5" fill="${INK}" fill-opacity="${INK3_OP}"/>`
    );
    o.push(
      `<text x="${PAD_L - 9}" y="${yS + 4}" font-size="11" fill="${INK}" fill-opacity="${INK3_OP}" text-anchor="end">Oct ${Math.floor(T0)}</text>`
    );
    o.push(
      `<text x="${endX + (endLeft ? -9 : 9)}" y="${yE + 4}" font-size="11" fill="${INK}" fill-opacity="${INK3_OP}" text-anchor="${endLeft ? 'end' : 'start'}">today</text>`
    );
  }

  // Year ticks, skipping any year swallowed by a break.
  const yearAnchor = (x: number): string => {
    if (x < PAD_L + 14) {
      return 'start';
    }
    if (x > PAD_L + rowW - 14) {
      return 'end';
    }
    return 'middle';
  };
  for (let y = Math.ceil(T0); y <= Math.floor(T1); y++) {
    if (inBreak(y)) {
      continue;
    }
    const r = rowOf(y);
    const x = xOf(y, r);
    const ly = lineY[r];
    o.push(
      `<line x1="${x.toFixed(1)}" y1="${ly - 4}" x2="${x.toFixed(1)}" y2="${ly + 4}" stroke="${INK}" stroke-opacity="${RULE_OP}" stroke-width="1.5"/>`
    );
    o.push(
      `<text x="${x.toFixed(1)}" y="${ly + YEAR_DROP + 4}" font-size="10.5" fill="${INK}" fill-opacity="${INK3_OP}" text-anchor="${yearAnchor(x)}">${y}</text>`
    );
  }

  // Break marks: two slashes across the gap, captioned with what was skipped.
  for (const b of breaks) {
    const r = Math.min(ROWS - 1, Math.floor(b.v / span));
    const x = xAtV(b.v, r);
    const y = lineY[r];
    const yrs = b.to - b.from;
    const label =
      yrs >= 1 ? `${yrs.toFixed(1)} yr` : `${Math.round(yrs * 12)} mo`;
    for (const dx of [-3.5, 1.5]) {
      o.push(
        `<path d="M${(x + dx).toFixed(1)},${y + 6} l4,-12" stroke="${INK}" stroke-opacity="${INK3_OP}" stroke-width="1.6" fill="none" stroke-linecap="round"/>`
      );
    }
    o.push(
      `<text x="${x.toFixed(1)}" y="${y + YEAR_DROP + 4}" font-size="10" fill="${INK}" fill-opacity="${INK3_OP}" text-anchor="middle" font-style="italic">${label}</text>`
    );
  }

  // ---- events, in three passes: leaders, then marks, then labels. A later
  // leader can then never be drawn across an earlier label.
  const geom = placed.map((p) => {
    const y = lineY[p.r];
    const dir = p.up ? -1 : 1;
    const base = p.up ? TICK + LEAD : TICK + LEAD + YEAR_DROP;
    return { p, y, dir, labelY: y + dir * (base + p.lane * LANE) };
  });
  // Leaders run to x0, not x: a batch reads as a fan from one moment.
  for (const { p, y, dir, labelY } of geom) {
    o.push(
      `<path d="M${p.x0.toFixed(1)},${(y + dir * (TICK + 1)).toFixed(1)} L${p.x.toFixed(1)},${(labelY - dir * 8).toFixed(1)}" stroke="${INK}" stroke-opacity="${RULE_OP}" stroke-width="1" fill="none"/>`
    );
  }
  // One mark per point, not per label — a batch would otherwise overdraw its
  // own tick once for every board in it.
  const drawn = new Set<string>();
  for (const { p, y, dir } of geom) {
    const k = `${p.r}|${p.x0.toFixed(1)}|${p.kind}`;
    if (drawn.has(k)) {
      continue;
    }
    drawn.add(k);
    if (p.kind === 'fools') {
      o.push(
        `<path d="M${p.x0.toFixed(1)},${y - 7} l6,7 l-6,7 l-6,-7 z" fill="${FOOLS}"/>`
      );
    } else {
      o.push(
        `<path d="M${p.x0.toFixed(1)},${(y + dir * TICK).toFixed(1)} l4.5,${(-dir * 8).toFixed(1)} h-9 z" fill="${p.kind === 'created' ? CREATED : REMOVED}"/>`
      );
    }
  }
  const halo = opts.bg
    ? ` stroke="${opts.bg}" stroke-width="3.2" paint-order="stroke" stroke-linejoin="round"`
    : '';
  for (const { p, labelY } of geom) {
    const ty = (labelY + (p.up ? 0 : 8)).toFixed(1);
    o.push(
      `<text x="${p.x.toFixed(1)}" y="${ty}" font-size="${FS}" fill="${INK}" text-anchor="middle"${halo}>${esc(p.label)}</text>`
    );
  }

  o.push(
    `<text x="${PAD_L}" y="${H - 14}" font-size="11" fill="${INK}" fill-opacity="${INK3_OP}">${esc(chart.footer)}</text>`
  );
  o.push('</svg>');
  return o.join('\n');
};
