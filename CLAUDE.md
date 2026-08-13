# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Node comes from the flake devShell — there is no `node` on PATH otherwise, so
every command needs `nix develop --command` (or an already-entered shell):

```sh
nix develop --command npm run typecheck    # tsc, the only build/lint gate
nix develop --command node packages/cli/src/cli.ts <command> [...]
```

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

### The manifest registry

`sources/<id>.json` is the unit of configuration; `packages/cli/src/manifest.ts` parses it.
Manifests are committed, the archives they describe are not, so the registry
of what the corpus contains travels with the repo. Each manifest carries
provenance (`source`), download filtering (`download.exclude`), staging steps
(`prepare`), and ingest config (`ingest`).

Two readers exist, and the distinction matters:

- `readManifest()` requires a filled-in `ingest` block and throws
  `PendingSourceError` otherwise.
- `readSourceInfo()` reads only provenance + staging, so `download` and
  `prepare` work on sources whose `ingest.adapter` is still `null`.

A source that hasn't been staged yet necessarily has no adapter, so anything
running before ingest must use `readSourceInfo`.

`ingest.path` is project-root relative and points at `out/`. Paths are
relative so moving the archive storage only means repointing the
`Memetic Sociology` symlink.

A manifest may also set top-level `"dead-end": true`, which `list manifests`
shows in place of `pending`. It means the item has been surveyed and holds
nothing ingestible — `4plebs` is 127GB of images with no post text anywhere.
That is not the same as a `null` adapter, which means "not written yet", and
the difference is the point: a dead end is a *finished* investigation, and the
manifest exists precisely so the next person doesn't repeat it. Put the
evidence in `source.capture`, including how far the survey actually went
(`4plebs` records two boards scanned in full and seven sampled at the head).

### The staging pipeline

`source/` → `extracted/` → `out/`, all under the manifest's `dir`.
`download` fills the first, `prepare` produces the rest, `ingest` reads `out/`.
Sources stop at different stages, which is why `ingest.path` is explicit
rather than derived.

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
  read-only workload. The `Memetic Sociology` symlink points at this mount.

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

### Adapters

One per archive format in `packages/cli/src/adapters/`, sharing only low-level helpers
(`packages/cli/src/ingest.ts` `PostInserter`, `packages/cli/src/mysqldump.ts` tuple parsing). Keep them
separate even when formats look similar.

`packages/cli/src/mysqldump.ts` also holds the Fuuka-family timestamp fix: Asagi/Fuuka
store `timestamp` as America/New_York wall time, not UTC, so it is converted
back on ingest.

**Not every board in an archive is a board of the site it claims.** Three
kinds turn up: the archive's *own* discussion board (Desuarchive's `meta`),
*other imageboards* a broad crawl swept in (`may.not4chan.org`,
`orly.yi.org`), and *parse artifacts* that were never boards — collection
titles read into the board column (`bay of pigs`, `law and order hack`) or
bare numbers (`7898`).

`ingest.exclude-boards` in a manifest drops them, and `packages/cli/src/boards.ts`
(`makeBoardFilter`) is the shared matcher. **The enforcement is in the
adapters, deliberately, not in one central whitelist.** A canonical
board-list-per-site catches only the third kind: it asks "is this board valid
for site X", but the defect in the first kind is the *site attribution
itself*, and an archive's own board named `meta` or `qa` is a perfectly valid
4chan board name that any name-keyed check waves through. Only the adapter
knows how it derived the board — table name, thread URL, or markup — and
therefore whether the site label can be trusted.

Where the check goes matters for cost and for honesty:

- SQL adapters reject at `CREATE TABLE`/INSERT-header time, so an excluded
  board is never tuple-parsed.
- `posts-threads-sql` resolves it inside `ThreadIndex` at *label intern* time
  — once per distinct `(site, board)` rather than once per post — and the
  excluded thread **stays in the index**. Dropping it instead would make its
  posts indistinguishable from genuine orphans, and `noThread` is a real
  diagnostic (3.0% on the ten-billion archive) that must not absorb rows we
  chose to discard. Verified: `noThread` is 290,171 on 4archive whether `/b/`
  is excluded or not.
- Every adapter folds the exclusion tally into its final line. A filter that
  discards silently is the same failure mode as a parser that returns zero —
  an ingest that exits 0 having stored less than it should looks exactly like
  one with nothing left to store.

The reject-lists are per-source because the boards are: work out what an
archive actually hosted before adding names, and prefer re-attributing a
site-local board (`ingest.site`) over deleting real posts.

**A mysqldump is not a format — the producing tool matters more than the
schema.** `desuarchive-sql` exists because the 2019 Desuarchive/RBT dumps have
the *same Asagi schema* `fuuka-sql` already reads, and are still unreadable by
it. They were written by `mysqlchump`, not mysqldump, which differs in four
ways, each independently fatal:

- `CREATE TABLE IF NOT EXISTS` — a pattern anchored on the plain form never
  registers the table.
- an explicit INSERT column list that **omits** columns the CREATE TABLE
  declares, so table order is not tuple order.
- values separated by `, ` rather than `,`. This one is the nastiest: a parser
  testing `line[i] === "'"` never sees the opening quote, treats the string as
  a bare value, and every comma *inside a comment* becomes a field separator.
  Silent corruption, not an error.
- **statements spanning many lines**, because comments carry literal
  unescaped newlines. Tuple extent is only knowable with quote state carried
  across lines (`takeCompleteTuples`), and a continuation line can itself
  start with `(`, so line-wise reading parses fragments of prose as rows —
  4.2% of "rows" in a sample slice.

