/** Format-agnostic helpers for stream-parsing mysqldump files and for
 * normalizing Fuuka-family timestamps. */

// ---- America/New_York wall time -> UTC ----------------------------------

const nyFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  timeZoneName: 'longOffset',
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
    .find((p) => p.type === 'timeZoneName')!.value;
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzName);
  if (!m) throw new Error(`cannot parse timezone offset: ${tzName}`);
  const sign = m[1] === '-' ? -1 : 1;
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
  '0': '\0',
  n: '\n',
  r: '\r',
  t: '\t',
  Z: '\x1a',
  b: '\b',
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
  valuesAt: number
): string[] | null => {
  const between = line.slice(from, valuesAt).trim();
  if (!between.startsWith('(') || !between.endsWith(')')) return null;
  const out: string[] = [];
  const re = /`([^`]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(between)) !== null) out.push(m[1]);
  return out.length > 0 ? out : null;
};

/**
 * Split a buffer into complete `(...)` tuples plus whatever is left over.
 *
 * Needed because `mysqlchump` does NOT escape newlines inside string
 * literals: a post whose comment contains a line break is written across as
 * many physical lines, so a tuple's extent cannot be decided a line at a time.
 * Reading such a dump line-wise silently produces garbage rather than
 * failing -- a continuation line that happens to begin with "(" parses as a
 * whole tuple, and 4.2% of "rows" in a sample slice were fragments of
 * somebody's paragraph.
 *
 * Quote state is therefore tracked across the whole buffer: a tuple ends only
 * at a ")" seen outside a string literal. The caller must join lines with
 * "\n", because that newline is part of the post text.
 *
 * `rest` is UNCONSUMED TUPLE TEXT ONLY, and is empty when no tuple is open.
 * That distinction is load-bearing, not tidiness. Trailing punctuation -- the
 * ";" ending a statement -- is not a continuation, and returning it made
 * `rest` permanently non-empty, so callers that treat "buffer not empty" as
 * "still inside a statement" never came back out. Every following line got
 * appended instead, including the next table's INSERTs: reading `posts` from
 * 4archive silently swallowed the 57,674 `threads` rows and would have stored
 * them as posts (9,754,504 + 57,674 = the 9,812,178 tuples that came back).
 * An open tuple always carries its own "(", so its absence means the statement
 * closed.
 */
export const takeCompleteTuples = (
  buf: string
): { tuples: string[]; rest: string } => {
  const out: string[] = [];
  const n = buf.length;
  let i = 0;
  let consumed = 0;

  while (i < n) {
    while (i < n && buf[i] !== '(') i++;
    if (i >= n) break;
    const start = i;
    i++;
    let depth = 1;
    let closed = false;

    while (i < n) {
      const c = buf[i];
      if (c === "'") {
        i++;
        let ended = false;
        while (i < n) {
          if (buf[i] === '\\') {
            i += 2; // backslash escape, including \' and \\
            continue;
          }
          if (buf[i] === "'") {
            if (buf[i + 1] === "'") {
              i += 2; // '' is a literal quote
              continue;
            }
            i++;
            ended = true;
            break;
          }
          i++;
        }
        if (!ended) break; // literal runs past the end of what we have
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) {
        i++;
        closed = true;
        break;
      }
      i++;
    }

    if (!closed) break; // incomplete: leave it in `rest` for the next chunk
    out.push(buf.slice(start, i));
    consumed = i;
  }

  // Only hand back text that is actually an unfinished tuple. Without the
  // "(" test this returns the statement's trailing ";" forever -- see the
  // note above.
  const tail = buf.slice(consumed);
  return { tuples: out, rest: tail.includes('(') ? tail : '' };
};

export const parseTuples = function* (
  line: string,
  start: number
): Generator<(string | null)[]> {
  let i = start;
  const n = line.length;
  while (i < n) {
    while (i < n && line[i] !== '(') i++;
    if (i >= n) return;
    i++;
    const vals: (string | null)[] = [];
    for (;;) {
      // Skip whitespace before the value. mysqldump writes `,` with nothing
      // after it, but mysqlchump writes `, ` -- and without this the space
      // means the opening quote is never recognised, so a quoted value falls
      // into the bare-value branch below and any comma INSIDE the string
      // splits it into extra fields. That corrupts silently: a post whose
      // comment contains a comma yields more values than the table has
      // columns, shifting everything after it.
      while (i < n && (line[i] === ' ' || line[i] === '\t')) i++;
      if (line[i] === "'") {
        i++;
        let out = '';
        let seg = i;
        for (;;) {
          const ch = line[i];
          if (ch === undefined) throw new Error('unterminated string');
          if (ch === '\\') {
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
        while (j < n && line[j] !== ',' && line[j] !== ')') j++;
        if (j >= n) throw new Error('unterminated tuple');
        const tok = line.slice(i, j).trim();
        vals.push(tok === 'NULL' ? null : tok);
        i = j;
      }
      if (line[i] === ',') {
        i++;
      } else if (line[i] === ')') {
        i++;
        break;
      } else {
        throw new Error(`unexpected character at offset ${i}`);
      }
    }
    yield vals;
  }
};
