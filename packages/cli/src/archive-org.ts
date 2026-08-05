import { shQuote, type Runner } from './runner.ts';

/**
 * Downloads Internet Archive items via the metadata API.
 *
 * Fetching the item as a single "all files" zip proved unreliable for the
 * larger archives, so files are pulled one at a time from
 * https://archive.org/download/<id>/<name>, which also lets an interrupted
 * multi-gigabyte transfer resume instead of restarting.
 */

export interface IaFile {
  name: string;
  size: number;
  md5?: string;
  format?: string;
  /** "original" (uploaded), "derivative" (IA-generated), or "metadata". */
  source?: string;
}

export interface IaItem {
  identifier: string;
  title?: string;
  files: IaFile[];
  totalBytes: number;
}

export const itemUrl = (id: string): string => {
  return `https://archive.org/download/${encodeURIComponent(id)}`;
};

/** Pulls an archive.org identifier out of a details/download URL. */
export const identifierFromLink = (link: string): string | undefined => {
  return /archive\.org\/(?:details|download|metadata)\/([^/?#]+)/.exec(
    link
  )?.[1];
};

export const fetchItem = async (id: string): Promise<IaItem> => {
  const url = `https://archive.org/metadata/${encodeURIComponent(id)}`;
  const res = await fetch(url);
  if (!res.ok)
    throw new Error(`metadata fetch failed for ${id}: HTTP ${res.status}`);
  const doc = (await res.json()) as {
    metadata?: { identifier?: string; title?: string };
    files?: Record<string, unknown>[];
  };
  // The API answers 200 with {} for an identifier that doesn't exist.
  if (!doc.metadata || !doc.files)
    throw new Error(`no such item on archive.org: ${id}`);

  const files: IaFile[] = doc.files.map((f) => ({
    name: String(f.name),
    size: Number(f.size ?? 0),
    md5: typeof f.md5 === 'string' ? f.md5 : undefined,
    format: typeof f.format === 'string' ? f.format : undefined,
    source: typeof f.source === 'string' ? f.source : undefined,
  }));

  return {
    identifier: doc.metadata.identifier ?? id,
    title: doc.metadata.title,
    files,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
  };
};

/**
 * IA's `<id>_files.xml` is the item's own file manifest, so it cannot list
 * its own finished checksum; the metadata API reports a stale md5 (and
 * size 0) for it. Verifying it would always fail.
 */
const md5IsTrustworthy = (item: IaItem, f: IaFile): boolean => {
  return f.md5 != null && f.name !== `${item.identifier}_files.xml`;
};

export const humanBytes = (n: number): string => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)}${u[i]}`;
};

export interface DownloadOptions {
  item: IaItem;
  /** Destination directory, as seen by the runner. */
  dest: string;
  runner: Runner;
  /** Re-fetch even when a verified copy is already present. */
  force?: boolean;
  /** List what would happen without transferring anything. */
  dryRun?: boolean;
}

export interface FileOutcome {
  name: string;
  status: 'downloaded' | 'skipped' | 'failed';
  detail?: string;
}

/** md5 of a remote/local path, or undefined when the file isn't there. */
const md5Of = async (
  runner: Runner,
  path: string
): Promise<string | undefined> => {
  const r = await runner.exec(
    `test -f ${shQuote(path)} && md5sum ${shQuote(path)} | cut -d' ' -f1`
  );
  const out = r.stdout.trim();
  return r.code === 0 && /^[0-9a-f]{32}$/.test(out) ? out : undefined;
};

/**
 * Downloads every file in the item into `dest`.
 *
 * curl runs wherever the runner points, so a remote run streams straight
 * from archive.org to the NAS without the bytes passing through this
 * machine. `-C -` resumes a partial file; the md5 from the metadata API is
 * checked afterwards, since a resumed transfer is exactly where corruption
 * would otherwise go unnoticed.
 */
export const downloadItem = async (
  opts: DownloadOptions
): Promise<FileOutcome[]> => {
  const { item, dest, runner } = opts;
  const base = itemUrl(item.identifier);
  const results: FileOutcome[] = [];

  if (!opts.dryRun) {
    const mk = await runner.exec(`mkdir -p ${shQuote(dest)}`);
    if (mk.code !== 0)
      throw new Error(`could not create ${dest}: ${mk.stderr.trim()}`);
  }

  // Item file names can themselves be nested (threads/xml/a.tar.gz), and curl
  // will not create the parent directory. Remembering which ones exist keeps
  // this to one mkdir per directory rather than one per file, which matters
  // when every exec is an SSH round-trip.
  const made = new Set<string>([dest.replace(/\/$/, '')]);

  let n = 0;
  for (const f of item.files) {
    n++;
    const target = `${dest.replace(/\/$/, '')}/${f.name}`;
    const label = `[${n}/${item.files.length}] ${f.name} (${humanBytes(f.size)})`;

    if (opts.dryRun) {
      console.log(`${label} -> ${target}`);
      results.push({ name: f.name, status: 'skipped', detail: 'dry run' });
      continue;
    }

    const verifiable = md5IsTrustworthy(item, f);

    // An already-verified file is left alone so re-running is cheap.
    if (!opts.force && verifiable) {
      const have = await md5Of(runner, target);
      if (have === f.md5) {
        console.log(`${label} — already present`);
        results.push({ name: f.name, status: 'skipped', detail: 'md5 match' });
        continue;
      }
    }

    console.log(label);
    const parent = target.slice(0, target.lastIndexOf('/'));
    if (!made.has(parent)) {
      const mk = await runner.exec(`mkdir -p ${shQuote(parent)}`);
      if (mk.code !== 0)
        throw new Error(`could not create ${parent}: ${mk.stderr.trim()}`);
      made.add(parent);
    }

    const url = `${base}/${encodeURIComponent(f.name)}`;
    const cmd =
      `curl -fL --retry 3 --retry-delay 2 -C - --progress-bar ` +
      `-o ${shQuote(target)} ${shQuote(url)}`;
    const r = await runner.exec(cmd, { inherit: true });

    if (r.code !== 0) {
      // curl exits 33 when the server can't do ranges; a fresh GET fixes it.
      if (r.code === 33) {
        const retry = await runner.exec(
          `curl -fL --retry 3 --progress-bar -o ${shQuote(target)} ${shQuote(url)}`,
          { inherit: true }
        );
        if (retry.code !== 0) {
          results.push({
            name: f.name,
            status: 'failed',
            detail: `curl exit ${retry.code}`,
          });
          continue;
        }
      } else {
        results.push({
          name: f.name,
          status: 'failed',
          detail: `curl exit ${r.code}`,
        });
        continue;
      }
    }

    if (verifiable) {
      const got = await md5Of(runner, target);
      if (got !== f.md5) {
        results.push({
          name: f.name,
          status: 'failed',
          detail: `md5 mismatch (want ${f.md5}, got ${got ?? 'none'})`,
        });
        continue;
      }
    }
    results.push({ name: f.name, status: 'downloaded' });
  }

  return results;
};