Every one of those failed *silently*. Pointed at these dumps `fuuka-sql`
reported `0 posts from tables []`, and after a partial fix `0 posts from
tables [g]` — a table accepted, yielding nothing, indistinguishable from a
source whose posts were all already present. **Never judge an SQL ingest by
exit code; check the post count, the OP count and the timestamp nulls.** OPs
were 0 and multi-line bodies were 0 for a while after the rows started
landing, both from the same `, ` bug.

`chan-html` reads pages in 4chan's *own* markup — what whole-page archivers
(perma.cc, Wayback) capture. Three things about that format:

- Every post carries `data-utc`, a true epoch, so no timezone conversion.
  Rendered third-party archives generally do not: fybertech prints
  `04/08/08(Tue)03:16`, New-York wall time with no seconds, and needs
  `nyWallToUtc` like the SQL adapters.
- **The markup is emitted twice per post**, `postInfo desktop` and
  `postInfoM mobile`. A document-wide scan for `dateTime` or `nameBlock`
  double-counts everything; fields must be read within one `postContainer`.
- OPs put `.file` *before* `postInfo`, replies *after*, so nothing may depend
  on field order.

A rendered third-party archive is a different family and needs its own
adapter, even when it is also "HTML of a 4chan thread". `fybertech-html` is
that case: no `data-utc`, so its displayed `04/08/08(Tue)03:16` goes through
`nyWallToUtc`, and pre-2013 pages show no seconds (recorded as `:00`, never
guessed).

**One crawl can hold several markup generations.** fybertech's 638 pages are
420 classic (`td.reply`, OP loose at body level), 197 later (`div.post`), and
20 in 4chan's *own* markup. Two habits follow:

- Survey the whole tree before writing the parser, not one file. A single
  sampled page missed two of those three variants, and within the classic one
  some pages wrap the date in `span.posttime` while others leave it a bare text
  node — that difference alone silently nulled 7834 timestamps (5.4%).
  Not every page even has a `<body>` element.
- **Each adapter skips what belongs to the other**, so one staged directory can
  feed both (`fybertech` + `fybertech-native` point at the same `out/`).
  `chan-html` skips pages with no `.postContainer`; `fybertech-html` skips
  pages that have one.

Assert on zero, not on a percentage: "timestamps parsed for nearly all" passed
at 5.4% missing. Every fybertech post displays a date, so any null is a parse
gap, and the test now demands none.

`posts` is keyed `UNIQUE (site, board, post_no)` — one row per post, not one
per (post, archive). Ingest is therefore idempotent both ways: re-running a
source skips what it already contributed, and a source holding a post another
archive already supplied adds nothing. `source_id` records which archive got
there first.

This means **queries need no dedup logic** — a plain `COUNT(*)` is correct.
The store previously kept a copy per archive, and on the current corpus 34.8%
of rows (197M of 566M) were such copies, silently multiplying every
aggregate. `dedupe` migrates a store built under the old constraint.

The cost is that archive overlap is no longer answerable from the database.
That is deliberate: infer it by diffing the source datasets, which reflects
what each archive actually contains rather than ingest order.

**Order does not affect coverage — every source is always worth ingesting.**
Each adapter scans every post in every page it is fed, and the constraint
rejects only post numbers already stored, so a partial capture never blocks a
fuller one: ingesting a truncated board index and then the full thread stores
all of the thread's posts, and so does the reverse. Missing replies get filled
in whenever the source that has them arrives.

What order *does* decide is which **copy** of a post is kept, for posts that
appear in more than one source — first writer wins, and the loser's row is
discarded rather than merged. That only matters where two sources disagree
about the same post: if a format truncates the post *body* (4chan's board
index abbreviates long comments with a "Comment too long" marker), the copy
stored first is the copy you keep. So prefer the fuller source first when a
capture abbreviates bodies, and otherwise ignore order.

`source.capture` is where "what did this capture actually contain" is
recorded; `perma_cc_x9pp-ycvx` is the worked example.

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

`effective_io_concurrency` is the one cheap lever — it controls how deeply a
bitmap heap scan prefetches. Measured across four terms, alternating the
setting so a warming trend could not pass for an improvement: 1.77 and 2.16
ms/block at the default 16, against 1.58 and 1.28 at 256, i.e. ~27% off. Worth
setting; not a fix. `io_method` is `worker` here, so prefetch depth is also
capped by `io_workers` (default 3) — raising that needs a cluster restart and
has not been tried.

## Conventions

- Manifest `prepare` steps must be idempotent and are skipped when `out/`
  exists (`--force` re-runs). Prefer `cp -al || cp -a` (hardlink, fall back to
  copy) for staging rather than symlinks: `ingestInputs` globs real files, and
  symlinks break when the tree is read over a different mount.
- A step prefixed `local:` runs on this machine rather than the target, for
  work needing Node (the NAS has none). It gets `$PROJECT` (repo root), `$CLI`
  (absolute path to cli.ts), `$DIR` (dataset dir as the target sees it) and
  `$TARGET` (flags reproducing the current runner). Use `$CLI` rather than
  spelling out the package path, so manifests survive the code moving.
- `list manifests` `s/e/o` column shows which stage dirs are non-empty — the
  quickest way to see where a source actually is.
- Record non-obvious facts about a source in `source.capture` (free text, not
  parsed), e.g. whether a WARC captured a full thread or a truncated board
  index. That distinction determines what an adapter can trust.
