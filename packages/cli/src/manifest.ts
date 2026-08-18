import type {
  SqlNormalizeStep,
  SqlRename,
} from './prepare-steps/sql-normalize.ts';
import type { StageHtmlStep } from './prepare-steps/stage-html.ts';

import { Result } from '@badrap/result';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { SOURCES_DIR } from './paths.ts';

export const ADAPTERS = [
  'json-api',
  'sql',
  'posts-threads-sql',
  'html',
  'fybertech-html',
] as const;
export type Adapter = (typeof ADAPTERS)[number];

export interface Manifest {
  /** Manifest filename without .json; how the source is named on the CLI. */
  id: string;
  /** Path the manifest was read from, for error messages. */
  file: string;
  name: string;
  link?: string;
  adapter: Adapter;
  /** Ingest input, relative to the project root. Absolute once resolved. */
  path: string;
  site: string;
  /**
   * Boards to drop on ingest — the archive's own boards, other imageboards
   * it swept up, and non-board parse artifacts. Applied by the adapter, not
   * centrally; see boards.ts.
   */
  excludeBoards: string[];
  /** Download staging dir, project-root relative (files.source). */
  stageDir?: string;
}

/**
 * Configuration for the `reconcile-boards` builtin.
 *
 * Paths are relative, as everywhere else in a manifest: `root` to the dataset
 * dir, `boardsFrom` to the project root.
 */
export interface ReconcileBoardsStep {
  /** Tree of `<board>/<threadno>.html` directories, e.g. `out/4chan`. */
  root: string;
  /** Board timeline supplying the site's real slugs; see board-timeline.ts. */
  boardsFrom: string;
}
// NOTE: this step deliberately has no "foreign"/exclusion list. It moves and
// renames files so that ingest can trust the tree; deciding that a directory
// is not a legitimate board is a different question, answered by
// `ingest.exclude-boards` and enforced per-adapter. An earlier version did
// both, matching declared-foreign names against each page's <title>, and that
// combination was actively harmful: it named `/tr/` and `/cwc/`, which turned
// out to be 40 /vp/ threads and one /r9k/ thread wearing joke display names,
// so 41 real pages would have been dropped from the ingest.

/**
 * One step in a source's prepare pipeline: either a shell command, or a
 * builtin this CLI implements.
 *
 * Builtins exist because some staging work is not expressible as a shell
 * one-liner over a mount -- reconciling a mirror's board directories against
 * each page's own markup means reading 23,295 files and deciding per page.
 * Doing it as a `local:` step shelling back into a separate top-level command
 * split one concern across two entry points; prepare is where a source's data
 * gets filtered and transformed for ingest, so it belongs here.
 */
export type PrepareStep = {
  /** Short label shown while running. */
  name: string;
} & (
  | {
      /** Shell command, run through the runner with cwd = the dataset dir. */
      run: string;
      reconcileBoards?: undefined;
      sqlNormalize?: undefined;
      stageHtml?: undefined;
    }
  | {
      run?: undefined;
      reconcileBoards: ReconcileBoardsStep;
      sqlNormalize?: undefined;
      stageHtml?: undefined;
    }
  | {
      run?: undefined;
      reconcileBoards?: undefined;
      sqlNormalize: SqlNormalizeStep;
      stageHtml?: undefined;
    }
  | {
      run?: undefined;
      reconcileBoards?: undefined;
      sqlNormalize?: undefined;
      stageHtml: StageHtmlStep;
    }
);

/** The subset `download`/`prepare` need; readable without an ingest block. */
export interface SourceInfo {
  id: string;
  file: string;
  name: string;
  link?: string;
  /** Download staging dir, project-root relative. */
  stageDir: string;
  /** Same dir, relative to the datasets root (for NAS_ROOT-based runners). */
  stageDirFromDatasets: string;
  /** Dataset dir itself, in both path models. */
  dir: string;
  dirFromDatasets: string;
  /** Ordered prepare steps from the manifest, if any. */
  prepare: PrepareStep[];
  /** Regexes matching item files to skip when downloading. */
  downloadExclude: RegExp[];
  /**
   * Path whose existence means prepare has already run. Relative to the
   * dataset dir; defaults to "out".
   */
  prepareOutput: string;
  /**
   * Set when the item has been surveyed and holds nothing this store can
   * ingest — an image-only dump, say. Distinct from a null adapter, which
   * means "not written yet": a dead end is a finished investigation, and the
   * manifest exists so nobody repeats it. `source.capture` says why.
   */
  deadEnd: boolean;
}

