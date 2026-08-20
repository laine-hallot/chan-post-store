# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Node comes from the flake devShell — there is no `node` on PATH otherwise, so
every command needs `nix develop --command` (or an already-entered shell):

```sh
nix develop --command npm run typecheck     # tsc, the only build/lint gate
nix develop --command npm run build:sources # bundle every source's prepare script
nix develop --command node packages/cli/src/cli.ts <command> [...]
```

`prepare` runs a BUILT script, so `build:sources` comes first after any change
to a prepare script or a `staging-*` package. `dist/` is gitignored.

There is no test suite. `typecheck` is the only automated check; verify
behaviour by running CLI commands against real sources (`--dry-run` first).

An npm workspace: code lives in `packages/*`, while `sources/` (the manifest
registry) and `data/` (the SQLite database) stay at the repo root and are
shared. tsconfig uses project references, so typechecking needs `tsc -b` and
the root config is solution-style (`"files": []`) — without that tsc globs the
whole tree and reports TS6305 against the referenced project's sources.

`packages/cli/src/paths.ts` locates the repo root by walking up to the
directory containing `sources/`, so it keeps working if a package moves and —
more importantly — does not depend on cwd. `.env` and `chan.config.json` are
resolved against it rather than Optique's cwd-relative default, because
`packages/analysis` runs its own tools with cwd set there (`npm run
coverage`); a cwd-relative `.env` would simply not be found from anywhere but
the repo root, and *silently*, since a missing `.env` is skipped rather than
reported.

`analysis` imports from `cli` across packages — `@chan-post-store/cli/env`
supplies the shared `dbOptions`/`connectionString`, so both tools agree on how
the database is addressed and the URL-encoded-password rule is stated once.
Two things make that work, neither obvious:

- **An `exports` map in `packages/cli/package.json` pointing at `.ts`
  sources.** Node strips types through the workspace symlink fine; the usual
  "no type stripping under `node_modules`" rule doesn't bite because the
  symlink resolves to a real path outside it.
- **No tsconfig project reference.** Adding one fails with TS6310 —
  referenced projects may not disable emit, and `noEmit` is the whole premise
  here. Without the reference tsc pulls the imported file in as an ordinary
  source and still checks it fully (verified: a deliberate type error across
  the boundary is reported).

`.ts` files run directly under Node 24 type stripping. That means **no
TypeScript syntax that emits code**: no enums, no namespaces, and no
constructor parameter properties (`constructor(readonly x: string)`). tsc has
`erasableSyntaxOnly` on and will reject them.

## Architecture

A CLI that ingests heterogeneous 4chan archive dumps into one SQLite database
with FTS5 search. Everything is driven by committed per-source manifests.

### Source packages

A source is an **npm package** under `sources/<id>/`, and every one of them is
a workspace. It publishes two things, named in its own package.json:

```json
"chan": {
  "manifest": "./fybertech.json",
  "prepare":  "./dist/prepare.mjs"
}
```

Manifests are committed and the archives they describe are not, so the
registry of what the corpus contains travels with the repo.

`packages/cli/src/manifest.ts` parses the manifest, and two readers exist:
`readManifest()` requires a filled-in `ingest` block and throws
`PendingSourceError` otherwise, while `readSourceInfo()` reads only
provenance, so a source whose `ingest.adapter` is still `null` can be prepared.

`ingest.path` is project-root relative and names the staged tree the reader
consumes. Usually `out/`, but a source that converts writes elsewhere
(`out-ndjson/`, `out-native/`) and says so. `prepareOutput` (default `out`) is
the path whose existence means prepare has already run.

A manifest may set `"dead-end": true`, which `list manifests` shows in place
of `pending`. It means the item has been surveyed and holds nothing
ingestible — `4plebs` is 127GB of images with no post text anywhere. That is
not the same as a `null` adapter, which means "not written yet", and the
difference is the point: a dead end is a *finished* investigation. Put the
evidence in `source.capture`, including how far the survey went.

**Which sources this checkout is working with** is `sources` in
`chan.config.json`, not what exists on disk. A 12TB corpus is not all present
on every machine, and an unlisted source is inert rather than broken.

