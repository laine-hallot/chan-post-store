/**
 * Stages mysqldump SQL into the standard `out/<board>.sql` layout.
 *
 * The standard format is one Asagi post table per file, named for its board.
 * Getting there is a text edit, not a parse, because of one property of these
 * dumps: **they carry no INSERT column list**, so tuple order follows
 * `CREATE TABLE`. Renaming a column in the table header therefore remaps every
 * field of every row without touching a single data row -- 275GB of INSERTs
 * are copied through byte for byte.
 *
 * Three jobs, one pass:
 *
 *   1. **Split by board.** A dump may hold many boards (laza ships every board
 *      in one 21GB `tables.sql`; rbt-asia's 4klaani dailies hold seven). The
 *      standard layout is one board per file so that a future board filter can
 *      emit a subset by simply not writing the other files.
 *   2. **Keep only post tables**, decided by the columns a table declares --
 *      the same test adapters/sql.ts applies. That drops the Asagi side tables
 *      (`_daily`, `_images`, `_threads`, `_users`, `index_counters`) and also
 *      a dump's own administrative tables, which no name-based rule would have
 *      anticipated: installgentoo ships `banlist`, `modlog`, `reports`,
 *      `staff` and `loginattempts` alongside its three boards, and a first
 *      version of this step duly wrote five bogus board files. What is dropped
 *      is reported, never silent. `<board>_deleted` is NOT a side table -- it
 *      holds that board's deleted posts and is routed to the board's file.
 *   3. **Rename columns**, for original-Fuuka dumps only (`rename: 'fuuka'`).
 *
 * The Fuuka -> Asagi renames, and why they are a 2-cycle rather than one edit:
 *
 * | original Fuuka  | holds                        | Asagi name       |
 * | --------------- | ---------------------------- | ---------------- |
 * | `parent`        | thread pointer, 0 for an OP  | `thread_num`     |
 * | `media`         | the poster's own filename    | `media_filename` |
 * | `media_filename`| the server's timestamp name  | `media_orig`     |
 *
 * Both schemas have a `media_filename`; they just disagree about what it
 * means. Renaming `media` onto it without first moving the incumbent out to
 * `media_orig` would produce two columns of the same name -- so the order of
 * the two substitutions is load-bearing, and `media_filename` must move first.
 *
 * `parent` is renamed but its VALUES are not rewritten: Fuuka stores 0 in it
 * for an OP where Asagi stores the OP's own number. The reader normalises
 * `0 -> num` already, which is what makes a header-only edit sufficient. See
 * adapters/sql.ts.
 *
 * Two constraints on the substitution, each of which silently corrupts data if
 * dropped:
 *
 *   - **It is confined to the CREATE TABLE block.** A post body containing the
 *     literal text `` `parent` `` would otherwise be rewritten.
 *   - **It must not run on Asagi dumps** (`rename: 'none'`). Asagi already has
 *     both `media_filename` and `media_orig`, so applying the cycle to one
 *     would collide them.
 *
 * awk splits records on `\n` and nothing else, which is what makes this safe
 * on bodies containing U+2028, U+2029 or a lone `\r` -- the characters that
 * made Node's readline cut INSERT statements in half. It also means a dump
 * whose strings carry genuine unescaped newlines (mysqlchump's do) must NOT
 * be routed through here; those sources are already one board per file and
 * need no staging beyond a copy.
 *
 * Still awk rather than JavaScript: it is a streaming text rewrite over
 * hundreds of gigabytes, awk is already on the archive host, and the output
 * was verified byte-identical against the readers this replaced. The prepare
 * script that calls this is itself running on that host, so this is a local
 * child process, not a remote command.
 */

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Column renames applied inside CREATE TABLE blocks. */
export type SqlRename = 'fuuka' | 'none';

export interface SqlNormalizeOptions {
  /** Directory of input `.sql` files. */
  from: string;
  /** Directory to build `<board>.sql` into; rebuilt from scratch. */
  to: string;
  /**
   * Which schema the inputs are in. Required, and deliberately not defaulted:
   * applying the Fuuka rename to an Asagi dump collides `media_filename` with
   * the `media_orig` it already has, and skipping it on a Fuuka dump leaves
   * `parent` unread. Either way the result is wrong and silent.
   */
  rename: SqlRename;
}

export interface SqlNormalizeStats {
  /** Board files written. */
  boards: number;
  /** Input files read. */
  files: number;
}

