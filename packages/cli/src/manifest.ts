import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

/** Where committed source manifests live, relative to the project root. */
export const SOURCES_DIR = 'sources';

export const ADAPTERS = [
  'json-api',
  'fuuka-sql',
  'warosu-sql',
  'desuarchive-sql',
  'posts-threads-sql',
  'chan-html',
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
  /** Download staging dir, project-root relative (files.source). */
  stageDir?: string;
}

/** One shell command in a source's prepare pipeline. */
export interface PrepareStep {
  /** Short label shown while running. */
  name: string;
  /** Shell command, run through the runner with cwd = the dataset dir. */
  run: string;
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

/** A manifest whose `ingest` block is still a scaffold placeholder. */
export class PendingSourceError extends Error {}

// The annotation is load-bearing: a call only ends control flow when the
// callee is a function declaration or a const with an explicit type, and the
// validators below rely on `bad()` narrowing the value they just rejected.
const bad: (file: string, msg: string) => never = (file, msg) => {
  throw new Error(`${file}: ${msg}`);
};

/**
 * Reads one `sources/<id>.json`. The `source` block carries provenance
 * (name/link) and the `ingest` block says what the CLI needs: which adapter
 * to run and where the ingest-ready data sits. Paths are project-root
 * relative so they survive the archive storage moving, as long as the
 * "Memetic Sociology" symlink is repointed.
 */
export const readManifest = (file: string, projectRoot: string): Manifest => {
  if (!existsSync(file)) bad(file, 'no such manifest');

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    bad(file, `invalid JSON: ${(e as Error).message}`);
  }
  if (typeof raw !== 'object' || raw === null)
    bad(file, 'expected a JSON object');

  const doc = raw as {
    source?: Record<string, unknown>;
    ingest?: Record<string, unknown>;
  };
  const { source } = doc;
  const { ingest } = doc;
  if (!source) bad(file, 'missing "source" block');
  if (!ingest) bad(file, 'missing "ingest" block');

  const { name } = source;
  if (typeof name !== 'string' || name === '')
    bad(file, 'source.name is required');

  const { link } = source;
  if (link != null && typeof link !== 'string')
    bad(file, 'source.link must be a string');

  // Scaffolded-but-unfinished manifests are an expected state, not corruption:
  // the prepare pipeline hasn't produced this source's data yet.
  const { adapter } = ingest;
  const { path } = ingest;
  if (adapter === null || path === null || adapter === '' || path === '') {
    throw new PendingSourceError(
      `${file}: ingest.adapter/ingest.path not filled in yet — run this source's` +
        ` prepare step to populate its out/ directory, then set both fields`
    );
  }

  if (
    typeof adapter !== 'string' ||
    !(ADAPTERS as readonly string[]).includes(adapter)
  ) {
    bad(file, `ingest.adapter must be one of: ${ADAPTERS.join(', ')}`);
  }
  if (typeof path !== 'string') bad(file, 'ingest.path must be a string');

  const site = ingest.site ?? '4chan';
  if (typeof site !== 'string' || site === '')
    bad(file, 'ingest.site must be a non-empty string');

  return {
    id: basename(file, '.json'),
    file,
    name,
    link: link ?? undefined,
    adapter: adapter as Adapter,
    path: resolve(projectRoot, path),
    site,
  };
};

/**
 * Reads the provenance + staging half of a manifest, ignoring `ingest`.
 *
 * A source that hasn't been downloaded yet necessarily has an unfilled
 * ingest block, so `download` must not require one.
 */