/**
 * Why a manifest could not be turned into something usable.
 *
 * The distinction is the whole point, and callers act on it: `pending` means
 * the source simply is not staged yet, which `ingest-all` skips silently and
 * `list manifests` shows as "pending". `invalid` means the file is wrong and
 * somebody has to fix it. Collapsing the two would either make a typo look
 * like an unstaged source (silently ingesting nothing) or make every
 * not-yet-prepared source look like a broken one.
 */
export type ManifestErrorKind = 'pending' | 'invalid';

export class ManifestError extends Error {
  kind: ManifestErrorKind;
  constructor(kind: ManifestErrorKind, message: string) {
    super(message);
    this.name = 'ManifestError';
    this.kind = kind;
  }
}

/**
 * A rejected manifest, as a `Result` error.
 *
 * Generic in the ok type so `return bad(file, msg)` type-checks inside any
 * reader regardless of what that reader returns. `return` is also what makes
 * the narrowing below work: the validators rely on the rejecting branch
 * ending control flow, which it did when this threw `never` and still does
 * now that it returns.
 */
const bad = <T>(file: string, msg: string): Result<T, ManifestError> =>
  Result.err(new ManifestError('invalid', `${file}: ${msg}`));

/** A manifest whose `ingest` block is still a scaffold placeholder. */
const pending = <T>(msg: string): Result<T, ManifestError> =>
  Result.err(new ManifestError('pending', msg));

/**
 * Reads one `sources/<id>.json`. The `source` block carries provenance
 * (name/link) and the `ingest` block says what the CLI needs: which adapter
 * to run and where the ingest-ready data sits. Paths are project-root
 * relative so they survive the archive storage moving, as long as the
 * "Memetic Sociology" symlink is repointed.
 */
export const readManifest = (
  file: string,
  projectRoot: string
): Result<Manifest, ManifestError> => {
  if (!existsSync(file)) {
    return bad(file, 'no such manifest');
  }

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return bad(file, `invalid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null) {
    return bad(file, 'expected a JSON object');
  }

  const doc = raw as {
    source?: Record<string, unknown>;
    ingest?: Record<string, unknown>;
  };
  const { source } = doc;
  const { ingest } = doc;
  if (!source) {
    return bad(file, 'missing "source" block');
  }
  if (!ingest) {
    return bad(file, 'missing "ingest" block');
  }

  const { name } = source;
  if (typeof name !== 'string' || name === '') {
    return bad(file, 'source.name is required');
  }

  const { link } = source;
  if (link != null && typeof link !== 'string') {
    return bad(file, 'source.link must be a string');
  }

  // Scaffolded-but-unfinished manifests are an expected state, not corruption:
  // the prepare pipeline hasn't produced this source's data yet.
  const { adapter } = ingest;
  const { path } = ingest;
  if (adapter === null || path === null || adapter === '' || path === '') {
    return pending(
      `${file}: ingest.adapter/ingest.path not filled in yet — run this source's` +
        ` prepare step to populate its out/ directory, then set both fields`
    );
  }

  if (
    typeof adapter !== 'string' ||
    !(ADAPTERS as readonly string[]).includes(adapter)
  ) {
    return bad(file, `ingest.adapter must be one of: ${ADAPTERS.join(', ')}`);
  }
  if (typeof path !== 'string') {
    return bad(file, 'ingest.path must be a string');
  }

  const site = ingest.site ?? '4chan';
  if (typeof site !== 'string' || site === '') {
    return bad(file, 'ingest.site must be a non-empty string');
  }

  // Boards this archive carries that are not boards of `site` -- the archive's
  // own discussion board, another imageboard the crawl caught, or a name that
  // was never a board at all. Enforced by the adapters (see boards.ts for why
  // it cannot be a central whitelist).
  const excludeBoards = ingest['exclude-boards'] ?? [];
  if (
    !Array.isArray(excludeBoards) ||
    excludeBoards.some((b) => typeof b !== 'string' || b === '')
  ) {
    return bad(
      file,
      'ingest.exclude-boards must be an array of non-empty strings'
    );
  }

  return Result.ok({
    id: basename(file, '.json'),
    file,
    name,
    link: link ?? undefined,
    adapter: adapter as Adapter,
    path: resolve(projectRoot, path),
    site,
    excludeBoards: excludeBoards as string[],
  });
};

