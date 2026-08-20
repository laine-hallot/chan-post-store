import { Result } from '@badrap/result';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/**
 * Command execution that is either local or on the NAS over SSH.
 *
 * Staging the archives means running wget/tar/7z where the disks are: doing
 * it over the SMB mount pays a network round-trip per file operation. Every
 * pipeline step therefore goes through a Runner rather than calling
 * child_process directly, so the same script works in both places.
 */

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  /** Working directory for the command; defaults to the runner's root. */
  cwd?: string;
  /** Stream child output to our stdio instead of capturing it. */
  inherit?: boolean;
}

/** Single-quote a string for POSIX sh. Archive paths contain spaces. */
export const shQuote = (s: string): string => {
  return `'${s.replaceAll("'", `'\\''`)}'`;
};

export interface Runner {
  /**
   * Reads a file from wherever the runner points.
   *
   * Result rather than throwing: over SSH a missing or unreadable file is an
   * ordinary answer from the far end, not a defect, and the local and remote
   * implementations otherwise fail in different shapes (an fs exception vs a
   * non-zero exit) for the same situation.
   */
  readFile(path: string): Promise<Result<Buffer, Error>>;
  /** Writes a file wherever the runner points, creating parent dirs. */
  writeFile(path: string, data: Buffer): Promise<Result<void, Error>>;

  /**
   * Copies a local directory tree to the target, replacing whatever is there.
   *
   * One tar stream rather than a file at a time: a payload is a handful of
   * small files, and per-file round trips would be several connections to
   * move a few hundred kilobytes.
   */
  uploadDir(localDir: string, remoteDir: string): Promise<Result<void, Error>>;
  /** Human-readable description of where commands run. */
  readonly where: string;
  /** Base directory that relative paths resolve against. */
  readonly root: string;
  /**
   * True when `root` is the datasets directory itself rather than the
   * project root, so callers pass dataset-relative paths to `path()`.
   * The NAS has no checkout, only the archives.
   */
  readonly rootIsDatasets: boolean;
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Resolves a project-relative path to one valid on the target. */
  path(rel: string): string;
  close(): Promise<void>;
}

const run = (
  file: string,
  args: string[],
  inherit: boolean,
  stdin?: Buffer
): Promise<ExecResult & { raw: Buffer }> => {
  return new Promise((res, rej) => {
    // spawn, not exec: staging commands stream progress for minutes to hours
    // and can emit more output than exec's buffer holds.
    const child = spawn(file, args, {
      stdio: [
        stdin ? 'pipe' : 'ignore',
        inherit ? 'inherit' : 'pipe',
        inherit ? 'inherit' : 'pipe',
      ],
    });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => out.push(d));
    child.stderr?.on('data', (d) => (stderr += d));
    child.on('error', rej);
    child.on('close', (code) => {
      const raw = Buffer.concat(out);
      res({ code: code ?? -1, stdout: raw.toString('utf8'), stderr, raw });
    });
    if (stdin) {
      child.stdin!.end(stdin);
    }
  });
};

export class LocalRunner implements Runner {
  readonly where = 'local';
  readonly rootIsDatasets = false;
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const cwd = opts.cwd ?? this.root;
    return run(
      'bash',
      ['-c', `cd ${shQuote(cwd)} && ${cmd}`],
      opts.inherit ?? false
    );
  }

  path(rel: string): string {
    return resolve(this.root, rel);
  }

  async readFile(path: string): Promise<Result<Buffer, Error>> {
    try {
      return Result.ok(readFileSync(path));
    } catch (e) {
      return Result.err(e as Error);
    }
  }

  async writeFile(path: string, data: Buffer): Promise<Result<void, Error>> {
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, data);
      return Result.ok(undefined);
    } catch (e) {
      return Result.err(e as Error);
    }
  }

  async uploadDir(
    localDir: string,
    remoteDir: string
  ): Promise<Result<void, Error>> {
    // Same machine, so this is a copy rather than a transfer. Still goes
    // through the same interface so a payload step reads identically
    // whichever runner it lands on.
    const r = await this.exec(
      `rm -rf ${shQuote(remoteDir)} && mkdir -p ${shQuote(remoteDir)} && ` +
        `cp -a ${shQuote(localDir)}/. ${shQuote(remoteDir)}/`
    );
    return r.code === 0
      ? Result.ok(undefined)
      : Result.err(new Error(`could not copy ${localDir}: ${r.stderr.trim()}`));
  }

  async close(): Promise<void> {}
}

/**
 * Runs commands on a remote host over a multiplexed SSH connection.
 *
 * A ControlMaster is opened once and every later command reuses it, so
 * authentication and the TCP/crypto handshake happen a single time rather
 * than per command. Each command is still its own ssh invocation, which
 * keeps stdout/stderr separated and exit codes intact — feeding commands
 * into one shared shell's stdin would lose both.
 */
export class RemoteRunner implements Runner {
  readonly where: string;
  readonly rootIsDatasets = true;
  private ctl: string;
  private master?: ReturnType<typeof spawn>;

  readonly host: string;
  readonly root: string;
  private key?: string;

  constructor(host: string, root: string, key?: string) {
    this.host = host;
    this.root = root;
    this.key = key;
    this.where = `ssh://${host}`;
    this.ctl = join(mkdtempSync(join(tmpdir(), 'chan-ssh-')), 'ctl');
  }

  /**
   * Options shared by the master and every multiplexed command.
   *
   * When a key is configured it is used *exclusively*: IdentitiesOnly stops
   * ssh from also offering agent keys, and IdentityAgent=none detaches from
   * the agent altogether. Both matter because ~/.ssh/config routes all hosts
   * through an external agent whose key set varies between invocations —
   * without this, the wrong keys get offered and the server may cut the
   * connection before reaching the right one.
   */
  private sshOpts(): string[] {
    const o = ['-o', 'BatchMode=yes'];
    if (this.key) {
      o.push(
        '-i',
        this.key,
        '-o',
        'IdentitiesOnly=yes',
        '-o',
        'IdentityAgent=none'
      );
    }
    return o;
  }

  /** Opens the shared connection. Fails fast if the host isn't reachable. */
  async connect(): Promise<void> {
    this.master = spawn(
      'ssh',
      [
        '-N',
        '-M',
        '-S',
        this.ctl,
        ...this.sshOpts(),
        '-o',
        'ConnectTimeout=10',
        '-o',
        'ServerAliveInterval=30',
        this.host,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] }
    );
    let err = '';
    this.master.stderr?.on('data', (d) => (err += d));

    // Wait for the control socket to appear, or for the master to give up.
    const deadline = Date.now() + 15_000;
    for (;;) {
      if (existsSync(this.ctl)) {
        return;
      }
      if (this.master.exitCode != null) {
        const hint = this.key
          ? `  install the key: ssh-copy-id -i ${this.key}.pub ${this.host}`
          : `  set NAS_KEY in .env, or run: ssh-copy-id ${this.host}`;
        throw new Error(
          `ssh to ${this.host} failed: ${err.trim() || `exited ${this.master.exitCode}`}\n${hint}`
        );
      }
      if (Date.now() > deadline) {
        this.master.kill();
        throw new Error(`ssh to ${this.host} timed out after 15s`);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  exec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
    const cwd = opts.cwd ?? this.root;
    // The command is expanded by the *remote* shell, so it is quoted once
    // here as a single argv element and left for that shell to parse.
    const remote = `cd ${shQuote(cwd)} && ${cmd}`;
    return run(
      'ssh',
      ['-S', this.ctl, ...this.sshOpts(), this.host, remote],
      opts.inherit ?? false
    );
  }

  path(rel: string): string {
    if (rel.startsWith('/')) {
      return rel;
    }
    return `${this.root.replace(/\/$/, '')}/${rel}`;
  }

  /** Streams a remote file back over the existing connection. */
  async readFile(path: string): Promise<Result<Buffer, Error>> {
    const r = await run(
      'ssh',
      ['-S', this.ctl, ...this.sshOpts(), this.host, `cat ${shQuote(path)}`],
      false
    );
    if (r.code !== 0) {
      return Result.err(
        new Error(`could not read ${path} on ${this.host}: ${r.stderr.trim()}`)
      );
    }
    return Result.ok(r.raw);
  }

  /** Ships a directory over the existing connection as one tar stream. */
  async uploadDir(
    localDir: string,
    remoteDir: string
  ): Promise<Result<void, Error>> {
    const tar = await run('tar', ['cf', '-', '-C', localDir, '.'], false);
    if (tar.code !== 0) {
      return Result.err(
        new Error(`could not read ${localDir}: ${tar.stderr.trim()}`)
      );
    }
    const r = await run(
      'ssh',
      [
        '-S',
        this.ctl,
        ...this.sshOpts(),
        this.host,
        `rm -rf ${shQuote(remoteDir)} && mkdir -p ${shQuote(remoteDir)} && ` +
          `tar xf - -C ${shQuote(remoteDir)}`,
      ],
      false,
      tar.raw
    );
    return r.code === 0
      ? Result.ok(undefined)
      : Result.err(
          new Error(
            `could not upload ${localDir} to ${this.host}: ${r.stderr.trim()}`
          )
        );
  }

  /** Writes a remote file by piping the bytes in over stdin. */
  async writeFile(path: string, data: Buffer): Promise<Result<void, Error>> {
    const dir = path.replace(/\/[^/]*$/, '');
    const r = await run(
      'ssh',
      [
        '-S',
        this.ctl,
        ...this.sshOpts(),
        this.host,
        `mkdir -p ${shQuote(dir)} && cat > ${shQuote(path)}`,
      ],
      false,
      data
    );
    if (r.code !== 0) {
      return Result.err(
        new Error(`could not write ${path} on ${this.host}: ${r.stderr.trim()}`)
      );
    }
    return Result.ok(undefined);
  }

  async close(): Promise<void> {
    if (!this.master) {
      return;
    }
    await run('ssh', ['-S', this.ctl, '-O', 'exit', this.host], false).catch(
      () => {}
    );
    this.master.kill();
    this.master = undefined;
  }
}

