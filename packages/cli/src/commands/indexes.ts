import type { InferValue } from '@optique/core/parser';

import { log } from '@clack/prompts';
import { bindConfig } from '@optique/config';
import { merge, object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { multiple, optional, withDefault } from '@optique/core/modifiers';
import {
  argument,
  command,
  constant,
  flag,
  option,
} from '@optique/core/primitives';
import { choice, string } from '@optique/core/valueparser';

import { configContext } from '../config.ts';
import { openDb, queryIndexStatus, QUERY_INDEXES } from '../database/db.ts';
import { humanBytes } from '../downloaders/archive-org.ts';
import { connectionString, dbOptions } from '../env.ts';
import { makeBar } from '../progress.ts';
import { printTable } from '../table.ts';
import { fail } from '../utils/console.ts';

export const indexesCmd = command(
  'indexes',
  merge(
    object({
      action: constant('indexes' as const),
      subcommand: argument(choice(['build', 'drop', 'status'] as const)),
      memory: bindConfig(
        withDefault(
          option('--memory', string(), {
            description: message`maintenance_work_mem for the build session.`,
          }),
          '4GB'
        ),
        {
          context: configContext,
          key: (c) => c.indexes?.memory ?? '4GB',
          default: '4GB',
        }
      ),
      tablespace: bindConfig(
        optional(
          option('--tablespace', string(), {
            description: message`Tablespace to build into. On this store the query indexes belong on the NVMe; the posts heap stays on the array.`,
          })
        ),
        {
          context: configContext,
          key: (c) => c.indexes?.tablespace,
          // Explicitly defaulted: bindConfig without a default REQUIRES a
          // value, so with no config file and no --tablespace, `indexes
          // status` failed outright rather than falling back to the
          // database default tablespace.
          default: undefined,
        }
      ),
      tempTablespace: bindConfig(
        optional(
          option('--temp-tablespace', string(), {
            description: message`Tablespace for the build's sort spill. Postgres writes temp files to the database's default tablespace, which here is the data-dir disk -- the smallest of the three, and the one WAL shares. A parallel build sorts every index entry through it.`,
          })
        ),
        {
          context: configContext,
          key: (c) => c.indexes?.tempTablespace,
          default: undefined,
        }
      ),
      only: multiple(
        option('--only', string(), {
          description: message`Build just this index. Repeatable. The GIN full-text index is the bulk of the total and scales with text volume rather than row count, so building the cheap btrees first tells you what space is left before the expensive one commits to it.`,
        })
      ),
    }),
    dbOptions
  ),
  {
    description: message`Build, drop or report the query-time indexes on posts. These are NOT created on connect: ingest needs only the UNIQUE constraint, and maintaining the rest per-insert costs far more than sorting them once at the end -- on the last full pass, GIN pending-list merges alone were 99.4% of all index blocks read from disk. A bulk load is therefore: indexes drop, ingest-all, indexes build.`,
  }
);

export type IndexesArgs = InferValue<typeof indexesCmd>;

/**
 * A SQL identifier, double-quoted with embedded quotes doubled.
 *
 * `SET default_tablespace` takes an identifier, not a value, so it cannot be
 * a bound parameter -- the name has to go into the statement text. Quoting it
 * here rather than interpolating raw keeps a tablespace name off the command
 * line and straight into SQL.
 */
const quoteIdent = (s: string): string => `"${s.replace(/"/g, '""')}"`;

/**
 * A SQL string literal, single-quoted with embedded quotes doubled.
 *
 * `temp_tablespaces` is a list GUC rather than an identifier one, so it takes
 * a literal -- the documented spelling is `SET temp_tablespaces = 'a, b'`.
 */
export const quoteLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Elapsed since `t0`, as a human duration. Index builds run into hours. */
export const fmtSecs = (t0: number): string => {
  const s = (Date.now() - t0) / 1000;
  if (s < 90) {
    return `${s.toFixed(1)}s`;
  }
  if (s < 5400) {
    return `${(s / 60).toFixed(1)}m`;
  }
  return `${(s / 3600).toFixed(2)}h`;
};

/**
 * Build, drop, or report the query-time indexes on `posts`.
 *
 * These are not part of the connect-time schema, so they have to be managed
 * on purpose. The cycle for a bulk load is `indexes drop`, ingest, `indexes
 * build`: maintaining them per-insert costs far more than sorting them once
 * at the end, and on the current corpus they are ~72GB of write amplification
 * that ingest gets nothing from.
 */
export const execIndexes = async (o: IndexesArgs): Promise<void> => {
  const action = o.subcommand;
  if (!connectionString(o)) {
    fail('indexes requires --db');
  }

  const db = await openDb(connectionString(o));
  try {
    const before = await queryIndexStatus(db);

    if (action === 'status') {
      printTable(
        ['index', 'present', 'size'],
        before.map((i) => [
          i.name,
          i.exists ? 'yes' : 'no',
          i.exists ? humanBytes(i.bytes) : '-',
        ])
      );
      return;
    }

    if (action === 'drop') {
      const present = before.filter((i) => i.exists);
      if (!present.length) {
        console.log('no query indexes present — nothing to drop');
        return;
      }
      for (const i of present) {
        const t0 = Date.now();
        await db.query(`DROP INDEX IF EXISTS ${i.name}`);
        log.success(
          `dropped ${i.name} (${humanBytes(i.bytes)}) in ${fmtSecs(t0)}`
        );
      }
      console.log(
        `freed ${humanBytes(present.reduce((n, i) => n + i.bytes, 0))}`
      );
      return;
    }

    // build. maintenance_work_mem is set per session rather than cluster-wide
    // because autovacuum_work_mem inherits the global, and three autovacuum
    // workers each holding several GB alongside an ingest is not the trade
    // being made here.
    const memory = o.memory ?? '4GB';
    // Which disk the indexes land on. Set as default_tablespace on the build
    // session rather than written into QUERY_INDEXES, for the same reason
    // maintenance_work_mem is: it is a property of this machine's disks, not
    // of the schema, and hardcoding it would make the DDL untrue anywhere
    // else. It also keeps drop/status working unchanged -- they match on
    // index name, which does not depend on location.
    const { tablespace } = o;
    // Where the build's *sort* spills, which is not the same disk question as
    // where the finished index lands. Postgres writes temp files to the
    // database's default tablespace, and here that is the data-dir disk --
    // the smallest of the three, and the one WAL is also on. Since PG18
    // builds GIN indexes in parallel, every index entry now goes through a
    // tuplesort on the way in, so the spill scales with lexemes rather than
    // rows: filling that disk would take WAL down with it.
    const { tempTablespace } = o;
    // Build a subset. The GIN full-text index is the bulk of the total and
    // scales with text volume rather than row count, so its size is the least
    // predictable; building the cheap btrees first tells you what is left
    // before the expensive one commits to it.
    const { only } = o;
    let missing = before.filter((i) => !i.exists);
    if (only?.length) {
      const known = new Set(QUERY_INDEXES.map((q) => q.name));
      for (const n of only) {
        if (!known.has(n)) {
          fail(
            `unknown index ${n}; --only takes one of: ` +
              QUERY_INDEXES.map((q) => q.name).join(', ')
          );
        }
      }
      missing = missing.filter((i) => only.includes(i.name));
    }
    if (!missing.length) {
      console.log('all query indexes already present — nothing to build');
      return;
    }
    console.log(
      `building ${missing.length} index(es) with maintenance_work_mem=${memory}` +
        (tablespace ? ` in tablespace ${tablespace}` : '') +
        (tempTablespace ? `, sorting in ${tempTablespace}` : '') +
        `\n  each takes an ACCESS EXCLUSIVE lock on posts; queries against it will block`
    );
    for (const i of missing) {
      const spec = QUERY_INDEXES.find((q) => q.name === i.name);
      if (!spec) {
        continue;
      }
      const bar = makeBar({});
      bar.start(`${i.name}`);
      const t0 = Date.now();
      // A dedicated client: SET is per-session, and a pooled query could
      // otherwise land on a connection that never saw it.
      const client = await db.connect();
      try {
        await client.query(`SET maintenance_work_mem = '${memory}'`);
        if (tablespace) {
          // Identifier, so it cannot be parameterized; quote it instead.
          await client.query(
            `SET default_tablespace = ${quoteIdent(tablespace)}`
          );
        }
        if (tempTablespace) {
          // A comma-separated *list* GUC, not an identifier one, so it takes
          // a string literal -- quoteIdent's double quotes would be read as
          // part of the name.
          await client.query(
            `SET temp_tablespaces = ${quoteLiteral(tempTablespace)}`
          );
        }
        await client.query(spec.sql);
      } finally {
        client.release();
      }
      bar.stop(`${i.name} built in ${fmtSecs(t0)}`);
    }

    const after = await queryIndexStatus(db);
    printTable(
      ['index', 'size'],
      after.filter((i) => i.exists).map((i) => [i.name, humanBytes(i.bytes)])
    );
  } finally {
    await db.end();
  }
};