export const readSourceInfo = (file: string): SourceInfo => {
  if (!existsSync(file)) bad(file, 'no such manifest');
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    bad(file, `invalid JSON: ${(e as Error).message}`);
  }
  const doc = raw as {
    source?: Record<string, unknown>;
    files?: { source?: unknown };
  };
  if (!doc.source) bad(file, 'missing "source" block');
  const { name } = doc.source;
  if (typeof name !== 'string' || name === '')
    bad(file, 'source.name is required');
  const { link } = doc.source;

  const id = basename(file, '.json');
  const { dir } = doc as { dir?: unknown };
  if (typeof dir !== 'string' || dir === '') {
    bad(
      file,
      '"dir" (the dataset directory, project-root relative) is required'
    );
  }

  const clean = dir.replace(/\/$/, '');

  const prep = (doc as { prepare?: unknown }).prepare;
  const steps: PrepareStep[] = [];
  if (prep != null) {
    if (!Array.isArray(prep)) bad(file, '"prepare" must be an array of steps');
    for (const [i, raw] of prep.entries()) {
      const s = raw as { name?: unknown; run?: unknown };
      if (typeof s?.run !== 'string' || s.run === '') {
        bad(file, `prepare[${i}].run must be a non-empty shell command`);
      }
      steps.push({
        name: typeof s.name === 'string' && s.name ? s.name : `step ${i + 1}`,
        run: s.run,
      });
    }
  }

  const output = (doc as { prepareOutput?: unknown }).prepareOutput;
  if (output != null && typeof output !== 'string') {
    bad(file, '"prepareOutput" must be a string');
  }

  const dead = (doc as { 'dead-end'?: unknown })['dead-end'];
  if (dead != null && typeof dead !== 'boolean') {
    bad(file, '"dead-end" must be a boolean');
  }

  // Several items ship image/thumbnail tarballs that dwarf the text: rbt-asia
  // is 1.5TB of which ~39GB is the actual dumps. Patterns here keep those out
  // of the download rather than making every ingest wait on them.
  const dl = (doc as { download?: { exclude?: unknown } }).download;
  const downloadExclude: RegExp[] = [];
  if (dl?.exclude != null) {
    if (!Array.isArray(dl.exclude))
      bad(file, '"download.exclude" must be an array of regexes');
    for (const [i, pat] of dl.exclude.entries()) {
      if (typeof pat !== 'string')
        bad(file, `download.exclude[${i}] must be a string`);
      try {
        downloadExclude.push(new RegExp(pat, 'i'));
      } catch (e) {
        bad(
          file,
          `download.exclude[${i}] is not a valid regex: ${(e as Error).message}`
        );
      }
    }
  }

  return {
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
  };
};

/** Resolves a source id (or a direct path to a manifest file) to its file. */
export const manifestPath = (idOrPath: string, projectRoot: string): string => {
  if (idOrPath.endsWith('.json')) return resolve(projectRoot, idOrPath);
  return join(projectRoot, SOURCES_DIR, `${idOrPath}.json`);
};

export const listManifestIds = (projectRoot: string): string[] => {
  const dir = join(projectRoot, SOURCES_DIR);
  if (!existsSync(dir)) return [];
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
export const ingestInputs = (m: Manifest): string[] => {
  if (!existsSync(m.path)) {
    throw new PendingSourceError(
      `${m.file}: ingest.path does not exist: ${m.path}\n` +
        `  the prepare step for this source has not been run yet`
    );
  }

  // Directory-walking adapters take the root itself; they find their own files
  // (thread JSON, saved pages) rather than being handed a glob.
  if (
    m.adapter === 'json-api' ||
    m.adapter === 'chan-html' ||
    m.adapter === 'fybertech-html'
  ) {
    if (!statSync(m.path).isDirectory()) {
      bad(m.file, `ingest.path must be a directory for ${m.adapter}`);
    }
    return [m.path];
  }

  if (!statSync(m.path).isDirectory()) return [m.path];
  const sql = readdirSync(m.path)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort()
    .map((f) => join(m.path, f));
  if (sql.length === 0) {
    throw new PendingSourceError(
      `${m.file}: no .sql files in ${m.path}\n` +
        `  the prepare step for this source has not been run yet`
    );
  }
  return sql;
};
