import { createConfigContext } from '@optique/config';
import { z } from 'zod';

/**
 * Operational defaults, from a committed `chan.config.json`.
 *
 * The split against `.env` is deliberate and worth keeping straight:
 *
 *   .env               per-machine and secret -- NAS host, DB credentials.
 *                      Gitignored, differs between nagato and the NAS.
 *   chan.config.json   per-project and shareable -- the numbers you would
 *                      otherwise retype identically on every invocation.
 *                      Committed, so the settings travel with the repo the
 *                      same way the source manifests do.
 *
 * Nothing here is required: every key has a CLI flag and a built-in default,
 * and a missing config file is not an error. The file exists to stop
 * `--memory 8GB --tablespace fast` being typed by hand each time an index is
 * rebuilt, and to record on disk which tablespace this store's query indexes
 * are supposed to live in -- a fact that is currently only in someone's shell
 * history.
 */
export const configSchema = z.object({
  indexes: z
    .object({
      /**
       * maintenance_work_mem for the build session. Raised per-session
       * rather than globally because autovacuum_work_mem inherits the
       * global, and three autovacuum workers each claiming several GB
       * alongside an ingest is not the trade being made.
       */
      memory: z.string().optional(),
      /**
       * Tablespace the query indexes are built into. On this store that is
       * the NVMe (`fast`); the posts heap lives on the array (`slow`).
       */
      tablespace: z.string().optional(),
      /**
       * Tablespace the build's *sort* spills into, which is a different
       * disk question from where the finished index lands. Postgres puts
       * temp files in the database's default tablespace unless told
       * otherwise, and on this store that is the data-dir disk -- the
       * smallest of the three, and the one WAL is also on.
       */
      tempTablespace: z.string().optional(),
    })
    .optional(),
  runner: z
    .object({
      /**
       * Where staging commands run by default. `.env`'s NAS_HOST still
       * decides *which* host; this only chooses local vs remote when
       * neither --local nor --remote is given.
       */
      mode: z.enum(['local', 'remote']).optional(),
    })
    .optional(),
  ingest: z
    .object({
      /** Sources `ingest-all` skips unless named with --redo/--force. */
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
});

export type ChanConfig = z.infer<typeof configSchema>;

/** Default location, resolved against the project root by the caller. */
export const CONFIG_FILE = 'chan.config.json';

export const configContext = createConfigContext({ schema: configSchema });
