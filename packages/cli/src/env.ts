import { object } from '@optique/core/constructs';
import { message } from '@optique/core/message';
import { option } from '@optique/core/primitives';
import { integer, string } from '@optique/core/valueparser';
import { bindEnv, createEnvContext } from '@optique/env';
import { join } from 'node:path';

import { PROJECT_ROOT } from './paths.ts';

/**
 * Environment plumbing: the `.env` layer and the Postgres connection.
 *
 * Replaces a hand-rolled `KEY=value` reader that documented itself as "no
 * export/quotes handling beyond trimming". This `.env` in particular mixes
 * quoting styles -- NAS_ROOT is single-quoted, NAS_MNT_BASE double-quoted --
 * which the old reader handled by stripping quote characters off both ends
 * with a regex, and which Optique handles properly.
 *
 * ONE BEHAVIOUR CHANGE: Optique expands `$VAR` and `${VAR}` inside unquoted
 * and double-quoted values. Nothing in this `.env` contains a `$`, so today
 * it makes no difference, but a secret containing one must now be
 * single-quoted to be taken literally.
 *
 * `$(...)` command substitution is recognised but never executed: Optique
 * requires an explicit `substitute` hook, and this context does not install
 * one, so such a value fails loudly rather than running a subshell.
 */
export const envContext = createEnvContext({
  // No prefix: the keys in this .env are already project-specific
  // (NAS_HOST, DB_HOST) rather than namespaced.
  prefix: '',
  // Absolute, via PROJECT_ROOT, rather than Optique's cwd-relative default:
  // `packages/analysis` runs its own tools with cwd set there (`npm run
  // coverage`), and a cwd-relative `.env` is simply not found from
  // anywhere but the repo root -- silently, since a missing .env file is
  // skipped rather than reported.
  envFile: join(PROJECT_ROOT, '.env'),
});

/**
 * The Postgres connection, as CLI options that each fall back to `.env`.
 *
 * `--db` stays as a whole connection string because that is what every
 * invocation in the project's history passes. It falls back to DATABASE_URL,
 * which is the spelling `packages/analysis` already used, and when neither is
 * present the URL is composed from the DB_* parts.
 *
 * THE PASSWORD IN `.env` IS URL-ENCODED, and must be spliced in as-is.
 * Verified against the live server: the stored value ends `%40BA9gCkAhvh`,
 * the real password ends `@BA9gCkAhvh`, and of the three candidate
 * treatments only two authenticate --
 *
 *   discrete pg field, raw value      -> password authentication failed
 *   discrete pg field, decoded value  -> OK
 *   URL with the raw value spliced in -> OK
 *
 * -- so `encodeURIComponent` here would turn `%40` into `%2540` and break
 * auth. A password added later must likewise be percent-encoded in `.env`.
 */
export const dbOptions = object({
  db: bindEnv(
    option('--db', string(), {
      description: message`Whole connection string. Wins outright over the parts below. Falls back to DATABASE_URL, then to composing DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_DATABASE from .env -- so with a populated .env this need not be passed at all.`,
    }),
    {
      context: envContext,
      key: 'DATABASE_URL',
      parser: string(),
      default: '',
    }
  ),
  dbHost: bindEnv(
    option('--db-host', string(), {
      description: message`Postgres host. Defaults to DB_HOST, then localhost.`,
    }),
    {
      context: envContext,
      key: 'DB_HOST',
      parser: string(),
      default: 'localhost',
    }
  ),
  dbPort: bindEnv(
    option('--db-port', integer(), {
      description: message`Postgres port. Defaults to DB_PORT, then 5432.`,
    }),
    {
      context: envContext,
      key: 'DB_PORT',
      parser: integer(),
      default: 5432,
    }
  ),
  dbUser: bindEnv(
    option('--db-user', string(), {
      description: message`Role to connect as. Defaults to DB_USER.`,
    }),
    {
      context: envContext,
      key: 'DB_USER',
      parser: string(),
      default: '',
    }
  ),
  dbPassword: bindEnv(
    option('--db-password', string(), {
      description: message`Password, PERCENT-ENCODED: it is spliced into a URL unchanged, so an @ must be written %40. Defaults to DB_PASSWORD.`,
    }),
    {
      context: envContext,
      key: 'DB_PASSWORD',
      parser: string(),
      default: '',
    }
  ),
  dbName: bindEnv(
    option('--db-name', string(), {
      description: message`Database name. Defaults to DB_DATABASE.`,
    }),
    {
      context: envContext,
      key: 'DB_DATABASE',
      parser: string(),
      default: '',
    }
  ),
});

export interface DbOptions {
  db: string;
  dbHost: string;
  dbPort: number;
  dbUser: string;
  dbPassword: string;
  dbName: string;
}

/**
 * The connection string to hand `openDb`.
 *
 * An explicit `--db` wins outright; otherwise the parts are assembled. Note
 * the deliberate absence of any encoding step on the password -- see above.
 */
export const connectionString = (o: DbOptions): string => {
  if (o.db) return o.db;
  if (!o.dbUser || !o.dbName) {
    throw new Error(
      'no database connection configured\n' +
        '  pass --db <postgres://...>, or set DB_HOST/DB_PORT/DB_USER/' +
        'DB_PASSWORD/DB_DATABASE in .env\n' +
        '  (DB_PASSWORD must be percent-encoded: @ is %40)'
    );
  }
  const auth = o.dbPassword ? `${o.dbUser}:${o.dbPassword}` : o.dbUser;
  return `postgres://${auth}@${o.dbHost}:${o.dbPort}/${o.dbName}`;
};

/** The same string with the password blanked, for logs and error messages. */
export const redactConnection = (conn: string): string =>
  conn.replace(/(:\/\/[^:/@]+:)[^@]*@/, '$1***@');