export const buildSqlNormalizeAwk = (rename: SqlRename): string => {
  // Applied only inside a CREATE TABLE block. media_filename moves out to
  // media_orig BEFORE media takes its name, or the two collide.
  const renames =
    rename === 'fuuka'
      ? [
          '    gsub(/`media_filename`/, "`media_orig`", line)',
          '    gsub(/`media`/, "`media_filename`", line)',
          '    gsub(/`parent`/, "`thread_num`", line)',
        ].join('\n')
      : '    # no renames: this source is already Asagi';

  return `# generated by prepare-steps/sql-normalize.ts -- do not edit in place
function tablename(s,   t) {
  t = s
  sub(/^[^\`]*\`/, "", t)
  sub(/\`.*$/, "", t)
  return t
}
# A table is a board's posts iff its CREATE TABLE declares the post columns --
# the same test adapters/sql.ts applies before accepting one. Deciding by
# columns rather than by name is what keeps the layout honest: it drops the
# Asagi side tables (_daily/_images/_threads/_users) and a dump's own
# administrative tables (installgentoo ships banlist, modlog, reports, staff
# and loginattempts) without needing to know any of their names.
/^CREATE TABLE/ {
  tbl = tablename($0)
  board = tbl
  sub(/_deleted$/, "", board)   # a board's deleted posts are that board's
  nbuf = 1
  buf[1] = $0
  delete cols
  increate = 1
  next
}
increate {
  line = $0
${renames}
  buf[++nbuf] = line
  # Column definitions start with the backtick; KEY/UNIQUE KEY/PRIMARY KEY
  # lines do not, so an index over a column is not mistaken for the column.
  if (match(line, /^[ \\t]*\`[^\`]+\`/)) {
    name = substr(line, RSTART, RLENGTH)
    gsub(/[ \\t\`]/, "", name)
    cols[name] = 1
  }
  if ($0 ~ /^\\)/) {
    increate = 0
    if (("num" in cols) && ("subnum" in cols) && ("thread_num" in cols) &&
        ("timestamp" in cols) && ("comment" in cols)) {
      boardof[tbl] = board
      # Append, not truncate: a board's tables need not be contiguous in the
      # dump -- laza writes \`a\` and \`a_deleted\` either side of \`a_daily\`.
      out = DEST "/" board ".sql"
      keep = 1
      for (i = 1; i <= nbuf; i++) print buf[i] >> out
    } else {
      skipped[tbl] = 1
      keep = 0
      out = ""
    }
  }
  next
}
/^INSERT INTO \`/ {
  tbl = tablename($0)
  if (tbl in boardof) {
    keep = 1
    out = DEST "/" boardof[tbl] ".sql"
    print >> out
  } else {
    keep = 0
    out = ""
  }
  next
}
# Anything else -- dump headers, SET statements, and any continuation line --
# follows the statement it belongs to rather than being dropped on the floor.
{ if (keep && out != "") print >> out }
# Report what was dropped. A filter that discards silently is the same failure
# mode as a parser that returns zero.
END {
  n = 0
  for (t in skipped) { n++; list = list (n > 1 ? ", " : "") t }
  if (n > 0) print "    dropped " n " non-post table(s): " list > "/dev/stderr"
}
`;
};

export const sqlNormalize = (opts: SqlNormalizeOptions): SqlNormalizeStats => {
  const inputs = readdirSync(opts.from)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort();
  if (inputs.length === 0) {
    // A silent zero here looks exactly like a source with nothing to stage,
    // which is the failure mode this codebase keeps being bitten by.
    throw new Error(`no .sql files in ${opts.from}`);
  }

  // Rebuilt rather than added to: the program appends, so a re-run over a
  // populated directory would double every board's rows.
  rmSync(opts.to, { recursive: true, force: true });
  mkdirSync(opts.to, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'sql-normalize-'));
  try {
    const program = join(tmp, 'normalize.awk');
    writeFileSync(program, buildSqlNormalizeAwk(opts.rename));
    for (const f of inputs) {
      console.log(`  ${f}`);
      execFileSync(
        'awk',
        ['-v', `DEST=${opts.to}`, '-f', program, join(opts.from, f)],
        { stdio: ['ignore', 'inherit', 'inherit'] }
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const boards = readdirSync(opts.to).length;
  if (boards === 0) {
    throw new Error(
      `wrote no board files to ${opts.to}\n` +
        `  the inputs matched no CREATE TABLE with post columns`
    );
  }
  return { boards, files: inputs.length };
};