### The staging pipeline

`source/` → `extracted/` → `out*/`, all under the manifest's `dir`.
`download` fills the first, the prepare script produces the rest, `ingest`
reads whatever `ingest.path` names. A source can produce more than one staged
tree: `fybertech` writes `out/` (its raw pages), `out-ndjson/` (what `json`
reads) and `out-native/` (what `html` reads, via its companion package).

**The prepare script is the whole pipeline.** There is no step list in the
manifest. Staging that needs real code could never be expressed as one, and
keeping both meant two mechanisms doing one job and two places to look when
staging misbehaved.

Every prepare script is **node**, never shell. The shell is still used for
what it is good at — `tar`, `7z`, `bunzip2`, `unzstd` — through `staging-core`'s
`sh` helper, but node owns the control flow, and that is what makes a prepare
script a bundle that can be copied to the archive host and run there.

### Prepare scripts run where the archives are

This is the rule that everything else follows from. **The code goes to the
data.** The NFS mount is for seeing which sources exist; it is not for working
with them. Reading a directory with a lot of files in it is on its own enough
to take the NAS down, and the failure is deceptive — `readdir` starts
returning empty while `stat` on a known path still works, so the tree looks
deleted rather than broken (`soft` is what turns the failed readdir into a
silent empty result). SSH key auth goes with it.

Two staging steps predated this rule and both were bugs waiting to happen:
`reconcile-boards` read 23,295 files over the mount, and WARC extraction read
a 700MB file back through the runner and tried to hold it in one string, which
fails above 512MB (`ERR_STRING_TOO_LONG`). Both now run on the archive host.
See `artifacts/reconcile-boards-walks-the-nfs-mount.md`.

`storage.type` in `chan.config.json` says where that is. `local` runs the
script here; `remote` runs it on the machine holding the archives, with the
dataset directory as the working directory either way, so the same script
works under both.

**Building is npm's job, not the CLI's.** Each source package has a `build`
script and the root has `build:sources` (`npm run build --workspaces
--if-present`; only source packages define `build`). `chan.prepare` names the
BUILT artifact, so the CLI never compiles anything — it copies the bundle to
wherever the archives are and runs it. `dist/` is gitignored, so a fresh
clone must run `npm run build:sources` before any `prepare`; the CLI says
exactly that if the bundle is missing.

Things that will bite you here:

- **A bundle must be self-contained.** tsdown externalises `dependencies` by
  default, which produces a bundle that still imports `staging-html` — and
  fails on a machine with no `node_modules`. The configs set
  `noExternal: [/.*/]`; only `node:` builtins stay external. It builds and
  looks fine either way, which is what makes it worth knowing.
- **Nothing may be loaded at runtime by a path relative to a source file.**
  `createRequire(import.meta.url)('./vendor/x.cjs')` cannot survive bundling:
  `import.meta.url` becomes the bundle's own location. Use a static import so
  the bundler inlines it.
- **The runtime is copied, and it cannot be the dev-shell node.** nixpkgs'
  build is dynamically linked against `/nix/store` paths that do not exist on
  the NAS. What gets copied is the official portable build, cached once per
  checkout under `.cache/` and written to the storage root — ~110MB once,
  shared by every source, pinned so a re-run cannot silently change runtimes.

### The staging packages

Shared staging code lives in `packages/staging-*`, split by concern so a SQL
source's bundle never pulls in an HTML parser:

| package | holds |
| --- | --- |
| `staging-core` | `readLines`, `cleanBodyText`/`stripHtml`, `nyWallToUtc`, the `NdjsonPost` record and `NdjsonWriter`, and the `sh`/`linkInto`/`expectFiles` helpers |
| `staging-sql` | mysqldump tuple parsing, `sqlNormalize`, `postsThreadsToNdjson` |
| `staging-html` | the fybertech markup generations, `htmlToNdjson`, `stageNativeHtml`, `reconcileBoards`, WARC extraction, the HTML tree walker |
| `staging-json` | `threadsJsonToNdjson`, `asagiExportToNdjson` |