/**
 * Reads the provenance + staging half of a manifest, ignoring `ingest`.
 *
 * A source that hasn't been downloaded yet necessarily has an unfilled
 * ingest block, so `download` must not require one.
 */
export const readSourceInfo = (
  file: string
): Result<SourceInfo, ManifestError> => {
  if (!existsSync(file)) {
    return bad(file, 'no such manifest');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    return bad(file, `invalid JSON: ${(e as Error).message}`);
  }
  const doc = raw as {
    source?: Record<string, unknown>;
    files?: { source?: unknown };
  };
  if (!doc.source) {
    return bad(file, 'missing "source" block');
  }
  const { name } = doc.source;
  if (typeof name !== 'string' || name === '') {
    return bad(file, 'source.name is required');
  }
  const { link } = doc.source;

  const id = basename(file, '.json');
  const { dir } = doc as { dir?: unknown };
  if (typeof dir !== 'string' || dir === '') {
    return bad(
      file,
      '"dir" (the dataset directory, project-root relative) is required'
    );
  }

  const clean = dir.replace(/\/$/, '');

  const prep = (doc as { prepare?: unknown }).prepare;
  const steps: PrepareStep[] = [];
  if (prep != null) {
    if (!Array.isArray(prep)) {
      return bad(file, '"prepare" must be an array of steps');
    }
    for (const [i, raw] of prep.entries()) {
      const s = raw as {
        name?: unknown;
        run?: unknown;
        'reconcile-boards'?: unknown;
        'sql-normalize'?: unknown;
        'stage-html'?: unknown;
      };
      const name =
        typeof s?.name === 'string' && s.name ? s.name : `step ${i + 1}`;

      const sh = s?.['stage-html'];
      if (sh != null) {
        if (typeof s.run === 'string') {
          return bad(
            file,
            `prepare[${i}] has "stage-html" alongside another kind; a step is one or the other`
          );
        }
        const c = sh as { from?: unknown; to?: unknown };
        if (typeof c.from !== 'string' || c.from === '') {
          return bad(file, `prepare[${i}]."stage-html".from is required`);
        }
        if (typeof c.to !== 'string' || c.to === '') {
          return bad(file, `prepare[${i}]."stage-html".to is required`);
        }
        steps.push({ name, stageHtml: { from: c.from, to: c.to } });
        continue;
      }

      const sn = s?.['sql-normalize'];
      if (sn != null) {
        if (typeof s.run === 'string' || s['reconcile-boards'] != null) {
          return bad(
            file,
            `prepare[${i}] has "sql-normalize" alongside another kind; a step is one or the other`
          );
        }
        const c = sn as { from?: unknown; to?: unknown; rename?: unknown };
        if (typeof c.from !== 'string' || c.from === '') {
          return bad(file, `prepare[${i}]."sql-normalize".from is required`);
        }
        if (typeof c.to !== 'string' || c.to === '') {
          return bad(file, `prepare[${i}]."sql-normalize".to is required`);
        }
        // Required, and deliberately not defaulted. Applying the Fuuka rename
        // to an Asagi dump collides media_filename with the media_orig it
        // already has; skipping it on a Fuuka dump leaves `parent` unread.
        // Either way the result is wrong and silent, so the manifest must say.
        if (c.rename !== 'fuuka' && c.rename !== 'none') {
          return bad(
            file,
            `prepare[${i}]."sql-normalize".rename must be "fuuka" (original-Fuuka column names) or "none" (already Asagi)`
          );
        }
        steps.push({
          name,
          sqlNormalize: {
            from: c.from,
            to: c.to,
            rename: c.rename as SqlRename,
          },
        });
        continue;
      }

      const rb = s?.['reconcile-boards'];
      if (rb != null) {
        if (typeof s.run === 'string') {
          return bad(
            file,
            `prepare[${i}] has both "run" and "reconcile-boards"; a step is one or the other`
          );
        }
        const c = rb as {
          root?: unknown;
          'boards-from'?: unknown;
        };
        if (typeof c.root !== 'string' || c.root === '') {
          return bad(file, `prepare[${i}]."reconcile-boards".root is required`);
        }
        // Required, with no built-in board list to fall back on: it decides
        // which mismatches are filing errors and which are pages from another
        // imageboard, and an absent list silently makes every board unknown.
        if (typeof c['boards-from'] !== 'string' || c['boards-from'] === '') {
          return bad(
            file,
            `prepare[${i}]."reconcile-boards".boards-from is required (path to a board timeline, project-root relative)`
          );
        }
        steps.push({
          name,
          reconcileBoards: {
            root: c.root,
            boardsFrom: c['boards-from'],
          },
        });
        continue;
      }
      if (typeof s?.run !== 'string' || s.run === '') {
        return bad(file, `prepare[${i}].run must be a non-empty shell command`);
      }
      steps.push({ name, run: s.run });
    }
  }

  const output = (doc as { prepareOutput?: unknown }).prepareOutput;
  if (output != null && typeof output !== 'string') {
    return bad(file, '"prepareOutput" must be a string');
  }

  const dead = (doc as { 'dead-end'?: unknown })['dead-end'];
  if (dead != null && typeof dead !== 'boolean') {
    return bad(file, '"dead-end" must be a boolean');
  }

  // Several items ship image/thumbnail tarballs that dwarf the text: rbt-asia
  // is 1.5TB of which ~39GB is the actual dumps. Patterns here keep those out
  // of the download rather than making every ingest wait on them.
  const dl = (doc as { download?: { exclude?: unknown } }).download;
  const downloadExclude: RegExp[] = [];
  if (dl?.exclude != null) {
    if (!Array.isArray(dl.exclude)) {
      return bad(file, '"download.exclude" must be an array of regexes');
    }
    for (const [i, pat] of dl.exclude.entries()) {
      if (typeof pat !== 'string') {
        return bad(file, `download.exclude[${i}] must be a string`);
      }
      try {
        downloadExclude.push(new RegExp(pat, 'i'));
      } catch (e) {
        return bad(
          file,
          `download.exclude[${i}] is not a valid regex: ${(e as Error).message}`
        );
      }
    }
  }

  return Result.ok({
    id,
    file,
    name,
    link: typeof link === 'string' && link !== '' ? link : undefined,
    // Downloads land in <dir>/source, the first stage of the
    // source -> extracted -> out pipeline.
    stageDir: `${clean}/source`,
    // The same location relative to the dataset root, for runners whose
    // base directory is already the dataset root (i.e. NAS_ROOT).
    stageDirFromDatasets: `${basename(clean)}/source`,
    dir: clean,
    dirFromDatasets: basename(clean),
    prepare: steps,
    prepareOutput: output ?? 'out',
    downloadExclude,
    deadEnd: dead === true,
  });
};

