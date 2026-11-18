# PR tabs and a Files changed view

Status: reviewed once (Opus), findings folded in; awaiting the owner's approval. Date: 2026-11-16.

Mockup (private to the repo owner): https://claude.ai/artifact/Cbuwhncbc5U9tRfeNd1NKg

## Why

The mod's PR screen shows whether a PR can merge and its conversation, but
not its code. To read a diff or a review thread you leave Herdr for
github.com. The goal is to read a PR's files and its review threads inside
the popup, moving with the keyboard only, fast.

This fork (`joshvera/herdr-github`, upstream `mrolafsson/herdr-github`) adds
that. A later version will write as well (reply, resolve, submit a review,
and show a review while it is still pending). This version must not make
that harder.

## Goals

1. The PR screen has three tabs: Overview, Checks, Files changed.
2. Files changed shows the changed files as a tree, one file's diff, and the
   review threads on that file between the lines they are on.
3. Every move is one key: next line, next file, next thread, next unviewed
   file, mark viewed.
4. It works for any PR the list can show, without a local checkout. On this
   computer it works from a local build; on other connected machines it
   works once the fork has a release (see Finding the binary).
5. The demo (`"demo": true`) shows all of it on made-up data.

## Not in this version

- Replying to, resolving or starting a thread; submitting a review.
- A Commits tab, and filtering the diff by commit.
- Syntax colour in the diff.
- Side by side diffs. Unified only.
- The TUI picker (`tui.go`). It keeps working unchanged; it gets none of this.

## Must not happen

- A key that merges, changes draft state, or deletes anything firing while
  the Files tab is shown. `m` and `d` do nothing there.
- A diff or thread from one head commit shown against another. Everything
  on the Files tab is from one head commit, and says so when it is stale.
- Text from GitHub reaching the mod unsanitized. Every string goes through
  `clean`, as today.

## The parts

```
mod (app/mods/github, JavaScript)          binary (Go)                GitHub
  main.js  PR screen, tabs, Overview  -->  app.go  ops               GraphQL
  files.js Files changed view         -->    files / diff / act  --> REST pulls/N/files
                                           cache: diffs by head commit
```

The mod never talks to GitHub. It asks the binary, one process per request,
JSON in and JSON out, as it does today (`ask` in `main.js`, `appAnswer` in
`app.go`).

## Ops

All three take `pr` (`prID`: host, repo, number) as `detail` does, and
`demo`. Errors come back as `{"error": …}` as today.

### `files`

Request: `{"op":"files","pr":{…}}`

Answer:

```json
{
  "head": "9f2c…",
  "files": [
    {
      "path": "backend/api/app/models/profile.rb",
      "from": "",
      "status": "modified",
      "additions": 12,
      "deletions": 3,
      "viewed": "unviewed",
      "threads": 1,
      "open": 1
    }
  ],
  "threads": [
    {
      "id": "PRRT_…",
      "path": "backend/api/app/models/profile.rb",
      "subject": "line",
      "line": 13,
      "side": "right",
      "startLine": 0,
      "startSide": "",
      "originalLine": 13,
      "hunk": "",
      "resolved": false,
      "outdated": false,
      "comments": [
        {
          "id": "PRRC_…",
          "author": "someone",
          "body": "Markdown, sanitized",
          "created": 1794840000000,
          "state": "submitted",
          "url": "https://github.com/…"
        }
      ]
    }
  ],
  "more": false
}
```

- `head`: the PR's head commit (`headRefOid`). The mod passes it back to
  `diff` and to `act`.
- `files`: in GitHub's order (path order). `status` is one of `added`,
  `modified`, `deleted`, `renamed`, `copied`, `changed`. `from` is the old
  path of a rename or copy, else `""`. `viewed` is `viewed`, `unviewed`, or
  `dismissed` (viewed, then the file changed). `threads` and `open` count
  this file's threads, all and unresolved.
