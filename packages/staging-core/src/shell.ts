import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Run a shell command in the dataset directory.
 *
 * Prepare scripts are node, not shell, but the work they orchestrate often is
 * not: `tar`, `7z`, `bunzip2` and `unzstd` are the right tools for unpacking
 * and reimplementing them in JavaScript would be worse in every way. So the
 * shell stays for the jobs it is good at, and node owns the control flow --
 * which is what makes a prepare script a bundle that can be copied to the
 * archive host and run there.
 *
 * Output is inherited so a multi-hour unpack shows progress rather than
 * buffering it. A non-zero exit throws.
 */
export const sh = (cmd: string): void => {
  execFileSync('sh', ['-c', cmd], { stdio: 'inherit' });
};

/**
 * Hardlink every file matching `pattern` from `from` into `to`, rebuilding
 * `to` first.
 *
 * `cp -al` with a copy fallback, rather than symlinks: ingest globs real
 * files, and a symlink breaks when the tree is read over a different mount.
 * Hardlinks also mean staging costs no disk until something rewrites a file.
 */
export const linkInto = (
  from: string,
  to: string,
  pattern = /\.sql$/i
): number => {
  rmSync(to, { recursive: true, force: true });
  mkdirSync(to, { recursive: true });
  let n = 0;
  for (const name of readdirSync(from)) {
    if (!pattern.test(name)) {
      continue;
    }
    link(join(from, name), join(to, name));
    n++;
  }
  return n;
};

/**
 * Hardlink one file, copying if the link cannot be made.
 *
 * Not `sh("cp -al ...")`. Building that command means quoting a filename into
 * a shell string, and these archives contain names the shell will happily
 * mangle: one page in the yotsubasociety mirror is called
 * `_g_ - Why are people paying $108 for Windows...`, and inside the double
 * quotes JSON.stringify produces, `$1` expands to nothing -- so the copy
 * looked for `$08` and failed. Names also contain quotes, spaces and bytes
 * that are not valid UTF-8. The filesystem API takes the name as-is.
 */
export const link = (from: string, to: string): void => {
  try {
    linkSync(from, to);
  } catch {
    // Cross-device, or the destination already exists.
    copyFileSync(from, to);
  }
};

/**
 * Fail loudly when a staging step produced nothing.
 *
 * A step that stages zero files and exits 0 looks exactly like a source whose
 * data was already in place -- the failure mode this codebase keeps being
 * bitten by. Every prepare script ends in one of these.
 */
export const expectFiles = (dir: string, what: string): number => {
  const n = existsSync(dir) ? readdirSync(dir).length : 0;
  if (n === 0) {
    console.error(`staged no ${what} into ${dir}`);
    process.exit(1);
  }
  return n;
};