/** Resolves a source id (or a direct path to a manifest file) to its file. */
export const manifestPath = (idOrPath: string, projectRoot: string): string => {
  if (idOrPath.endsWith('.json')) {
    return resolve(projectRoot, idOrPath);
  }
  return join(projectRoot, SOURCES_DIR, `${idOrPath}.json`);
};

export const listManifestIds = (projectRoot: string): string[] => {
  const dir = join(projectRoot, SOURCES_DIR);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => basename(f, '.json'))
    .sort();
};

/**
 * Expands a manifest's ingest path into the concrete inputs an adapter takes.
 * json-api and chan-html want the directory itself and walk it; the SQL
 * adapters want one file per call, and warosu backups ship a separate dump
 * per board.
 */
export const ingestInputs = (m: Manifest): Result<string[], ManifestError> => {
  if (!existsSync(m.path)) {
    return pending(
      `${m.file}: ingest.path does not exist: ${m.path}\n` +
        `  the prepare step for this source has not been run yet`
    );
  }

  // Directory-walking adapters take the root itself; they find their own files
  // (thread JSON, saved pages) rather than being handed a glob.
  if (
    m.adapter === 'json-api' ||
    m.adapter === 'html' ||
    m.adapter === 'fybertech-html'
  ) {
    if (!statSync(m.path).isDirectory()) {
      return bad(m.file, `ingest.path must be a directory for ${m.adapter}`);
    }
    return Result.ok([m.path]);
  }

  if (!statSync(m.path).isDirectory()) {
    return Result.ok([m.path]);
  }
  const sql = readdirSync(m.path)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort()
    .map((f) => join(m.path, f));
  if (sql.length === 0) {
    return pending(
      `${m.file}: no .sql files in ${m.path}\n` +
        `  the prepare step for this source has not been run yet`
    );
  }
  return Result.ok(sql);
};