`site-config-4chan` publishes the board timeline and `boardSlugs()`.

`sqlNormalize` keeps its awk program rather than being rewritten in
JavaScript: it is a streaming text rewrite over hundreds of gigabytes, awk is
already on the archive host, and the output was verified byte-identical
against the readers it replaced. Since the prepare script calling it now runs
on that host, awk is a local child process rather than a remote command.

### The runner abstraction

The archives live on a NAS. Running staging over the SMB mount pays a network
round-trip per file operation, so `packages/cli/src/runner.ts` routes commands either
locally (`bash -c`) or over SSH, behind one interface. `download`, `prepare`,
`warc-extract` and `list manifests` all take `--remote`/`--local`/`--key` and
default to `.env` (`NAS_HOST`, `NAS_ROOT`, `NAS_KEY`).

Things that will bite you here:

- **Quote centrally.** Remote commands are expanded by the *remote* shell, so
  they get parsed twice. Archive paths contain spaces. Use `shQuote`. Values
  interpolated into a shell variable (like `$TARGET`) must *not* be pre-quoted
  — the quotes become part of the value.
- **`NAS_ROOT` is the datasets dir, not a checkout.** The NAS has no clone, so
  `RemoteRunner.rootIsDatasets` is true and callers pass dataset-relative
  paths (`info.dirFromDatasets`) instead of project-relative ones.
- **Auth is deliberately isolated.** `~/.ssh/config` routes hosts through a
  1Password agent whose key set is not stable between invocations, so the
  runner passes `IdentitiesOnly=yes` and `IdentityAgent=none` with a dedicated
  key. Manual `ssh` to the NAS needs the same flags or you land in a different
  account's environment.
- **Never check paths through the local mount** when the runner is remote.
  Stage checks go through `runner.exec` for this reason. `ingest` is the
  exception — adapters read files directly, so it needs the archives visible
  locally.