/** Minimal KEY=value parser; no export/quotes handling beyond trimming. */
export const readEnvFile = (file: string): Record<string, string> => {
  if (!existsSync(file)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) {
      continue;
    }
    const i = t.indexOf('=');
    if (i < 0) {
      continue;
    }
    out[t.slice(0, i).trim()] = t
      .slice(i + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
  }
  return out;
};

export interface RunnerConfig {
  /** --local forces local even when .env names a host. */
  forceLocal?: boolean;
  /** --remote <host> overrides the .env host. */
  host?: string;
  /** Identity file, overriding NAS_KEY. */
  key?: string;
  /** Remote base dir, overriding NAS_ROOT. */
  rootOverride?: string;
  projectRoot: string;
}

/**
 * Picks a runner: remote when a host is given by flag or NAS_HOST in .env,
 * local otherwise. NAS_ROOT is where the archives live on the NAS, which is
 * a local path there, not the SMB mount path used here.
 */
export const makeRunner = async (
  cfg: RunnerConfig
): Promise<Result<Runner, Error>> => {
  const env = readEnvFile(join(cfg.projectRoot, '.env'));
  const host = cfg.forceLocal ? undefined : (cfg.host ?? env.NAS_HOST);
  if (!host) {
    return Result.ok(new LocalRunner(cfg.projectRoot));
  }

  const root = cfg.rootOverride ?? env.NAS_ROOT;
  if (!root) {
    return Result.err(
      new Error(
        `NAS_HOST is set but NAS_ROOT is not — add the archive path on ${host} to .env`
      )
    );
  }
  const key = cfg.key ?? env.NAS_KEY;
  const r = new RemoteRunner(host, root, key ? expandHome(key) : undefined);
  // connect() still throws: it is internal to this module, and its two
  // failures (auth refused, 15s timeout) both carry the setup hint that is
  // the whole point of the message. Caught here so callers see one Result.
  try {
    await r.connect();
  } catch (e) {
    return Result.err(e as Error);
  }
  return Result.ok(r);
};

/** Expands a leading ~ so .env can hold the usual ~/.ssh/... form. */
const expandHome = (p: string): string => {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
};
