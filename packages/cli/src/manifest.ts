import { Result } from '@badrap/result';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import { SOURCES_DIR } from './paths.ts';

export const ADAPTERS = ['sql', 'json', 'html'] as const;
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
 * `nas-data` symlink is repointed.
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
    id: manifestId(file),
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

  const id = manifestId(file);
  const { dir } = doc as { dir?: unknown };
  if (typeof dir !== 'string' || dir === '') {
    return bad(
      file,
      '"dir" (the dataset directory, project-root relative) is required'
    );
  }

  const clean = dir.replace(/\/$/, '');

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
    prepareOutput: output ?? 'out',
    downloadExclude,
    deadEnd: dead === true,
  });
};

/** Resolves a source id (or a direct path to a manifest file) to its file. */
/**
 * A source is either a flat `sources/<id>.json` or a directory
 * `sources/<id>/manifest.json` carrying a `payload/` beside it.
 *
 * The directory form exists for sources whose prepare needs real code rather
 * than a shell one-liner: the payload is uploaded to the NAS and run there,
 * so it must be a self-contained tree rather than an import from this repo.
 * Flat stays the default because most sources never need one.
 */
export const manifestPath = (idOrPath: string, projectRoot: string): string => {
  if (idOrPath.endsWith('.json')) {
    return resolve(projectRoot, idOrPath);
  }
  // A source package names its own manifest; `<id>/<id>.json` is the
  // convention every one of them follows.
  const dir = join(projectRoot, SOURCES_DIR, idOrPath);
  const declared = join(dir, `${idOrPath}.json`);
  if (existsSync(declared)) {
    return declared;
  }
  return join(dir, 'manifest.json');
};

/**
 * The directory holding a manifest's `payload/`, or undefined for a flat one.
 * Derived from the manifest path so the two forms cannot disagree.
 */
export const manifestId = (file: string): string =>
  basename(file) === 'manifest.json'
    ? basename(dirname(file))
    : basename(file, '.json');

export const payloadDir = (manifestFile: string): string | undefined => {
  if (basename(manifestFile) !== 'manifest.json') {
    return undefined;
  }
  const d = join(dirname(manifestFile), 'payload');
  return existsSync(d) ? d : undefined;
};

/**
 * Every source package in the registry, by directory name.
 *
 * The registry is what exists on disk. Which of those this checkout is
 * actually working with is `sources` in chan.config.json -- a 12TB corpus is
 * not all present on every machine, and a source that is not listed there is
 * inert rather than broken.
 */
export const listManifestIds = (projectRoot: string): string[] => {
  const dir = join(projectRoot, SOURCES_DIR);
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && existsSync(join(dir, e.name, 'package.json'))
    )
    .map((e) => e.name)
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
  if (m.adapter === 'json' || m.adapter === 'html') {
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
