# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Node comes from the flake devShell — there is no `node` on PATH otherwise, so
every command needs `nix develop --command` (or an already-entered shell):

```sh
nix develop --command npm run typecheck    # tsc, the only build/lint gate
nix develop --command node src/cli.ts <command> [...]
```

There is no test suite. `typecheck` is the only automated check; verify
behaviour by running CLI commands against real sources (`--dry-run` first).

`.ts` files run directly under Node 24 type stripping. That means **no
TypeScript syntax that emits code**: no enums, no namespaces, and no
constructor parameter properties (`constructor(readonly x: string)`). tsc has
`erasableSyntaxOnly` on and will reject them.

## Architecture

A CLI that ingests heterogeneous 4chan archive dumps into one SQLite database
with FTS5 search. Everything is driven by committed per-source manifests.

### The manifest registry

`sources/<id>.json` is the unit of configuration; `src/manifest.ts` parses it.
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

### The staging pipeline

`source/` → `extracted/` → `out/`, all under the manifest's `dir`.
`download` fills the first, `prepare` produces the rest, `ingest` reads `out/`.
Sources stop at different stages, which is why `ingest.path` is explicit
rather than derived.

### The runner abstraction

The archives live on a NAS. Running staging over the SMB mount pays a network
round-trip per file operation, so `src/runner.ts` routes commands either
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
- **Never check paths through the local mount** when the runner is remote. The
  gvfs mount drops periodically ("Transport endpoint is not connected"); stage
  checks go through `runner.exec` for this reason.

### Adapters

One per archive format in `src/adapters/`, sharing only low-level helpers
(`src/ingest.ts` `PostInserter`, `src/mysqldump.ts` tuple parsing). Keep them
separate even when formats look similar.

`src/mysqldump.ts` also holds the Fuuka-family timestamp fix: Asagi/Fuuka
store `timestamp` as America/New_York wall time, not UTC, so it is converted
back on ingest.

Ingest is idempotent per source name (`UNIQUE (source_id, site, board,
post_no)`), and `count`/`search` dedupe across overlapping archives by
`(board, post_no)`.

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
checksum — it is excluded from verification in `src/archive-org.ts`.

## Conventions

- Manifest `prepare` steps must be idempotent and are skipped when `out/`
  exists (`--force` re-runs). Prefer `cp -al || cp -a` (hardlink, fall back to
  copy) for staging rather than symlinks: `ingestInputs` globs real files, and
  symlinks break when the tree is read over a different mount.
- A step prefixed `local:` runs on this machine rather than the target, for
  work needing Node (the NAS has none). It gets `$PROJECT`, `$DIR` and
  `$TARGET`.
- `list manifests` `s/e/o` column shows which stage dirs are non-empty — the
  quickest way to see where a source actually is.
- Record non-obvious facts about a source in `source.capture` (free text, not
  parsed), e.g. whether a WARC captured a full thread or a truncated board
  index. That distinction determines what an adapter can trust.
