/** Format-agnostic helpers for stream-parsing mysqldump files and for
 * normalizing Fuuka-family timestamps. */

// ---- America/New_York wall time -> UTC ----------------------------------

const nyFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  timeZoneName: "longOffset",
});
const offsetCache = new Map<number, number>();

/** UTC offset of America/New_York at the given UTC time, in seconds
 * (negative; -14400 for EDT, -18000 for EST). Cached per hour. */
const nyOffsetAt = (utcSec: number): number => {
  const hour = Math.floor(utcSec / 3600);
  const cached = offsetCache.get(hour);
  if (cached !== undefined) return cached;
  const tzName = nyFormat
    .formatToParts(utcSec * 1000)
    .find((p) => p.type === "timeZoneName")!.value;
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzName);
  if (!m) throw new Error(`cannot parse timezone offset: ${tzName}`);
  const sign = m[1] === "-" ? -1 : 1;
  const offset = sign * (Number(m[2]) * 3600 + Number(m[3] ?? 0) * 60);
  offsetCache.set(hour, offset);
  return offset;
};

/** Interpret `wall` (epoch-encoded New York wall clock, as stored by
 * Fuuka/Asagi archivers) as true UTC. */
export const nyWallToUtc = (wall: number): number => {
  let utc = wall - nyOffsetAt(wall);
  utc = wall - nyOffsetAt(utc);
  return utc;
};

// ---- mysqldump INSERT tuple parsing -------------------------------------

const ESCAPES: Record<string, string> = {
  "0": "\0",
  n: "\n",
  r: "\r",
  t: "\t",
  Z: "\x1a",
  b: "\b",
};

/**
 * Matches a CREATE TABLE header, with or without IF NOT EXISTS.
 *
 * mysqldump writes `CREATE TABLE \`t\` (`, but dumps produced by other tools
 * do not: the 2019 desuarchive/RBT dumps (made with `mysqlchump`) write
 * `CREATE TABLE IF NOT EXISTS \`g\` (`. A pattern anchored on the plain form
 * simply never registers those tables, and since a table that was never
 * registered cannot be accepted, the adapter reports zero tables and zero
 * posts and exits 0 -- indistinguishable from a dump that held nothing.
 */
export const CREATE_TABLE_RE = /^CREATE TABLE (?:IF NOT EXISTS )?`([^`]+)` \($/;

/**
 * The column names listed in an INSERT statement, or null when it has none.
 *
 * `INSERT INTO \`t\` VALUES (...)` carries no list, and tuple order is then
 * the CREATE TABLE order -- which is what every warosu and Asagi dump in this
 * registry does. But `mysqlchump` emits
 * `INSERT INTO \`g\` (\`num\`, \`subnum\`, ...) VALUES (...)` and OMITS
 * columns: the desuarchive dumps declare doc_id, media_id and poster_ip in the
 * CREATE TABLE and then never insert them. Where such a list exists it, not
 * the CREATE TABLE, defines tuple order, and reading positions from the table
 * definition instead shifts every field by however many columns were dropped.
 *
 * `from` is the index just past the table name's closing backtick; `valuesAt`
 * is the index of the " VALUES " that follows.
 */
export const insertColumns = (
  line: string,
  from: number,
  valuesAt: number,
): string[] | null => {
  const between = line.slice(from, valuesAt).trim();
  if (!between.startsWith("(") || !between.endsWith(")")) return null;
  const out: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(between)) !== null) out.push(m[1]);
  return out.length > 0 ? out : null;
};

export const parseTuples = function* (
  line: string,
  start: number,
): Generator<(string | null)[]> {
  let i = start;
  const n = line.length;
  while (i < n) {
    while (i < n && line[i] !== "(") i++;
    if (i >= n) return;
    i++;
    const vals: (string | null)[] = [];
    for (;;) {
      if (line[i] === "'") {
        i++;
        let out = "";
        let seg = i;
        for (;;) {
          const ch = line[i];
          if (ch === undefined) throw new Error("unterminated string");
          if (ch === "\\") {
            const esc = line[i + 1];
            out += line.slice(seg, i) + (ESCAPES[esc] ?? esc);
            i += 2;
            seg = i;
          } else if (ch === "'") {
            out += line.slice(seg, i);
            if (line[i + 1] === "'") {
              out += "'";
              i += 2;
              seg = i;
            } else {
              i++;
              break;
            }
          } else {
            i++;
          }
        }
        vals.push(out);
      } else {
        let j = i;
        while (j < n && line[j] !== "," && line[j] !== ")") j++;
        if (j >= n) throw new Error("unterminated tuple");
        const tok = line.slice(i, j);
        vals.push(tok === "NULL" ? null : tok);
        i = j;
      }
      if (line[i] === ",") {
        i++;
      } else if (line[i] === ")") {
        i++;
        break;
      } else {
        throw new Error(`unexpected character at offset ${i}`);
      }
    }
    yield vals;
  }
};
