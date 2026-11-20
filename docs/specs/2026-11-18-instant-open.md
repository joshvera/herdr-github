# The GitHub popup shows what it knows at once

Status: reviewed once (Opus, 2026-11-18), findings folded in. The fixes
have not been re-reviewed.

## Why

Pressing `cmd-g` should show pull requests immediately. Today it often shows
"Loading…" first. Measured on 2026-11-18 with the 0.11.0-joshvera.1 binary:

| Step | Takes |
|---|---|
| `status` (who is signed in) | 0.5 s |
| `list` for "Mine" | 4.5 s |
| `list` for "This repo" | 1.1 s |

A list cache already exists (`github-cache.json` in the app's folder, read by
`readCache` in `app/mods/github/main.js`). It leaves these gaps:

1. **The "This repo" tab waits.** `readCache` seeds only "Mine" and "Review
   requested" (`main.js:398`). The repo tab is seeded inside `load`
   (`main.js:419`), which runs only after `findGitHub` (a `status` process)
   and `findRepo` have both answered (`main.js:353-364`). The popup reopens
   on the tab you last used, so if that is "This repo" you wait every time.
2. **Opening a PR waits.** The Overview has no cache; every open asks
   `detail` and shows nothing until it answers.
3. **The cache is as old as your last visit.** Nothing refreshes while the
   popup is closed. This version does not fix that (see Not in this
   version), but it makes the wait for fresh rows start sooner.

## Goals

- With a cache on disk, the first frame drawn after the cache is read has
  rows on whichever tab the popup opens on. No process has to answer first.
- A PR you have opened before shows its Overview at once, marked as being
  refreshed, and is replaced when the fresh answer lands.
- Fresh lists are asked for the moment the popup opens, not after `status`.

## Not in this version

- **Refreshing while the popup is closed.** The platform has no background
  place for a mod. What exists (`~/.config/herdr-app/AGENTS.md:875-900`,
  `herdr.d.ts:405-414`):
  - A mod folder is one `main.js`; places are right, left, top, bottom,
    none. There is no hidden place.
  - A mod in a layout block "starts the first time it shows, then stays
    alive while its block is in the layout", timers running while hidden,
    and "another layout starts its mods fresh". So it would need a block in
    the user's own cloned layout (Herdr's shipped layouts are replaced on
    every start), shown once, and it dies on a layout switch.
  - A kept window (`openOverlay({kind:"window", keep:true})`) reopens on
    start but is visible.
  - The plugin's space labels are TUI-only and event-driven, not a timer.
  Building this needs a decision from the user about editing their layout.
  It is left out; nothing here should make it harder to add.
- Caching the Files changed tab's file list across openings (diffs are
  already cached on disk per head by the binary).
- Fetching every PR's detail ahead of time.
- Any change to the binary.

## Must not happen

1. **Acting on old state.** While the Overview shown is from the cache,
   nothing that reads PR state on the client to decide what to do is
   offered or accepted. See "What a cached Overview may do" for the list
   and where the check lives.
2. **Old data that looks current.** Anything drawn from the cache has a
   quiet mark that it is being refreshed. If the refresh fails the mark
   becomes the error and the age ("from 14:02"), not a silent stale view.
3. **Another account's data.** See "Whose cache it is".
4. **Cached data replacing fresher data.** A cache read that finishes after
   a live answer never overwrites it, for lists (today's `seed` guard,
   `main.js:404`) and for details. A cached or warmed detail never changes
   a list row.
5. **Two writers losing each other's data.** Two copies of the popup can be
   alive at once (one opened by `cmd-g`, one opened on a PR from Recap or
   Linear). A write must not drop the other's newer entries.
6. **One repo's list cached as another's.**
7. **The checks rewriting the user's real cache.** `herdr-app check` runs
   the mod's init for real.

## Where shared state lives

`localStorage` is per mod copy (`AGENTS.md:980`, `1141`): a popup opened
with different props does not see the `cmd-g` popup's values. Anything two
copies must agree on goes in the cache files, not `localStorage`: the
machine that answered last (`on`), who is signed in, and the remembered
repo per space. (`tab` and `trees` stay where they are.)

## The cache files

Two files in the app's folder:

- `github-cache.json`: lists. Read on every open, so it stays small.
  ```json
  { "version": 2,
    "who": { "machine": "", "hosts": [{ "host": "github.com", "login": "joshvera" }] },
    "lists": { "mine": { "prs": [], "next": "", "saved": 1795017543 }, "review": {} },
    "repos": { "github.com/o/r": { "prs": [], "next": "", "saved": 0 } },
    "spaces": { "<key>": { "repo": "github.com/o/r", "saved": 0 } } }
  ```
- `github-details.json`: Overview answers, keyed by PR key, each with
  `saved` (when it was read). Read only when a PR is opened or warmed, not
  on open. Measured `detail` answers are 10 to 20 KB each; 50 of them in
  the lists file would slow the first frame and approach the 1 MiB limit of
  `readTextFile` (`herdr.d.ts:27`).

