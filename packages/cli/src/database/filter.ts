import { fail } from '../utils/console.ts';

/** Parse a date bound; returns epoch seconds. End bounds are advanced by one
 * unit of their precision so they can be used as an exclusive upper bound. */
const parseBound = (s: string, end: boolean): number => {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(s);
  if (!m) {
    fail(`invalid date: ${s}`);
  }
  let [year, month, day] = [
    Number(m[1]),
    m[2] ? Number(m[2]) : null,
    m[3] ? Number(m[3]) : null,
  ];
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
    "p.search_vector @@ phraseto_tsquery('simple', $1)",
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
