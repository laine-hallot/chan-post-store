import { fail } from '../utils/console.ts';

/** Parse a date bound; returns epoch seconds. End bounds are advanced by one
 * unit of their precision so they can be used as an exclusive upper bound. */
export const parseBound = (s: string, end: boolean): number => {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s);
  if (!m) {
    fail(`invalid date: ${s}`);
  }
  let [year, month, day] = [
    Number(m[1]),
    m[2] ? Number(m[2]) : null,
    m[3] ? Number(m[3]) : null,
  ];
  // Date.UTC normalises rather than rejects -- month 13 is next January, day
  // 31 of April is May 1st -- so a typo would silently move the bound. A
  // valid date survives the round trip unchanged.
  const d = new Date(Date.UTC(year, (month ?? 1) - 1, day ?? 1));
  if (d.getUTCMonth() + 1 !== (month ?? 1) || d.getUTCDate() !== (day ?? 1)) {
    fail(`invalid date: ${s}`);
  }
  if (end) {
    if (day != null) {
      day++;
    } else if (month != null) {
      month++;
    } else {
      year++;
    }
  }
  return Date.UTC(year, (month ?? 1) - 1, day ?? 1) / 1000;
};

export interface FilterValues {
  phrase?: string;
  board?: string;
  site: string;
  from?: string;
  to?: string;
}

/** WHERE clauses + params shared by `count` and `search`. */
export const phraseFilters = (
  o: FilterValues
): {
  where: string;
  params: (string | number)[];
} => {
  const where: string[] = [
    // 'english' must match the config search_vector is generated with, or
    // the query stems its terms differently from the stored lexemes and
    // quietly matches nothing.
    "p.search_vector @@ phraseto_tsquery('english', $1)",
    'p.site = $2',
  ];
  const params: (string | number)[] = [o.phrase!, o.site];
  if (o.board) {
    params.push(o.board);
    where.push(`p.board = $${params.length}`);
  }
  if (o.from) {
    params.push(parseBound(o.from, false));
    where.push(`p.ts_utc >= $${params.length}`);
  }
  if (o.to) {
    params.push(parseBound(o.to, true));
    where.push(`p.ts_utc < $${params.length}`);
  }
  return { where: where.join(' AND '), params };
};