Rules for both:

- **Version.** Today's file has no `version`. Write `version: 2`. A file
  with a missing or other version, or one that does not parse, is ignored
  and replaced. Never an error on screen.
- **Writing.** The platform's `fs` has no rename (`gpui-kit.d.ts:22192`).
  Use herdr's compare-and-swap, `writeTextFile(path, text, expected)`
  (`herdr.d.ts:30-32`; `~/.config/herdr-app/mods/linear-board/main.js:201`
  shows the use): read the text, merge, write with the text just read as
  `expected`. On rejection re-read, re-merge and retry, up to 3 times, then
  give up quietly (the cache is a convenience).
- **One write at a time per copy.** Today three loads finishing together
  each call `keep` (`main.js:436`). Queue writes within a copy so they do
  not race each other.
- **Merge.** Union by key; for the same key the newer `saved` wins. Then
  apply caps and pruning to the merged result (pruning first would let the
  other writer's copy bring dropped entries back).
- **Caps.** Details: 50, oldest `saved` dropped first. A detail whose PR is
  merged or closed is dropped once its `saved` is more than a day old.
  `repos` and `spaces`: 30 each, oldest first.
- **Under `herdr-app check`.** No cache writes when `checking()` is true.

## Whose cache it is

`list` answers carry no login (`app.go:308`); only `status` says who is
signed in, one login per configured host (`app.go:483-507`). "Mine" and
"Review requested" search every configured host. So "who" is the machine
plus the set of (host, login) pairs from `status`.

- The whole of both files belongs to one who. Do not keep several accounts
  side by side.
- The first frame shows the files' data for the last-known who. That is
  what makes it instant, and it is the same trust today's cache already
  places in the cached login (`main.js:397`).
- `status` is asked on every open (it is not skipped because a login is
  cached). When it answers with a different who: clear every seeded list
  and every cached detail from the screen before the next frame, delete
  both files' contents, and load fresh.
- Signed out: seeded rows are cleared and the existing not-signed-in
  message shows. No rows from an account that is no longer signed in.

## Changes

### 1. Seed every tab from the cache before anything is asked

In `readCache`: seed "Mine" and "Review requested" as today, and seed "This
repo" from the remembered repo for the shown space.

- **The key for a space** is the machine plus the folder `findRepo` looks
  in (`place(s)`, `main.js:205-208`).
- **Remembered** means the repo `findRepo` last resolved for that key, or
  the one the user last picked with "Change repo" for it. A manual pick
  wins until the folder's remote changes.
- On open, seed the repo tab from `repos[remembered]` at once, and start
  the repo tab's load on the remembered repo without waiting for
  `findRepo`.
- When `findRepo` answers:
  - the same repo: nothing changes;
  - a different repo: replace what is shown, drop the in-flight answer for
    the old one, load the new one;
  - a real "no GitHub remote here": clear the tab, as today;
  - a failure (the machine did not answer; `exec` rejecting,
    `main.js:372-373`): keep the remembered repo and say nothing.
- **Capture the repo with the request.** Today `load` sends
  `this.repoSpec()` at request time (`main.js:430`) but `keep` stores under
  `this.repoSpec()` at answer time (`main.js:413`). Capture the spec when
  the request is made, store the answer under that spec, and drop the
  answer from the screen if it is no longer the current repo.

### 2. Ask for the lists without waiting for `status`

When `who.machine` is known from the cache, start the "Mine" and "Review
requested" loads on it at once, in parallel with `status` and `findRepo`.
`findRepo` only runs `git remote -v` and does not need GitHub
(`main.js:367-379`), so it runs in parallel with `status` too.

- Share one in-flight `findGitHub` promise: today `gh()` calls it when the
  login is empty (`main.js:342`), so three parallel loads would start three
  `status` searches.
- If a load answers signed-out, or the machine does not answer, fall back
  to today's `findGitHub` search and load again.
- If `status` then reports a different who, the answers from these early
  loads are dropped (see Whose cache it is).
- The rule that a load in flight is not started twice stays.

### 3. Cache the Overview

`openPR` reads `github-details.json`, shows a cached detail at once if
there is one, and asks for the fresh one as today. The path that opens
straight on a PR (`p.pr`, `main.js:279`) does the same.

- A cached detail sets only the shown detail and a `cached` flag. It does
  not go through `loadDetail`'s tail (`this.cur = {...}`, `replaceRow`,
  `main.js:546-547`), because `replaceRow` writes into every list and the
  next `keep` would save older fields over a fresher list row.
- The shown detail is replaced only by an answer whose request started
  after the shown one's. Compare request start times.
- When the fresh answer lands, replace the detail without resetting the
  tab, the Checks cursor or the scroll position.