- `threads`: every review thread on the PR, in file order then line order.
  - `subject` is `line` or `file` (GitHub's `subjectType`). A `file` thread
    is about the whole file and has `line: 0`.
  - `side` is `right` (the new file) or `left` (the old one). `line` is the
    line on that side the thread ends on, or `0` when GitHub gives none.
  - A multi-line thread has `startLine` and `startSide` (which can differ
    from `side`). GitHub returns `startLine == line` for a single-line
    thread: the binary turns that into `startLine: 0`, `startSide: ""`.
  - `outdated` does not mean "no line": an outdated thread can still have
    one. `originalLine` is the line it was first left on. `hunk` is the
    first comment's `diffHunk`, sent only when `line` is `0` and `subject`
    is `line`, so the mod can show what the thread was about.
  - Placing a thread: `left` matches a row's `old`, `right` matches a row's
    `new`; the thread goes after the row matching `line`. A thread that
    matches no row (no line, patch missing, binary, rows cut off) is listed
    under the file's header, with "line N" when it has one.
- Comment `state` is `submitted` or `pending`. `pending` is the signed-in
  person's own unsent review comment. Nothing writes these yet, but GitHub
  returns them, and the mod draws them differently. This is the hook for the
  later review work: do not drop the field.
- `more`: true when the PR has more files, threads, or comments in a thread
  than were fetched (see Limits). Per-file counts are then lower bounds. The
  mod says so and offers `o` (open on GitHub).

Source: GraphQL, a new query (not `detailQuery`, which stays as it is).
`pullRequest.files` (`path`, `additions`, `deletions`, `changeType`,
`viewerViewedState`) and `reviewThreads` (`id`, `isResolved`, `isOutdated`,
`path`, `line`, `startLine`, `diffSide`, comments with `id`, `author`,
`body`, `createdAt`, `state`, `url`), plus `subjectType`, `startDiffSide`,
`originalLine` and the first comment's `diffHunk`. The reviewer checked
these names against the live schema, except the four just listed: check
those. Not verified: whether `reviewThreads` returns the viewer's own
pending threads. Find out on a real PR and say what you found.
The old path of a rename comes from the REST files answer
(`previous_filename`), which `files` therefore also fetches (and caches, see
`diff`).

### `diff`

Request: `{"op":"diff","pr":{…},"path":"…","head":"9f2c…"}`

Answer:

```json
{
  "head": "9f2c…",
  "path": "…",
  "state": "ok",
  "rows": [
    { "kind": "hunk", "text": "@@ -0,0 +1,29 @@" },
    { "kind": "add", "new": 1, "text": "module Onboarding" },
    { "kind": "del", "old": 7, "text": "…" },
    { "kind": "ctx", "old": 8, "new": 2, "text": "…" }
  ]
}
```

- `state`: `ok`; `binary` (no text diff); `large` (GitHub left the patch
  out); `empty` (a rename or mode change with no lines); `stale` (the
  PR's head is no longer `head`: the mod reloads `files`). `rows` is empty
  unless `ok`.
- REST's `patch` is optional and GitHub does not say when it is left out.
  The rule for a file with no patch: `changes == 0` and status renamed,
  copied or changed is `empty`; `changes == 0` otherwise is `binary`;
  `changes > 0` is `large`. This rule is a guess: check it on a real PR
  with a binary file and a pure rename.
- Sanitizing: `sanitize` flattens every field not named `Body` to one line
  and always drops `\r` (`sanitize.go`), and today it only runs inside
  `graphql`. So parse the raw patch into rows first, expand tabs, then
  `clean` each row's text. Everything else in the REST answer is sanitized
  as GraphQL answers are.
- Rows are parsed in Go from the file's patch, so it is tested there. Tabs
  are expanded to 4-column stops and a line over 4000 characters is cut with
  a marker, as the app's Changes mod does. At most 5000 rows per file; past
  that, `state` is `large`.
- `\ No newline at end of file` is a row of kind `note`.

Source: REST, `GET /repos/{owner}/{repo}/pulls/{number}/files`, 100 a page,
every page. The API base is `https://api.github.com` for github.com and
`https://{host}/api/v3` for a GitHub Enterprise host; derive it where
`endpointFn` derives the GraphQL one, with a test seam like it. Same token,
same `User-Agent`, same sign-out handling as `graphql`.

That endpoint cannot be asked for one file, always serves the PR's current
head, and does not say which head that is. Every op is a new process. So:

- A fetch reads `headRefOid` (GraphQL) before the first REST page and after
  the last. Only if both are the same is the result written, to
  `stateDir()/diffs/<key>-<head>.json` under that head. If they differ,
  nothing is written and the answer is `stale`. `files` checks `headRefOid`
  is the same on every GraphQL page too.
- `diff` with a `head` that has a cache file answers from it with no network
  call. Without one it fetches as above, and answers `stale` if the head it
  found is not the one asked for.
- Each cache file is written through `os.CreateTemp` in the same folder and
  renamed, mode 0600. `cache.go`'s fixed `.tmp` name and in-process mutex do
  not protect separate processes; do not reuse that pattern here.
- After writing, delete the same PR's files for other heads only when they
  are older than the one just written (a slow process for an old head must
  not delete the new head's file), and any cache file older than 7 days.

Routing: `appAnswer` runs `byNumber` and then the full `detail` query before
its op switch. `files`, `diff` and `act viewed/unviewed` branch off before
`detail`; they need only the PR's node ID and head, from `byNumber` or a
query of their own.

### `act`: `viewed`, `unviewed`

Request: `{"op":"act","do":"viewed","pr":{…},"path":"…"}`

Request also carries `head`. GraphQL `markFileAsViewed` /
`unmarkFileAsViewed` take only the PR's node ID and the path, so the binary
compares `head` with the current `headRefOid` itself and answers
`{"error": …, "stale": true}` without calling the mutation when they differ.
Otherwise it answers as other `act`s do. `appRequest` reuses `Path` (it
exists for `unworktree`) and gains `Head`.

### `detail`

Unchanged, except `appDetail` gains nothing: the Overview has what it needs
(`threads`, `checkList`, `reviewers`, `files`).

## Limits

- Files: 3000 (REST's own cap). Threads: 300. Comments per thread: 50.
  Page GraphQL connections until done or the limit; past any of them,
  `more: true`.
- One `diff` answer is capped at 2 MB of row text; past that, `state` is
  `large`. (Whether the app's `exec` caps stdout is not known.)
- A PR whose REST files fetch fails still answers `files` from GraphQL, with
  `from` empty; `diff` then answers the error.

## The `source` interface

`source` gains `files`, `diff` and `setViewed`. `githubSource` implements
them with the client; `demoSource` with made-up data: at least one demo PR
has a handful of files across two folders, an added file, a renamed file, a
binary file, a resolved thread, an open thread with two comments, and one
`pending` comment. Demo `setViewed` changes the demo's saved state, as demo
`setDraft` does.

## The mod

### Finding the binary

Today the mod downloads release `GITHUB_VERSION` from `mrolafsson`'s
releases. Change:

1. If `mods/github/dev.json` exists in the app's home (`appHome()`) and has
   `{"bin": "/absolute/path"}`, requests on this computer (machine `null`)
   run that file. Other machines download as before. `dev.json` is local
   only: not in the repo's `app/mods/github/`, and ignored by git.
2. Otherwise download from `joshvera/herdr-github`'s releases, same
   checksum check, into a folder of the fork's own
   (`~/.local/share/herdr-github/app/joshvera-<version>/`), so a fork build
   never collides with an upstream one of the same version.

The fork has no releases yet and this work publishes none. Until it does,
only this computer (through `dev.json`) has the new ops. When a binary
answers that it does not know `files`, the Files tab says the machine's
herdr-github is too old for it, and everything else keeps working.

The version check between mod and binary (`TestAppVersionIsThePlugins`)
stays. Version numbers and the first fork release are a separate, later
decision; do not tag or publish anything.

### PR screen

- A tab strip under the title: Overview, Checks (count), Files changed
  (count). Keys `1` `2` `3`; `tab` and `shift-tab` cycle.
- Overview: the readiness line, then a three-part strip (checks passing /
  failing / skipped as a bar; unresolved threads; approvals), the
  description, and at the right the agents, reviewers, Linear issue and
  worktree state the screen shows today. Every existing key keeps its
  meaning.
- Checks: the check list the screen has today, moved to its own tab.

### Files changed (`files.js`)

Layout: file tree at the left (about 290 px), the open file's header and
diff at the right. See the mockup's second board.

- Tree: folders collapsed into the longest shared path, as GitHub does.
  Each file has its status letter, an open-thread count, and a viewed mark.
  `/` filters by path.
- Diff: rows in a virtual list (`v_virtual_list`), as the app's Changes mod
  draws them (`~/.config/herdr-app/mods/changes/main.js`): line number, sign,
  text, mono, tinted by kind. One row is the cursor.
- Threads: after the row a thread's `line` and `side` name, a block with its
  comments (author, age, Markdown body). Resolved threads are folded to one
  line; `enter` on one unfolds it. Outdated threads say so. A `pending`
  comment is marked "pending, not sent". Virtual lists need each row's
  height up front: measure or estimate thread blocks, and if that cannot be
  made right, draw the open file's rows in a plain scroll area instead.
  That choice is the builder's. What the reviewer found: `list` measures
  rows of unequal height but cannot be scrolled to the cursor, the
  scroll-to-item handle belongs to `v_virtual_list`, and a plain scroll
  area with thousands of rows is likely slow. A workable shape is
  `v_virtual_list` with thread blocks folded to a fixed height.
- On landing on a file with no cached diff, show the file header at once
  and the rows when `diff` answers. Fetch the next file's diff ahead.

Keys on this tab:

| Key | Does |
|---|---|
| `j` `k`, `↓` `↑` | cursor down, up a row |
| `]` `[` | next, previous file |
| `n` `p` | next, previous unresolved thread, across files |
| `u` | next unviewed file |
| `v` | toggle viewed on the open file, then `u` if it became viewed |
| `enter` | fold or unfold the thread under the cursor |
| `/` | filter files |
| `o` | open the file's diff on GitHub (the thread's `url` when on one) |
| `y` | copy that link |
| `r` | reload `files` and the open diff |
| `1` `2` `3`, `esc` | tabs; back |

While the `/` filter has focus, keys type into it: `esc` leaves the filter
(not the screen), and `left`, `backspace`, `1` `2` `3` and `tab` do not
navigate. The keystroke names the app uses for `]`, `[`, `/` and
`shift-tab` are not documented: find them, and say if one cannot be bound.
`u` treats a `dismissed` file as unviewed; `v` on one marks it viewed.

`c`, `x` and `h` are reserved for reply, resolve and hand to an agent. They
do nothing now. `m`, `d`, `w`, `s`, `a`, `l` do nothing on this tab.

The footer lists the keys, as every screen's does.

## Tests

- The fake GitHub points every host at one server (`helpers_test.go`); REST
  needs its own seam there, and `Link`-header paging in the fake.
- Go, against the repo's fake GitHub (`github_test.go`): `files` paging and
  limits; thread anchoring fields; `pending` state carried; REST paging,
  the Enterprise base URL, sign-out; patch parsing (added, deleted, renamed
  with and without changes, no newline at end, binary, missing patch,
  a hunk header with a section name, CRLF); the cache (written once, read
  after with no request made, not written when the head moves during the
  fetch, pruning that spares a newer head's file, `stale` on a head
  mismatch); thread shapes (single-line, multi-line across sides, outdated
  with and without a line, file-level); the no-patch rule; a patch's line
  breaks surviving sanitizing; `viewed` and `unviewed`, and their refusal on
  a stale head.
- Go, on the demo: `files`, `diff`, `act viewed` through `runApp`, as
  `app_test.go` does for the existing ops.
- Mod: `herdr-app check` on the installed copy. That only loads the first
  frame, so the Files tab must also be tried by hand in the app on the demo
  and on a real PR. Say in the handoff which of those was done.

`go test ./...` and `go vet ./...` pass before and after.

## Left open for later, checked

Thread `id`, `path`, `line`, `side` and comment `state` are enough to build
reply, resolve and new threads on. Submitting a review will also need the
viewer's pending review ID; adding that field later changes nothing here.

## Approaches considered

1. **New ops in the binary (chosen).** One data path, one place for the
   token, works on remote machines, and later writes are more ops. Costs a
   way for the mod to run a fork's build.
2. **The mod calls `gh api`.** No Go change, but a second data path with its
   own paging, errors and sign-in, which grows with every write.
3. **`git diff` in a local worktree.** Fast and reuses the Changes mod, but
   only for PRs checked out locally, and threads still need GitHub.

## Left to the builder

- The names of Go types and functions, and how the new code is split across
  files.
- Exact sizes, spacing and colours, within `look.js`'s tones.
- Whether thread blocks live in the virtual list or a plain scroll area.
- How far ahead diffs are fetched.

## Build order

1. Go: `files`, `diff`, `act viewed/unviewed`, cache, demo data, tests.
2. Mod: `dev.json` lookup, tabs, Overview, Checks tab.
3. Mod: Files changed.