- **The local mount is NFS, not SMB or sshfs.** gvfs/SMB dropped repeatedly
  ("Transport endpoint is not connected", plus a stale "already mounted"
  state that survived unmounting). sshfs (FUSE, over the same SSH key as the
  runner) replaced it and mostly worked, but every FUSE operation round-trips
  through a userspace daemon, and that daemon occasionally never got a reply
  to a `readdir`/`open` request — the request sat forever (kernel wchan
  `request_wait_answer`), degrading to an unkillable D-state process, for no
  reason visible on either end (the remote `sftp-server` was healthy, a fresh
  `ls` on the same path immediately after always worked). NFS replaced sshfs
  for this reason: it's a kernel-native client with no userspace relay, and
  its mount options make "give up and error" an explicit, tunable choice
  instead of an unsolved FUSE mystery.

  ```sh
  sudo mount -t nfs4 -o soft,timeo=100,retrans=3,vers=4.1,rsize=1048576,wsize=1048576 \
    <host>:/path/to/share ~/mnt/laines_data
  ```

  Requires the NAS to have that share's NFS export enabled (Unraid: Settings
  → NFS, then toggle export on the share) and requires `sudo` on this end —
  unlike sshfs's FUSE mount, a kernel NFS mount needs `CAP_SYS_ADMIN`, so it
  can't be done from an unprivileged agent session; run it in a real
  terminal. `soft` is the option that matters: NFS defaults to `hard`, which
  retries a stuck request forever (the exact same hang class sshfs had, by
  design). `soft` gives up after `retrans` tries and returns an error instead
  — safe here because this mount is read-only for ingest. `hard` is usually
  recommended specifically because a `soft` mount can silently corrupt data
  on a write that times out mid-flight; that risk doesn't apply to a
  read-only workload. The `nas-data` symlink points at this mount.

  Keep it OUT of any tool that walks the project tree. It is a symlink into
  12TB, and an editor indexing it is enough on its own to take the share
  down -- Zed walked it for hours behind two collapses, and `.gitignore` does
  not stop its scanner (`file_scan_exclusions` does). prettier and eslint do
  not descend into symlinked directories, which is the only reason the
  pre-commit hook was never a problem.

  Unmounting: `fusermount -u` doesn't apply to NFS. Use `sudo umount
  ~/mnt/laines_data`, or `sudo umount -l` (lazy) if something still has it
  busy.

### post_stats, the summary table

Aggregates over `posts` are expensive at this scale — a plain "which boards
exist" `GROUP BY` costs ~215s on 288M rows, and anything filtering by board
*and* source has no usable index at all (~130s for a single count). So
`post_stats` holds pre-rolled counts keyed `(source_id, site, board, year)`,
with `min_ts`/`max_ts`.

`PostInserter` tallies in memory during ingest and folds the run into the
table in `finish()` — which every adapter must call before returning, or the
table silently drifts. `refresh-stats` rebuilds it from scratch and is only
needed to backfill a store that predates it.

Undated posts are counted under `year IS NULL`, so `SUM(posts)` always
reconciles with `COUNT(*) FROM posts`. Since `posts` holds one row per post,
these counts do not double-count across archives; `source_id` attributes each
post to whichever archive supplied it first.

### Three ingest cases

`packages/cli/src/adapters/` holds exactly three readers, and each reads ONE
shape. Anything a source does differently is dealt with in `prepare`.

| case | staged layout | what it reads |
| --- | --- | --- |
| `sql` | `out/<board>.sql` | an Asagi post table named for its board, plus its `<board>_deleted` companion |
| `json` | `out/<board>/posts.ndjson` | one JSON record per line, Asagi field names |
| `html` | `out/<board>/<name>.html` | 4chan's own served markup |

There were seven adapters. The collapse was possible because their
differences were mostly not differences of *reading*: `fuuka-sql` vs
`warosu-sql` was a column signature and four field expressions,
`desuarchive-sql`'s reader was already a strict superset of `fuuka-sql`'s,
and the two HTML readers ran over the same trees skipping each other's files.

**The formats are a contract, not a description.** Two parts of it cannot be
inferred from the data and must be preserved by whatever writes the staged
files:

- **`sql` timestamps are America/New_York wall time; NDJSON timestamps are
  true UTC.** This is measured, not assumed, and the same producer ships both:
  Desuarchive's 2019 mysqldump exports are NY wall time while its NDJSON
  export is UTC. `prepare` normalises on the way out so no reader converts.
- **A `json` record's numbers are numbers**, its `board` is a slug, and
  `media_filename`/`media_hash` are top level. Desuarchive's export is
  Asagi-shaped and still fails all three (`"num":"1"`, `board` is
  `{name, shortname}`, media is nested), which is why it gets a converter
  rather than the reader getting a second shape.

**Never judge an ingest by exit code.** Pointed at a dialect it cannot read, a
reader reports zero tables and zero posts and exits 0 — indistinguishable from
a source whose posts were all already present. Check the post count, the OP
count and the timestamp nulls. Assert on ZERO, not on a percentage: "timestamps
parsed for nearly all" once passed at 5.4% missing.

#### Splitting lines is not `readline`

**Node's `readline` breaks on U+2028 LINE SEPARATOR, U+2029 PARAGRAPH
SEPARATOR and a lone `\r` as well as on `\n`, and 4chan post bodies contain
all three.** Every line-oriented reader here uses `lines.ts` `readLines`,
which splits on `\n` and nothing else.

This was measured, not anticipated. One `/a/` comment in laza-4chan-archive
carries a literal U+2028; `readline` returned that 1,042,290-character INSERT
as a 69,840-character fragment, and the old reader parsed 260 of its 3,873
tuples, threw "unterminated string", counted ONE bad line and dropped the
other 3,613 posts. 0.33% of a 300MB slice, gone with exit code 0.

It applies to NDJSON too, for a reason that is easy to miss: `JSON.stringify`
escapes `\n` and `\r` but leaves **U+2028 raw** in its output. Framing is
safe only because the reader splits on `\n` alone.

`awk` is safe here — its record separator really is `\n` — which is why the
staging steps that route SQL by line can be shell.

#### What `prepare` has to know

Everything format-specific that is not one of the three shapes above:

- **Original-Fuuka SQL is renamed to Asagi in the CREATE TABLE header.** Those
  dumps carry no INSERT column list, so tuple order follows the table
  definition and rewriting the header remaps every field without touching a
  data row. The substitutions are a 2-cycle and their order matters: both
  schemas have a `media_filename` and disagree about what it means, so the
  incumbent moves to `media_orig` before `media` takes the name. `parent`
  becomes `thread_num` but its VALUES are not rewritten — Fuuka stores 0 for
  an OP where Asagi stores the OP's own number, and the reader normalises
  `0 -> num`, which is what makes a header-only edit sufficient.
- **Which tables are boards is decided by the columns they declare**, the same
  test the reader applies — not by a list of known side-table names.
  installgentoo ships `banlist`, `modlog`, `reports`, `staff` and
  `loginattempts` next to its three boards, and a name-based rule duly wrote
  five bogus board files.
- **A crawl can mix markup families in one directory.** fybertech's 638 thread
  pages are 420 classic Futaba, 197 in its own later template and 20 in
  4chan's own; the yotsubasociety mirror is ~85%/~10%. `stage-html` pulls the
  native ones out; `html-to-ndjson` parses the rest.
- **Board and thread come from the staged path, not from guesswork.** The
  `html` reader takes the board from the directory, and treats a filename that
  is digits IN FULL as asserting the thread number. Any other name defers to
  the markup, where each OP carries its own. The previous rule — leading
  digits of the filename — read the YEAR out of
  4chan-vp-2015-threads' `<date>_<threadno>.html` and filed 859,937 posts
  under a nonexistent thread 2015.
- **The two pre-Fuuka archives need a join.** 4archive and chanarchive store
  one flat `posts` table pointing into `threads`, so a post row cannot say
  what board it is from. `posts-threads-to-ndjson` resolves it. `threads` is
  one contiguous block at the END of both dumps, so it scans BACKWARDS to find
  it and builds the index without touching the rest — `posts` is then streamed
  once rather than the file being read twice.

**Not every board in an archive is a board of the site it claims.** Three
kinds turn up: the archive's *own* discussion board (Desuarchive's and
archive.alice.al's `meta`), *other imageboards* a broad crawl swept in
(`may.not4chan.org`, `orly.yi.org`), and *parse artifacts* that were never
boards. `ingest.exclude-boards` drops them at ingest and
`packages/cli/src/boards.ts` is the shared matcher; a converter that knows
the distinction (chanarchive's per-thread host) drops them at prepare instead
and reports the count separately, since `noThread` is a real diagnostic that
must not absorb rows we chose to discard.

`posts` is keyed `UNIQUE (site, board, post_no)` — one row per post, not one
per (post, archive). Ingest is therefore idempotent both ways, and **queries
need no dedup logic**. Two consequences worth remembering: archive overlap is
not answerable from the database (infer it by diffing the source datasets),
and when two sources hold the same post the FIRST writer wins and the loser's
row is discarded rather than merged — so prefer the fuller source first where
a capture abbreviates bodies (4chan's board index truncates long comments).

**Order does not otherwise affect coverage.** Each reader scans every post it
is fed and the constraint rejects only post numbers already stored, so a
partial capture never blocks a fuller one.

## Working with archive.org sources

**Before writing or editing a manifest, fetch
`https://archive.org/metadata/<identifier>` and read the file list.** Local
directory listings are not enough — three separate mistakes came from trusting
them:

