# Plan: PR tabs and a Files changed view

Spec: `docs/specs/2026-11-16-pr-files-view.md` (approved; post-review fixes
not re-reviewed). This plan settles what the spec leaves open or gets wrong,
then orders the work.

## Checked before building

- Schema (live github.com, 2026-11-16): `PullRequestReviewThread` has
  `subjectType` (LINE, FILE), `startDiffSide`, `originalLine`, `diffSide`
  (LEFT, RIGHT), `startLine`, `line`; `PullRequestReviewComment` has
  `diffHunk`, `state` (PENDING, SUBMITTED), `url`, `createdAt`;
  `PullRequestChangedFile` has `path additions deletions changeType
  viewerViewedState` (DISMISSED, VIEWED, UNVIEWED); `changeType` is
  ADDED, DELETED, RENAMED, COPIED, MODIFIED, CHANGED. `files` and
  `reviewThreads` page with `first/after`. The spec's four unverified names
  all exist.
- `herdr-app check app/mods/github` passes on the untouched worktree copy
  (run 2026-11-16), so the copy is checked without installing over the
  live mod. `go vet ./...` and `go test ./...` pass on the base commit.
- `exec` (`herdr.d.ts`) takes `timeout` in ms: default 30 000, max 600 000.
  Its stdout cap is not documented.
