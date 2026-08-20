/**
 * Fixed-width table rendering for terminal output.
 *
 * Lives apart from `cli.ts` because `survey` needs it too, and a second copy
 * would drift: the numeric-column rule below is the sort of detail that gets
 * re-derived slightly differently the second time.
 */

export const printTable = (
  headers: string[],
  rows: (string | number | null)[][],
  footer?: (string | number | null)[]
): void => {
  const bodyAndFoot = footer ? [...rows, footer] : rows;
  const numeric = headers.map((_, i) =>
    rows.every((r) => r[i] == null || typeof r[i] === 'number')
  );
  const fmt = (v: string | number | null): string => {
    if (v == null) {
      return '-';
    }
    return typeof v === 'number' ? v.toLocaleString('en-US') : v;
  };
  const cells = bodyAndFoot.map((r) => r.map(fmt));
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((r) => r[i].length))
  );
  const line = (row: string[]): string =>
    row
      .map((c, i) => (numeric[i] ? c.padStart(widths[i]) : c.padEnd(widths[i])))
      .join('  ')
      .trimEnd();
  const rule = line(widths.map((w) => '-'.repeat(w)));
  console.log(line(headers));
  console.log(rule);
  for (const r of cells.slice(0, rows.length)) {
    console.log(line(r));
  }
  if (footer) {
    console.log(rule);
    console.log(line(cells[rows.length]));
  }
};

// How each column of the totals row is derived from the body rows. "sum"
// adds the values, "min"/"max" span dates, "label" holds the "TOTAL" tag,
// and "blank" leaves free-text columns (e.g. a source link) empty.
export type TotalRule = 'sum' | 'min' | 'max' | 'label' | 'blank';

export const totalsRow = (
  rules: TotalRule[],
  rows: (string | number | null)[][]
): (string | number | null)[] => {
  return rules.map((rule, i) => {
    switch (rule) {
      case 'label':
        return 'TOTAL';
      case 'blank':
        return null;
      case 'sum':
        return rows.reduce((acc, r) => acc + (Number(r[i]) || 0), 0);
      case 'min':
      case 'max': {
        const vals = rows
          .map((r) => r[i])
          .filter((v): v is string => v != null);
        if (vals.length === 0) {
          return null;
        }
        return rule === 'min'
          ? vals.reduce((a, b) => (a < b ? a : b))
          : vals.reduce((a, b) => (a > b ? a : b));
      }
    }
  });
};