- **Items ship the same data twice.** fybertech has both a loose
  `2015-02-16-WARC/` directory and a `.7z` containing the same crawl; both are
  `source: original`. Matching sizes mean duplication, not that one is the
  other's extraction.
- **Image payloads dwarf the text.** rbt-asia is 1.4TB of which ~36GB is the
  actual dumps; 4archive is 302GB of which 4GB is the SQL. Add
  `download.exclude` regexes for `-images-`/`-thumbs-`/`-img-` style names.
  Verify with `download <source> --dry-run`, which prints what is skipped.
  Check that a pattern doesn't catch real data — `/data/` looked like images
  in 4chan-data-20181015 but is 102GB of posts.
- **Names can be nested.** Files may be `subdir/name.warc.gz`, which changes
  where they land.

Also: `source: original` vs `derivative` does not cleanly separate payload
from bookkeeping (`_files.xml` is marked `original`), and IA reports a stale
md5 and size 0 for `<id>_files.xml` because it cannot contain its own
checksum — it is excluded from verification in `packages/cli/src/archive-org.ts`.

### Resuming an ingest

`sources.completed_at` records that a source's adapter returned normally, and
`ingest-all` skips those by default, so an interrupted pass resumes instead of
restarting. Re-reading a finished source is harmless but not free — one
resumed run spent hours re-parsing `4chan-threads` to insert zero rows, every
one rejected by `ON CONFLICT DO NOTHING`.

