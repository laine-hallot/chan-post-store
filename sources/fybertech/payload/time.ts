// Part of a prepare payload: this file is uploaded to whichever machine holds
// the archives and run there. It may import only `node:` builtins and its own
// siblings -- nothing from this repo is resolvable at that point, which is why
// the helpers below are copies rather than imports.
//
// Node strips the types at load; no build step, so no syntax that emits code.

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
  if (cached !== undefined) {
    return cached;
  }
  const tzName = nyFormat
    .formatToParts(utcSec * 1000)
    .find((p) => p.type === 'timeZoneName')!.value;
  const m = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(tzName);
  if (!m) {
    throw new Error(`cannot parse timezone offset: ${tzName}`);
  }
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