- If the refresh fails: the cached Overview stays, the mark becomes the
  error and the age, actions stay refused, and `r` tries again.

### 4. Warm the detail the cursor rests on

On the list, when the cursor has rested on a row for 400 ms and that PR has
no cached detail newer than 2 minutes, ask `detail` for it and write it to
`github-details.json`. One at a time. Not in demo mode, not under
`checking()`.

- A warm answer goes to the file only. It touches the screen only if that
  PR is open with no fresher answer yet (the rule in change 3).
- Warming never opens a menu, never calls `act` and never changes a list
  row.

## What a cached Overview may do

The binary re-reads the PR before `act`, `worktree` and `delete-branch`
(`app.go:350-358`), so the risk is on the client, where a choice is built
from cached fields: `toggleDraft` picks its direction from `d.draft`
(`main.js:702`), `mergeMenu` builds its choices from `d.merge` and
`d.mergeWhy` (`main.js:709-719`), `cleanupMenu` reads `d.cleanup`
(`main.js:727`).

| While the Overview is cached | |
|---|---|
| Refused, with "Refreshing…" | `m`, `d`, the "Merge…" button, the footer's merge and draft pills, `mergeMenu`, `toggleDraft`, `cleanupMenu`, any `act` |
| Allowed | `o`, `y`, `r`, `a`, `l`, `1` `2` `3`, `tab`, enter on Checks, `w` and `s` (they resolve the PR in the binary), everything on the Files changed tab (it has its own fresh head) |

Clicks do not go through key routing: the "Merge…" button calls
`mergeMenu` directly (`main.js:1402-1405`) and the footer pills call
`worktree`, `mergeMenu` and `toggleDraft` directly (`main.js:1550-1553`).
So the check lives in one function (for example `canAct()`) that
`mergeMenu`, `toggleDraft`, `cleanupMenu` and the `act` caller each ask
first. A gate only in `prkeys.js` is not enough. Test that function.

## Tests

There is no JavaScript test harness in the repo: the pure modules
(`prkeys.js`, `filetree.js`, `diffitems.js`) were checked with scratch
scripts that were never committed. Add one:

- `node --test app/mods/github/test/*.test.mjs`, importing modules that
  have no imports of their own. Commit the tests.
- Add that command to the gate below and to `.github/workflows/test.yml`
  (a `setup-node` step pinned to a commit like the other actions).
- If `node` is not installed here, say so and ask; do not skip the tests.

Pull the cache logic into a module with no imports and test:

- Seeding: each tab from the cache; a live answer is never overwritten by a
  late cache read.
- Who: a different who clears lists and details; signed out clears rows.
- Merge on write: two writers with newer entries for different keys both
  survive; newer beats older for the same key; caps and pruning apply
  after the merge; a pruned entry is not brought back by the other writer.
- The write loop: a rejected compare-and-swap re-reads and retries; three
  rejections give up without throwing.
- Version missing, wrong, or file unparseable: ignored.
- Repo capture: an answer for repo A arriving after a switch to repo B is
  stored under A and not shown.
- `canAct()`: false while cached, false after a failed refresh, true after
  a fresh answer; and the callers named above ask it.
- Detail ordering: a warm answer older than the shown one does not replace
  it.

By hand, written into the report:

- Add a `console.log` of the time from init to the first render that has
  rows (say where that output appears), and report it before and after,
  for each of the three tabs.
- Quit and reopen the app, press `cmd-g` on each tab.
- Open a PR seen before: Overview at once; `m` and a click on "Merge…"
  both say "Refreshing…" until fresh, then work.
- Open a PR from Recap or Linear (the `p.pr` path): it uses the cache.
- Change repo, then reopen the popup in the same space.
- Sign out on a test host or machine: no rows from the old account.

## Approaches considered

- **Cache in the mod (chosen).** Builds on the cache that is already there
  and needs no change to the binary.
- **Cache in the binary** (`list` answers from disk at once and refreshes
  in a background job). The binary already has such a cache for the TUI
  (`cache.go`). But every answer still costs a process start and the mod
  would need a second call for the fresh list.
- **Background refresher in the layout.** See Not in this version.

## Left to the builder

- The look of the refreshing mark; follow `look.js`.
- Whether details live in one file or one file per PR, if one file proves
  awkward with compare-and-swap.

## Build order

1. The test harness, and the cache module with its file format, who, merge
   and write loop.
2. Changes 1 and 2 (lists at once). Measure before and after.
3. Changes 3 and 4 (Overview), with `canAct()`.

Each step ends with the checks passing: `gofmt`, `go vet`,
`go test -race -count=1 ./...`, `sh scripts/test-build.sh`,
`node --test app/mods/github/test/*.test.mjs`,
`herdr-app check app/mods/github`. An earlier commit (1e0ddfb) records
`herdr-app check` hanging once; if it hangs, report it, do not drop it.