It records completion, **not** progress. A source can get a long way in and
still abort (`4chan-threads` failed 13.5M posts deep on a NUL byte), so "this
source has rows" is not the same as "this source is done". Only a clean
adapter return marks it, which is why `markSourceCompleted` is called by the
*caller* of the adapter and never from inside one. An `ingest --board` run
doesn't mark either: it covers part of the source by construction.

Completion is not permanent — re-staging an archive, or fixing an adapter bug
that silently dropped rows, means the mark no longer describes what a run
would produce. `--redo <source>` re-ingests one anyway, `--force` re-ingests
every one; both refresh `completed_at` through the same call every other run
uses. Neither *clears* the column up front, so a re-run that fails leaves the
record of when the source last did finish intact — at the cost that a failed
`--redo` will be skipped by the next plain run unless you repeat the flag.

`--force` rather than `--all` deliberately: `ingest-all` is already a command
name, and `download --all` means something else entirely (include the files
`download.exclude` filters out). `--force` matches how `download` and
`prepare` already spell "re-run what would otherwise be skipped".

`--exclude <source>` still exists for skipping a source you don't want on a
particular run, which is a different question from whether it finished.

### Two schemas: what ingest needs vs what queries need

`openDb` runs `SCHEMA` on every connect, so everything in it must be cheap to
re-assert on a store with hundreds of millions of rows. That rules out the
query-time indexes on `posts`, which live in `QUERY_INDEXES` instead and are
managed explicitly by `indexes build|drop|status`.

The split is not just about connect cost. Ingest needs exactly one index —
the `UNIQUE (site, board, post_no)` that `ON CONFLICT` targets — and pays for
every other one on every insert while getting nothing back. On the current
corpus that is ~72GB of write amplification, and GIN pending-list merges alone
accounted for 1.01 billion of the 1.02 billion index blocks read from disk
(99.4%) during the last full pass. Building an index from a finished table is
a sort; maintaining it during load is hundreds of millions of random updates.

So a bulk load is `indexes drop` → `ingest-all` → `indexes build`.
`ingest-all` warns (does not act) when it finds them present.

`indexes build` raises `maintenance_work_mem` for its own session
(`--memory`, default 4GB) rather than relying on the global, which stays at
256MB because `autovacuum_work_mem` inherits it and three autovacuum workers
each claiming several GB during an ingest is not the trade being made.

There are three disks, and all three matter to a build:

| tablespace   | mount                  | holds                          |
| ------------ | ---------------------- | ------------------------------ |
| `pg_default` | `/var/lib/postgresql`  | data dir, WAL, `post_stats`, and the `posts` PK + UNIQUE indexes |
| `fast`       | `/nvme`                | the query indexes (`chan.config.json` sets `indexes.tablespace`) |
| `slow`       | `/slow-storage`        | the `posts` heap                |

Index access is random and wants the NVMe; heap writes during ingest are
sequential appends and do not. `pg_default` is the *smallest* of the three,
which is the trap below.

**Temp files are a third disk question, separate from where the index lands.**
Postgres spills sorts into the database's default tablespace unless
`temp_tablespaces` says otherwise — so by default a build writes its sort to
the same disk as WAL, and filling that disk takes the cluster down, not just
the build. It became urgent at PG18, which builds **GIN indexes in parallel**:
every index entry now passes through a tuplesort on the way in, so the spill
became a thing that exists at all. `indexes build --temp-tablespace` (config:
`indexes.tempTablespace`) points it at the NVMe instead. Note it is set as a
*literal*, not an identifier — `temp_tablespaces` is a comma-separated list
GUC, and `quoteIdent`'s double quotes would become part of the name.