- No-patch rule, checked on real REST answers: a binary file (PNG added
  or modified, mrolafsson/herdr-github#2, #3) has `changes: 0` and no
  `patch` → `binary`; a pure rename (kubernetes/kubernetes#80027) has
  `changes: 0` and no `patch` → `empty`. `changes > 0` with no patch
  (`large`) was not seen; it stays the spec's guess. A renamed binary with
  no content change reads as `empty`, which is harmless.
- Keystroke names: the owner's `keys.json` binds `cmd-shift-]`,
  `cmd-alt-[`, `cmd-/`, so bare keys are spelled `]`, `[`, `/`; nothing
  binds them bare globally. One installed mod already matches
  `shift-tab`. Still to confirm in the running app.
- Pending threads: `reviewThreads` does return the viewer's own pending
  threads. Checked on a pending line comment the owner left on
  get-starlight/fusion-core#750: comment `state: PENDING`, `line: 2`,
  `diffSide: RIGHT`, `subjectType: LINE`. The built binary's `files` op
  carried it as `"state":"pending"` (1.8 s), and the follow-up `diff`
  answered from the cache in 14 ms with no request; the thread's `right`
  line 2 matches the added row `new: 2`.

## Decisions on gaps in the spec

1. **Head moving during `files`.** The spec says `files` checks
   `headRefOid` on every GraphQL page but not what it answers when it moves.
   It restarts once from the first page; if it moves again, it answers an
   error ("the PR changed while loading; press r"). The REST part follows the
   cache rule: written only if `headRefOid` read before the first REST page
   and after the last match the GraphQL head; otherwise `from` stays empty
   for that answer (not an error: renames lose their old path only).
2. **`files` and the cache.** If a cache file for the GraphQL head exists,
   `files` takes `from` from it and makes no REST call.
3. **`diff` that finds another head.** The fetched rows are still written
   under the head that was found (both reads agreed), and the answer is
   `stale`. The next `files` then gets that file for free.
4. **Cache key.** `slug(host_owner_name_number)` so a key is one path
   segment; `-<head>.json` after it. Pruning matches on the `<key>-` prefix
   and a 40-hex head, never a looser glob.
5. **"Older" when pruning** is not "older than the file just written" (a
   slow process for an old head writes last). A writer records `before`,
   the wall-clock time of its first head read, and after writing deletes
   the same PR's other-head files whose mtime is earlier than `before`.
   A newer head's file was confirmed after our `before`, so it survives.
   Plus anything in `diffs/` with mtime older than 7 days. One clock: real
   time and real mtimes (`nowFn` is frozen in tests); tests set mtimes
   with `os.Chtimes` and build the interleaving (B written after A's
   `before`, then A written; B survives).
6. **Comments per thread** are fetched `first: 50` inside the thread page,
   not paged further; `comments.pageInfo.hasNextPage` sets `more`.
7. **`act viewed` without `head`** is an error, not a skipped check.
   `head` from a request must match `^[0-9a-f]{40}$` (or 64 for SHA-256
   repos) before it is used anywhere, path included; otherwise an error.
8. **Row text cap** is counted after tab expansion and cleaning.
9. **Too-old binary.** An old binary answers `{"error":"no op \"files\""}`;
   the mod matches that text for `files`/`diff` and shows "this machine's
   herdr-github is too old for Files changed".
10. **30 s exec ceiling.** The mod passes `timeout: 120000` to `exec` for
    `files` and `diff` (spec's "same as today" otherwise). No job needed.
11. **`diffHunk` keeps its line breaks.** `sanitize` flattens every field
    not named `Body`. Add `DiffHunk` to `multiline` in `sanitize.go`, with
    a test that a hunk keeps `\n` and loses escapes.
12. **Routing order.** (See also R-M11/M13 below.) A `diff` with a cached head answers before
    `byNumber` (no network at all). `files`, uncached `diff` and `act
    viewed/unviewed` use one small query of their own for node ID and
    `headRefOid` (`files` gets both from its own first page); the `PR`
    list fragment is not widened.

## Lanes

### Lane A: Go (Sonnet, high effort)

Files (new): `files.go` (ops, GraphQL query, REST client, cache),
`patch.go` (patch → rows), tests `files_test.go`, `patch_test.go`.
Touched: `app.go` (routing, `appRequest.Head`), `source.go` (interface,
github impl), `demo.go` (demo PR data), `github.go` (`restEndpointFn` seam
beside `endpointFn`), `helpers_test.go` (REST seam, Link paging in fake).

Steps, each one commit:
1. `patch.go` + tests: parse a unified patch into rows (hunk, add, del,
   ctx, note), tabs to 4-column stops, 4000-char cut with marker, 5000-row
   and 2 MB caps → `large`, `clean` per row, CRLF. No-patch rule.
2. REST client (`rest`): base URL per host with a seam, token, User-Agent,
   401 → signed out, `Link` paging, raw body then targeted cleaning.
3. Cache: CreateTemp + rename, 0600, read by head, prune rules.
4. `files` GraphQL query and paging with limits and `more`; thread shaping
   (startLine == line → 0, hunk only for line-subject threads without a
   line, sort by file order then line).
5. Ops in `appAnswer` before `detail`: `files`, `diff`, `act
   viewed/unviewed` with the stale-head refusal.
6. Demo: a PR with the spec's minimum set; `setViewed` persisted in
   `app-demo.json`.
7. Tests through `runApp` on the demo; `go test ./...`, `go vet ./...`.

### Lane B: mod (Opus, high effort), after A's ops land

1. `dev.json` lookup and fork release URL/folder in `main.js`'s provision.
2. PR screen tabs (Overview, Checks, Files changed) with `1 2 3`, `tab`,
   `shift-tab`; Overview strip; Checks moved to its tab. Existing keys
   unchanged on Overview.
3. `files.js`: tree, diff in `v_virtual_list` with folded-height thread
   blocks, keys per the spec's table, prefetch of the next file's diff,
   stale handling, too-old binary message.
4. `herdr-app check app/mods/github` (the worktree's copy).
   Keep `const GITHUB_VERSION = "0.11.0"` verbatim (a Go test reads it).
   `escape` reaches the mod as the `github.escape` action (`keys.json`),
   not `on_key_down`: "esc leaves the filter" is handled there. Hand test needs the mod
   installed somewhere the app loads it: ask the owner first.

## Verification left to a real PR

- ~~Whether `reviewThreads` returns the viewer's pending threads.~~ Yes (above).
- The no-patch rule on a binary file and a pure rename.
- Keystroke names for `]`, `[`, `/`, `shift-tab`.

## Amendments after independent plan review

Review: Opus, fresh context, 2026-11-16 (1 Critical, 7 Important, 20
Minor). Accepted unless noted. These override the decisions above.

- **C1. Download stays upstream.** The fork has no releases, so pointing
  downloads at `joshvera/herdr-github` would break every machine without
  `dev.json`. This work adds only the `dev.json` override; the switch to
  the fork's releases and folder (spec "Finding the binary" item 2) waits
  for the first fork release. Deviation from the spec, called out in the
  handoff.
- **I1. The Files tab never falls through** to `prKey` or `menuKey`.
  Switching tabs closes any open menu; menus opened asynchronously (the
  cleanup menu after a merge) wait until Overview is shown.
- **I2. Demo heads are 40-hex.** Every demo PR gets a fixed 40-hex
  `headRefOid`.
- **I3. Stale is typed.** Go: a `staleError` that `appError` turns into
  `{"error": …, "stale": true}`. Mod: `AppError` carries `stale`.
- **I4. One cleaning path.** REST is decoded into a typed struct (patch
  raw). The cache stores the raw REST data (filename, previous_filename,
  status, changes, sha, patch). Fresh and cached data both reach the
  answer through one function that parses then `clean`s each row and
  `clean`s every other string. REST error messages are cleaned too.
- **I5. REST names its head.** Each non-removed file's `contents_url`
  carries `?ref=<sha>`. Every REST page is checked against the GraphQL
  head; a mismatch refuses the write (answer `stale` for `diff`, empty
  `from` for `files`). Unverified on Enterprise: a file with no `ref`
  passes this check and leaves the before/after reads as the guard.
- **I6. No duplicate full fetches.** The mod asks `diff` only after
  `files` answered, allows one uncached fetch per head at a time, keeps
  answered diffs in memory, and remembers a fetch error until `r`.
- **I7. Keys.** Add `tab`/`shift-tab` (and any other key the app eats)
  to `app/keys.json` as `mod:github` actions if `on_key_down` does not see
  them. Escape is handled in both `on_key_down` and `github.escape` today:
  make leaving the filter idempotent so one press never also leaves the
  screen. Confirm in the running app.
- **M3.** Head pattern `^([0-9a-f]{40}|[0-9a-f]{64})$` everywhere.
- **M4.** Cache key lowercased.
- **M5.** A missing or corrupt cache file is a miss, never an error.
- **M6.** `diff` for a path not in the head's file list: an error naming
  the path.
- **M7.** No-patch rule reads REST statuses (`added removed modified
  renamed copied changed unchanged`). `sha` of the empty blob
  (`e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`) or `unchanged` → `empty`.
- **M8.** `diffHunk` only on an aliased `comments(first: 1)`.
- **M9.** REST paging builds `?per_page=100&page=N` itself; `Link` only
  says whether there is a next page. The token never follows a URL GitHub
  hands back.
- **M10.** Tab stops count from after the `+`/`-`/space marker.
- **M11.** Demo never touches `stateDir()/diffs`; the cached-`diff` fast
  path checks `req.Demo` first.
- **M12/M13.** `files`, `diff`, `setViewed` on `source` take the PR as
  `repoRef` + number (plus `head`, `path`), never a `pullRequest` from
  `byNumber`. Demo `setViewed` is saved through `appDemo.save`.
- **M14.** `ask` takes `exec` options; a timeout is an error shown to the
  person, not "machine went away" (no `findGitHub` retry).
- **M15.** `o` uses `…/pull/N/files#diff-<sha256 hex of path>`
  (`crypto.createHash` in mods).
- **M16.** Accepted race: the head can move between the viewed check and
  the mutation (GitHub's mutation takes no head). Documented in code.
- **M17.** Lane B steps 1-2 run in parallel with Lane A (disjoint files).
- **M18.** `.gitignore` gains `app/mods/github/gpui-kit.d.ts` and
  `app/mods/github/jsconfig.json` (written by `herdr-app check`).
- **M19, ruling:** the owner routed Lane A to Sonnet explicitly; that
  stands. Its task review runs on Opus at high (cross-process cache,
  sanitizing boundary).
- **M1.** Thread blocks: estimated height from wrapped text at the list's
  measured width for open threads, one line for folded ones; the builder
  may cap long ones with "enter for all".

## Ruling after the final review

- **I6 holds per view, not per head.** Reopening the same PR while its
  first `files` is still out can run a second load for that head. That
  costs one duplicate read and never mixes data. Sharing in-flight loads
  across views would add machinery for a rare path.