**Do not size that spill from the lexeme count.** The obvious estimate —
1.36B posts × ~15.6 distinct lexemes ≈ 21 billion entries — overshot the
measured peak by more than 6x, because each parallel worker pre-merges TID
lists per key in its `BuildAccumulator` before anything reaches the sort.
What actually gets sorted is 547M key-batched tuples, ~39 TIDs each. Measured
on the first full build (Aug 2026):

| heap scan | 4h16m, 73.3M blocks (559GB) off the array |
| merge | 547,411,921 tuples at ~965k/s |
| peak spill | ~90GB |
| total | **4.95h**, index **77GB** |

The flag still earns its place: 90GB against 108GB free on the WAL disk is
not a margin worth having, and the disk that fills takes the cluster with it,
not just the build.

Watch a long build with `pg_stat_progress_create_index` (phase, `blocks_done`
/ `blocks_total`, and `tuples_done`/`tuples_total` during the merge — the
merge reports a denominator, the scan reports blocks) rather than guessing
from elapsed time.

### What the search index does and does not buy

`idx_posts_search` makes finding matches instant and fetching them slow. On a
term with 10,113 hits: **13ms** in the Bitmap Index Scan, **118s** in the heap
recheck. GIN supports no index-only scan, so even `count(*)` must visit every
candidate row, and those rows are scattered at random across a 559GB heap on
the array. The cost of a search is therefore set by how many posts match, not
by how rare the word is to look up.

**A warm number is not a search timing.** The same `count(*)` on a 10k-hit
term: **169.2s** cold (39,870 blocks off the array) and **0.1s** immediately
after (0 read, 40,135 buffer hits). Identical SQL, identical plan, 1,700x.
Any figure quoted for a term that was just searched is measuring
`shared_buffers`, not the store — and since the heap is 559GB against 16GB of
`shared_buffers` plus ~30GB of host page cache, under 8% can be resident, so
a term nobody has searched recently *is* a cold read. Restarting the cluster
resets this, which is why a search can look 1000x slower after a restart with
nothing wrong.

`effective_io_concurrency = 256` (applied via ALTER SYSTEM) is the one cheap
lever — it controls how deeply a bitmap heap scan prefetches. Measured across
four terms, alternating the setting so a warming trend could not pass for an
improvement: 1.77 and 2.16 ms/block at the default 16, against 1.58 and 1.28
at 256, i.e. ~27% off. Worth setting; not a fix.

**`io_workers` was tried and does nothing measurable here** — don't re-run
this experiment. `io_method` is `worker`, so prefetch depth is in principle
capped by the I/O worker pool, but four fresh cold terms alternating 3 and 8
gave 1.21 / 2.82 ms/block at 3 against 1.28 / 1.93 at 8: the spread *within*
each setting is larger than the gap between them. Note the per-block rate
also improves with scan size (21,584 blocks came in at 2.82 ms/block, 91,613
at 1.21), so compare only similarly-sized scans. It is `sighup`, not
`postmaster` — changing it needs a reload, not a restart, contrary to what
this file said before.

## Conventions

- Prepare scripts must be idempotent: the pipeline is re-run whenever a source
  is re-staged, and `--force` re-runs it over a populated tree. Prefer
  `cp -al || cp -a` (hardlink, fall back to copy) rather than symlinks —
  ingest globs real files, and a symlink breaks when the tree is read over a
  different mount.
- End every prepare script by asserting it produced something
  (`expectFiles`). A step that stages zero files and exits 0 looks exactly
  like a source whose data was already in place, which is the failure mode
  this codebase keeps being bitten by.
- `list manifests` `s/e/o` column shows which stage dirs are non-empty — the
  quickest way to see where a source actually is.
- Record non-obvious facts about a source in `source.capture` (free text, not
  parsed), e.g. whether a WARC captured a full thread or a truncated board
  index. That distinction determines what an adapter can trust.
