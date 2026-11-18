# Review actions on the Files changed tab

Status: reviewed twice (Opus, 2026-11-18). The second review's findings are
in "Amendments" at the end. **Where an amendment and the text above
disagree, the amendment wins.**
Builds on `docs/specs/2026-11-16-pr-files-view.md` (read it first: this spec
uses its ops, its head rules and its key table without repeating them).

## Why

The Files changed tab is read-only. To answer a comment, resolve a thread or
send a review you still leave Herdr for github.com. And when an agent drafts a
review for you (the `gh-review` skill adds comments to your pending review on
GitHub, one at a time, while you read), the tab shows those comments only
after you press `r`.

Two things fix that:

1. The tab follows the PR while it is open, so a pending review appears as it
   grows.
2. You can act on what you see: comment on a line, reply, resolve, edit or
   drop your own comments, and submit or discard the review.

## Words

- **Thread**: a review conversation anchored to a line (GitHub's
  `PullRequestReviewThread`).
- **Pending review**: your one unsubmitted review on a PR. GitHub allows one
  per person per PR. Its comments are visible only to you until you submit.
  It is pinned to the commit it was started on.
- **Composer**: the text box this spec adds for writing a comment.
- **Draft**: text in the composer that has not been sent to GitHub.
- **Mutation**: any request that changes something on GitHub. Every new
  `act` below is one.

Use these words with these meanings in code comments and in the interface.

## Goals

- A comment added to your pending review from anywhere (github.com, `gh`,
  the `gh-review` skill) shows on the tab within 15 seconds, without a key
  press, and without moving your cursor, your scroll position or what you
  folded.
- From the keyboard: comment on a diff line, reply to a thread, resolve and
  unresolve a thread, edit and delete your own comments, submit a review as
  Comment, Approve or Request changes (with or without comments), and
  discard a pending review.
- New comments and replies always go into the pending review, so they reach
  nobody until you submit. Three things are visible to others at once, and
  the interface says so where they happen: resolving or unresolving a
  thread, editing a published comment, deleting a published comment.

## Not in this version

- Publishing a single comment at once, outside a review. Everything new is
  pending. (Considered and cut: it adds a second error path, races a
  pending review appearing meanwhile, and its natural chord,
  `cmd-shift-enter`, is the app's `pane.zoom`.)
- Comments on a range of lines (reading them already works; writing one does
  not). Comments on a whole file. Suggestion blocks as anything but text you
  type yourself.
- Reactions, minimizing comments, re-requesting review.
- A comment-level cursor inside a thread: `e` and `shift-d` act on your
  latest comment in the thread.
- Handing a thread to an agent (`h` stays reserved).
- The TUI picker. It gets none of this.

## Must not happen

1. **A mutation sent twice.** No mutation is ever retried, by the mod or by
   the binary. A held key never sends. While a send is in flight nothing
   else can send. After an outcome that is not known, sending again needs
   an explicit second confirmation.
2. **A review submitted or discarded by accident, or for more than was
   shown.** Submit and discard each need a second, explicit step in a
   dialog that says what will happen and to how many comments, and they
   are refused if the review has changed since the dialog showed it.
3. **A draft lost.** Closing the composer, changing file, the popup
   closing, the app quitting or a failed send never loses typed text. Two
   stated exceptions: text typed in the last half second before a hard
   kill of the app, and the oldest draft when more than 50 are kept (the
   interface says so when it drops one).
4. **A comment on the wrong line.** A comment is placed only on a row of
   the diff the user is looking at, only when that diff is the PR's current
   head, and only when the pending review (if there is one) is on that same
   commit.
5. **The view yanked while reading.** Nothing automatic moves the cursor to
   a different thing, scrolls (beyond snapping to a row edge), unfolds or
   folds, reloads the diff, steals focus from the composer or a dialog, or
   replaces a draft.
6. **A false "sent".** The interface says a comment was sent only when
   GitHub answered with its ID, or a later read shows a comment by the
   viewer on that target whose ID had not been seen before the send.
7. **A guess about an unknown outcome.** When a mutation's outcome is not
   known, say exactly that and keep the draft. Never say "not sent" unless
   GitHub refused it.
8. **Threads from one head drawn on another head's rows** (the first
   spec's rule; this spec's polling must keep it).

## Ops

All through `herdr-github app '<json>'`, as today. The request field that
names an action is `do` (`app.go:40`), as for `viewed`.

New request fields on `appRequest`: `line`, `side`, `body`, `thread`,
`comment`, `reviewId`, `event`, `count`, and `head` (already there).

### Routing

Today every `act` except `viewed` and `unviewed` runs `byNumber` and the
full `detail` query before acting (`app.go:345-364`). The new `do` values,
and the `threads` op, branch off where `viewed` does (`appFilesOp`), before
`byNumber` and `detail`. They never run the detail query.

### `files` (changed)

Add to the answer:

```json
"pr": { "id": "PR_kw...", "mine": false, "state": "open" },
"review": { "id": "PRR_kw...", "body": "", "comments": 7, "commit": "abc123..." }
```

- `pr.mine`: the viewer wrote the PR (`viewerDidAuthor`).
- `review` is the viewer's pending review, or `null`
  (`reviews(states: PENDING, author: viewer)`); `commit` is the commit it
  is pinned to (`PullRequestReview.commit.oid`).

Add to each thread: `canReply`, `canResolve`, `canUnresolve`
(`viewerCanReply`, `viewerCanResolve`, `viewerCanUnresolve`).

Add to each comment: `mine` (`viewerDidAuthor`), `canEdit`, `canDelete`
(`viewerCanUpdate`, `viewerCanDelete`).

All of these fields were checked to exist on GitHub's schema, and the full
query costs 2 rate-limit points.

### `threads` (new)

The cheap poll. Request: `{"op":"threads","pr":{...}}`. Answer: `head`,
`pr`, `review`, `threads`, `more`, exactly as `files` gives them, and
nothing about files or diffs. One GraphQL request per page of threads (most
PRs need one); the first spec's thread limits apply.

### `act`: the new `do` values

| `do` | request fields | does | answers |
|---|---|---|---|
| `comment` | `head`, `path`, `line`, `side`, `body` | new thread on that line, in the pending review | `thread`, `comment` (IDs), `review` |
| `reply` | `thread`, `body` | reply in that thread, in the pending review | `comment` (ID), `review` |
| `resolve`, `unresolve` | `thread` | sets the thread's state | `resolved` |
| `edit` | `comment`, `body` | replaces the comment's body | `comment` (ID) |
| `delete` | `comment` | deletes the comment | `review` |
| `submit` | `reviewId`, `count`, `event`, `body` | submits that pending review | `url` |
| `discard` | `reviewId`, `count` | deletes that pending review and its comments | |

`review` in an answer is the pending review after the change, in the shape
`files` gives (or `null`).

**Every mutation, in the binary:**

- One HTTP request per mutation, never repeated. `ghClient.graphql` has no
  retry loop today (`github.go:363-433`); keep mutations off any path that
  gains one. `loadFiles` restarts a read once (`files.go:172-180`): that is
  a query and stays.
- An overall deadline of 20 seconds for the whole op (token fetch, reads
  and the mutation together). The mod waits longer than that (see "Calling
  a mutation"), so the binary always gets to answer.
- Outcome classes, and nothing else:
  - **ok**: GitHub answered with the data asked for.
  - **refused**: GitHub answered with an error that says it did not do it
    (a validation or permission error, `NOT_FOUND`, `FORBIDDEN`,
    `UNPROCESSABLE`), or the binary refused before sending. Answer
    `{"error": "..."}` as today.
  - **unknown**: the request was written and then any of: a transport
    error, the deadline, an HTTP 5xx, an answer with `errors` whose type is
    not a known refusal, or `errors` together with `data`
    (`graphql()` returns a partial error for that today,
    `github.go:406-422`; on a mutation it may have been applied). Answer
    `{"error": "...", "unknown": true}`.
  A failure before the request is written (no token, the pre-read failed)
  is **refused**, and says so.

**`comment`:**

- Reads the PR's `headRefOid` and the viewer's pending review first.
- Refuses with the existing `stale` error if `head` is not the PR's head.
- Refuses, with a message that says why, if a pending review exists and
  its `commit` is not that head ("Your pending review was started on an
  older commit. Submit or discard it to comment on the new one.").
- Refuses a `line`/`side` that is not a row of that file's diff at that
  head. The check goes through the source: the GitHub source reads the
  diff cache, and fetches the file's patch (the first spec's REST read) if
  the cache has none; the demo checks its own demo diff.
- If a pending review exists: `addPullRequestReviewThread` with
  `pullRequestReviewId` set.
- If none exists: `addPullRequestReview` with `commitOID: head` and that
  one thread, and no `event`, so the review is created pending and pinned
  to the head in the same request. No check-then-act.

**`reply`:**

- Reads the viewer's pending review first.
- If one exists: `addPullRequestReviewThreadReply` with
  `pullRequestReviewId` set. Always pass it, so a reply can never be
  published at once by GitHub's default.
- If none exists, a reply needs two mutations (create an empty pending
  review, then reply into it), because a draft thread cannot be a reply.
  If the first succeeds and the second is refused or unknown, the answer
  carries that class plus `review` (the new, empty pending review) and the
  message says an empty pending review was left behind. The mod's unknown
  flow then applies to the reply only.

**`resolve`, `unresolve`, `edit`, `delete`:** one mutation each. No head
check (they do not place anything).

**`submit`:**

- `event` is `comment`, `approve` or `request_changes`. `body` is
  optional.
- With `reviewId`: the binary reads that review first and refuses with
  "Your pending review changed (now N comments)" if it is gone, no longer
  pending, or its comment count is not `count`. Then
  `submitPullRequestReview` with `pullRequestReviewId`. Never use that
  input's `pullRequestId` form: it submits "any pending reviews".
- With `reviewId` empty (approve or comment with no pending comments): the
  binary reads first and refuses if a pending review exists. Then
  `addPullRequestReview` with `event` and `body`.
- `comment` with no body and no pending comments is refused before
  sending. Other refusals (approving your own PR, request changes without
  a body if GitHub requires one) are GitHub's, passed through.

**`discard`:** the same read-and-compare on `reviewId` and `count`, then
`deletePullRequestReview`.

**Bodies:** for `comment`, `reply` and `edit`, refuse empty or
whitespace-only bodies, and bodies over 65,536 characters, before any
request. Outbound bodies are sent as typed. Inbound text is cleaned as
today.

## The `source` interface and the demo

Add what the ops need to `source` (`threads`, `comment`, `reply`,
`setResolved`, `editComment`, `deleteComment`, `submitReview`,
`discardReview`, or fewer methods if that reads better).

Each op is its own process, so the demo cannot hold state in memory. Demo
review state (the pending review, threads and comments added, IDs handed
out, resolved flags) is saved in `app-demo.json` next to the demo's
`viewed` state (`demoChange`, `app.go:698-707`). The demo has: a pending
review that grows, permissions that differ per thread, one thread the
viewer cannot resolve, and a way to make a mutation answer `unknown`
(for example a body of exactly `!unknown`), so the mod's unknown flow can
be seen and tested without GitHub.

## The mod

### Calling a mutation

Today `gh()` (`app/mods/github/main.js:340-351`) catches most errors, runs
`findGitHub()` and asks again, and `ask()` throws a plain error when the
output is not JSON (`main.js:127-132`). A binary that died after sending
would have its mutation sent twice.

- Add one function for mutations. It calls the binary once, on the machine
  already chosen, never retries and never runs `findGitHub`. It passes an
  exec timeout of 45 seconds (the binary's own deadline is 20).
- It returns one of: ok (the answer), refused (the error text), unknown.
  Unknown is: the answer has `unknown: true`, or the exec timed out, or
  exec rejected after starting, or the output was not JSON.
- Every new `do` value goes through it. So does the existing `act` call
  (`main.js:681`, merges and the rest): move it over, and treat its
  unknown as "No answer. Check the PR before trying again." That is a fix
  to today's behaviour; say so in the report.

### Generations: ordering polls against local changes

Keep a counter. Each mutation bumps it when it starts and again when it
ends. Each `threads` or `files` request records the counter when it
starts. An answer is dropped if the counter has changed since its request
started. A poll that was dropped is asked again at once.

This is what stops a poll that started before a send from removing the
comment just added, or flipping back a resolve.

### Following the PR

While the Files changed tab is showing, ask `threads` every 15 seconds
(`cx.timer.every`, as the list does at `main.js:283`), and once on
arriving at the tab, including when the popup reopens on it. Stop when the
tab or the popup changes. One request at a time: if one is still out, skip
the tick.

Merging an answer whose `head` equals the head the diffs were read at:

- Threads are matched by `id`. New ones appear, changed ones update in
  place. A thread missing from the answer disappears, unless the answer
  has `more` set: then it is kept.
- The cursor today is an index into the row list (`files.js:88`,
  `170-191`). Before merging, turn it into an identity (file, and either a
  diff row's side and line or a thread ID); after merging, find that
  identity again. If its thread is gone, use the diff row the thread was
  under.
- Folded and unfolded state is kept per thread ID. A new thread arrives
  unfolded if unresolved.
- Scroll: the scroll handle can only scroll to an item
  (`gpui-kit.d.ts:21346-21364`). Take the first visible row's identity
  from the render callback's item range, and after the merge scroll that
  row to the top. Snapping to a row edge is acceptable; a jump of more
  than one row is not.
- Recompute the file tree's thread counts from the merged threads (the
  binary only tallies them for `files`).
- Update the review chip.

When the answer's `head` differs:

- Merge nothing that has a position. Update only the review chip.
- Show a one-line notice: "New commits pushed. `r` reloads."
- `c` and `e`-on-pending are refused with that notice. `x` still works.

Also change today's behaviour: when a diff answers `stale`, `files.js`
reloads `files`, clears every diff and says "The PR has new commits"
(`files.js:299-323`). That is an automatic reload. Replace it with the same
notice; only `r` reloads. An open composer survives the notice and the
reload (its draft is kept either way).

A failed poll shows nothing unless three in a row fail; then one dim line
with the error, cleared by the next success. The poll never touches the
composer or a dialog, except for the dialog's count (see the submit
dialog).

### The review chip

In the PR header, when a `review` is known: "Review pending: 7 comments",
with "(or more)" when `more` is set. It shows the last `files` or
`threads` answer for this PR, so on Overview and Checks it is absent until
the Files tab has been shown once. (Adding `review` to `detail` is not in
this version.)

### The composer

A multi-line text box docked at the bottom of the diff pane, not inside the
row list. Use the kit's `TextareaState` with `set_auto_grow(3, 10)`. Above
it, one line saying what it is for:

- "Comment on `path` line 42 (new side), pending" with the line's text, or
- "Reply to octocat on `path` line 42, pending", or
- "Edit your pending comment on `path` line 42", or
- "Edit your published comment on `path` line 42. Changes show at once."

Below it, the keys.

While the composer has focus every key types, except:

| Key | Does |
|---|---|
| `cmd-enter` | add to the pending review (or save the edit) |
| `esc` | close the composer, keeping the draft |

The textarea's `submit` event carries `secondary` and `shift`
(`gpui-kit.d.ts:21370-21374`) and no held flag; `secondary` is believed to
be cmd. Find out (Verify first). One press can arrive twice
(`files.js:46-48`), so the "sending" guard is set synchronously, before
anything is awaited.

Sending:

1. Take the text, mark the draft `sending` with the time, save it, and show
   the body as static text with "Sending…" (the textarea has no read-only
   mode). Nothing else can send.
2. **ok**: delete the draft, close the composer, merge the new comment in
   from the answer, ask for a poll.
3. **refused**: the box is editable again with the same text, the draft's
   state is cleared, and GitHub's message is shown.
4. **unknown**: mark the draft `unknown`. Show "No answer from GitHub. It
   may have been sent. Checking…" and run the check below.

The check after an unknown outcome:

- Uses only polls started after the send ended.
- **Found** means: a comment by the viewer (`mine`) on that target (that
  thread for a reply; that path, line and side for a new comment; that
  comment for an edit, with the new body) whose ID was not in the last
  answer received before the send started, and whose body equals the sent
  body after turning CRLF into LF and trimming both. For an edit: the
  comment's body equals the sent body by the same comparison.
- If found: treat as sent (delete the draft, close, say "Sent").
- If not found: say "Not found yet. Still checking." and poll every 5
  seconds for 60 seconds.
- After 60 seconds: say "Could not confirm. Sending again may post it
  twice." The box becomes editable. `cmd-enter` then asks "Send again?
  `cmd-enter` again sends, `esc` keeps the draft." and only that second
  press sends.

The same flow covers `resolve`, `unresolve` and `delete` with an unknown
outcome: show "No answer. Checking…", and let the next poll (started after
the mutation ended) show the truth. No resend prompt; the user presses the
key again if it did not happen.

Drafts:

- One draft per target:
  - reply: (PR, thread ID);
  - edit: (PR, comment ID);
  - new comment: (PR, path, side, line, head, the line's text).
- A new-comment draft is offered on a row only when path, side, line and
  the line's text all match. After a reload onto a new head, a draft whose
  row no longer matches is **unplaced**: it is never attached to a row by
  line number alone. Unplaced drafts are listed in the submit dialog with
  their text and the old path and line, so they can be copied or dropped.
- Saved to the mod's `localStorage` under one key holding a map, each with
  a timestamp and its send state (none, `sending` since T, `unknown`).
  Saved as typed, at most every half second, on closing the composer, and
  in the view's `close(cx)` hook (`herdr.d.ts:441-442`). The demo uses a
  separate key.
- Opening the composer on a target with a draft restores it. If its state
  is `sending` or `unknown` (the popup closed or the app quit mid-send),
  it opens as "This may have been sent. Checking…" and runs the check
  before it can be sent.
- A row or thread with a draft shows a small "draft" mark. `n`/`p` do not
  stop on drafts.
- At most 50 drafts. Saving a 51st drops the oldest and says "Dropped your
  oldest draft (on `path`)".
- `localStorage` is per mod copy (`~/.config/herdr-app/AGENTS.md:980`), so
  a popup opened on a PR from another mod has its own drafts. Accepted for
  this version; say so in the report.

### Keys on the Files tab

The kit spells a shifted letter `shift-s`, not `S`
(`gpui-kit.d.ts:446-457`). Added to the first spec's table:

| Key | On | Does |
|---|---|---|
| `c` | a diff row (`add`, `del`, `ctx`) | open the composer for a new comment on that line |
| `c` | a thread | open the composer for a reply (if `canReply`) |
| `x` | a thread | resolve, or unresolve if resolved (if allowed). Visible to others at once. |
| `e` | a thread | edit your latest comment in it (if `canEdit`) |
| `shift-d` | a thread | delete your latest comment in it (if `canDelete`), after a confirm |
| `shift-s` | anywhere | open the submit dialog (any open PR) |

- Side: a `del` row is the old side (`LEFT`), `add` and `ctx` rows are the
  new side (`RIGHT`), with the row's line number on that side.
- `c` on a `hunk` or `note` row, or on a file whose diff state is not
  `ok`, does nothing and says why in the footer for a moment.
- `x` shows the new state at once; if GitHub refuses, it flips back and
  shows the error. Reversible, so no confirm.
- When a key is not allowed (no permission, stale head, pending review on
  an older commit), it says so in one short line. It never does nothing
  silently.
- Where they are handled: `files.js` swallows held keys that are not moves
  itself (`files.js:44`, `335`), and `files.key` returns false when the
  file's state is not `ok` (`files.js:338`). Handle `c`, `x`, `e`,
  `shift-d` and `shift-s` in `files.key` ahead of that state check, so
  they can say why. Keep `c`, `x`, `h` in `prkeys.js`'s `NOT_ON_FILES`
  (so nothing behind the Files view sees them) and out of `MOVES` (so a
  held press does nothing).
- The footer lists the keys that apply to what the cursor is on.

Delete confirm: a one-line prompt in the footer. "Delete your pending
comment? `y` deletes, any other key keeps it." or "Delete your published
comment? Others will see it gone. `y` deletes, any other key keeps it."
A held `y` does not confirm.

### The submit dialog

`shift-s` opens a dialog over the tab. While it is open it takes every
key, including the two that arrive as commands (`github.tab` and
`github.backtab`, `main.js:290-301`) and `1` `2` `3`, which otherwise
switch tabs.

- First line: "Your review: 7 pending comments", or "No pending comments".
  This count follows the poll while the dialog is open (the one thing a
  poll may change in a dialog). If it changes, the line flashes "Now 8".
- Unsent drafts: "2 drafts are not part of the review. `cmd-enter` in the
  composer adds one." Unplaced drafts are listed with their text.
- A body box, prefilled with the pending review's `body` if it has one.
- Three choices: Comment, Approve, Request changes.
  - Approve and Request changes are not offered when `pr.mine`.
  - Comment is not offered with no body and no pending comments.
- `tab` moves between the body and the choices; `1` `2` `3` pick a choice
  when the body does not have focus; `cmd-enter` submits the picked
  choice. The button reads what it will do: "Submit: request changes, 7
  comments".
- Submit sends `reviewId` and the `count` shown at the moment of the
  press. If the binary refuses because the review changed, the dialog
  stays, shows the new count, and needs `cmd-enter` again.
- `esc` closes, keeping the body as a draft.
- Discard is a choice in the list, not a chord: "Discard review". Picking
  it swaps the dialog's content for "Discard your pending review and its 7
  comments? This cannot be undone. Type `discard` and press enter."
  Anything else cancels. It sends `reviewId` and `count` the same way.
- An unknown outcome on submit or discard: "No answer from GitHub. It may
  have gone through. Checking…", then poll. If the pending review is gone
  from a poll started after the send ended, it went through. Otherwise the
  dialog says "Could not confirm" and leaves the choice to the user; it
  does not resend by itself.

After submit: close the dialog, show "Review sent" with its link for a few
seconds, poll.

### Old binary

If `files` answers without `pr.id`, or `threads` answers that it is not an
op (extend the `TOO_OLD` match at `files.js:51` to it), the tab works as
before, does not poll, and the review keys say "This needs a newer
herdr-github" instead of acting.

## Verify first, on a real PR

Use a PR on `joshvera/herdr-github` made for this from a throwaway branch,
never anyone else's repo. Before building on them, try each and write the
answers in the plan:

1. With a pending review on an older commit than the head, where does
   `addPullRequestReviewThread` with that `pullRequestReviewId` land a
   thread? (The spec refuses this case; confirm the refusal is needed or
   say what GitHub does. `~/.claude/skills/gh-review/DESIGN.md:121-125`
   records the same open question.)
2. Does `addPullRequestReview` with `commitOID`, one thread and no `event`
   create a pending review holding that thread, pinned to that commit?
3. Does `addPullRequestReviewThreadReply` with `pullRequestReviewId` set
   stay pending? What does it do without one while a pending review
   exists? (The binary always passes it; this is to know the failure
   mode.)
4. Can an empty pending review be created, and replied into, for the
   no-pending-review reply path?
5. Deleting the last comment of a pending review: does the review remain
   with 0 comments, or vanish?
6. Can a thread that exists only in your pending review be resolved?
7. How long after creation does a pending thread appear in
   `reviewThreads` for its author? (The check's 60 seconds assumes well
   under that.)
8. Does GitHub change a body on storing it (line endings, trailing
   whitespace)? The "found" comparison assumes only CRLF and outer
   whitespace.
9. Does `request_changes` need a body when submitting a pending review
   that has comments?
10. Do `cmd-enter` (in a textarea, via `submit` with `secondary`),
    `shift-s`, `shift-d` and typed text reach the mod past the app's
    global bindings (`~/.config/herdr-app/keys.json`)? Under what names?
11. Does a `TextareaState` with `set_auto_grow` work inside the popup, and
    report focus and blur?
12. Does the app kill the binary when an exec times out?

Approve and Request changes cannot be tried on your own PR. Mark them not
tested by hand unless the user provides a PR from someone else to try
them on; do not submit a review on anyone else's PR without asking.

If an answer breaks a rule in this spec, stop and report. Do not bend the
rule quietly.

## Limits

- Body: 65,536 characters.
- Poll: 15 seconds, one at a time; 5 seconds during a check.
- Binary deadline for a mutation op: 20 seconds. Mod exec timeout for it:
  45 seconds.
- Drafts kept: 50.
- Threads and comments per thread: the first spec's limits.

## Tests

Go:

- Each new `do` through `runApp` against the demo: the happy path and each
  refusal (empty body, too long, stale head, pending review on an older
  commit, line not in the diff, missing permission, review changed since
  shown, submit with no `reviewId` while a pending review exists).
- Against the test server the existing tests use: the GraphQL each one
  sends, one mutation request per mutation, the review ID always passed on
  a reply, and **no second mutation request after any failure** (count
  them).
- Outcome classes: a refusal answers without `unknown`; a 5xx, a dropped
  connection after the request is read, the deadline, and `errors` with
  `data` each answer `unknown: true`.
- None of the new ops runs the detail query (the first spec's test for
  `files` shows how).
- `files` and `threads` carry `review` with `commit`, the permissions and
  `mine`.
- Demo state survives between two `runApp` calls.

Mod. There is no JavaScript test harness in the repo: the pure modules
(`prkeys.js`, `filetree.js`, `diffitems.js`) were checked with scratch
scripts that were never committed. Add one:

- `node --test app/mods/github/test/*.test.mjs`, importing modules that
  have no imports of their own. Commit the tests. Add the command to the
  gate below and to `.github/workflows/test.yml` (a `setup-node` step
  pinned to a commit, like the other actions). The Instant open tab is
  adding the same harness on its branch; use the same command and folder
  so the two merge cleanly.

Pure modules to write and test:

- The mutation caller's classification: ok, refused, unknown (timeout,
  rejection, not JSON, `unknown: true`); it calls once.
- Generations: a poll started before a mutation ended is dropped.
- The merge: cursor identity, folds and scroll anchor kept; a thread gone
  under the cursor; `more` keeps missing threads; a different head merges
  nothing positional.
- The composer's state machine: every path in "Sending" and "The check",
  including two triggers in one tick sending once, reopen with a
  `sending` draft, found by a new ID, not fooled by an older identical
  comment, not answered by a poll started before the send ended, and the
  second-confirm resend.
- Drafts: save, restore, the 50 cap and its message, unplaced after a
  head change, never re-attached by line number alone.
- Key handling: each new key by what the cursor is on; held keys never
  act; the dialog captures `tab`, `1` `2` `3`.
- The dialog: the count sent is the count shown; a changed-review refusal
  keeps the dialog open.

By hand, on the sandbox PR, written into the report: every key; Comment
submit; discard; a comment added from github.com appearing within 15
seconds while the cursor sits still; a push to the branch showing the
notice without moving anything; closing the popup mid-draft and finding
the draft again; the demo's `!unknown` body showing the unknown flow.

## Approaches considered

- **Everything pending, no send-now (chosen).** Matches how the pending
  `gh-review` flow works and makes the safe thing the only thing: nothing
  new reaches anyone until submit.
- **Publish each comment at once, as GitHub's "Add single comment".**
  Faster for one-line replies on your own PR, but one slip posts to other
  people, and it does not fit a review an agent is drafting alongside
  you.
- **Composer inline, under the row.** Reads better, but a growing editor
  inside a virtual list of fixed-height rows is the problem the first
  build already had to design around. Docked instead.
- **Push instead of poll.** GitHub has no push channel a local tool can
  use without a server. A poll costs 2 points, so 240 an hour is about 480
  of the 5,000 allowed.

## Left to the builder

- Whether `threads` shares its query text with `files`.
- The exact look of the composer, chip and dialog: follow `look.js`.
- Where the mod's pure parts live; keep drawing apart from state, as
  `files.js` and `filesdraw.js` do.

## Build order

1. Verify first.
2. The JavaScript test harness.
3. Go: routing, `threads`, the new `files` fields, then each `do`, with
   demo state and tests.
4. Mod: the mutation caller and generations; move the existing `act` call
   onto it.
5. Mod: following the PR (poll, merge, the head notice replacing the
   automatic reload) and the review chip. Useful alone: a pending
   `gh-review` shows live. Stop here for a hand test.
6. Mod: `x` resolve.
7. Mod: the composer, drafts, `c`, `e`, `shift-d`.
8. Mod: the submit dialog and discard.

Each step ends with the checks passing: `gofmt`, `go vet`,
`go test -race -count=1 ./...`, `sh scripts/test-build.sh`,
`node --test app/mods/github/test/*.test.mjs`,
`herdr-app check app/mods/github`. An earlier commit (1e0ddfb) records
`herdr-app check` hanging once; if it hangs, report it, do not drop it.

## Amendments (second review)

These override the text above.

### A1. Outcome classes, made concrete

- **Before sending.** Immediately before the mutation's HTTP request, check
  the context and the time left. If less than 8 seconds of the 20 remain,
  refuse: "Took too long to prepare. Nothing was sent." That is
  **refused**.
- **After sending.** Any error from the HTTP call or from reading its body
  is **unknown**.
- **Errors with data.** GitHub usually answers a refused mutation as
  `{"data": {"<mutation>": null}, "errors": [...]}`. So: errors with a
  **null** payload for the mutation and a refusal type are **refused**;
  errors with a **non-null** payload are **unknown**. Confirm the shape on
  the sandbox PR (Verify first) and write down what GitHub sent.
- **Status codes.** 401 (the existing signed-out error) and 403 are
  **refused**. 429 and a `RATE_LIMITED` error are **refused** (GitHub did
  not act). Any 5xx is **unknown**.
- **In the mod's caller.** A failure in `binary()` (finding or provisioning
  the binary, before exec) is **refused**. Any exec rejection, a timeout,
  or output that is not JSON is **unknown**: rejections cannot be told
  apart (`main.js:122-125`).
- The caller may run `findGitHub` **before** the single send when no
  machine is chosen yet. It never runs it after, and never sends twice.
- Refused and unknown both hand back the **whole answer**, not just the
  error text, so `review` survives.
- The existing `act` values (merge and the rest) get the same deadline and
  the same `unknown` flag in the binary, not only the new caller in the
  mod.

### A2. What "found" is compared against

At send time, before the exec, store in the draft the IDs of the viewer's
comments on that target (the thread for a reply; the path, line and side
for a new comment). "Found" means a comment by the viewer on that target
whose ID is **not in that stored list**, with a matching body. This
replaces "not in the last answer received before the send started", which
is lost when the popup closes.

Saving the draft's `sending` state and that ID list is synchronous, before
the exec. It is not subject to the half-second throttle.

### A3. Polls and mutations

Replace the generations rule with:

- No poll starts while a mutation is in flight. A tick that falls then is
  skipped, and one poll is asked when the mutation ends.
- The counter bumps when a mutation starts and when it ends. An answer
  (`threads` or `files`) is dropped if the counter changed since its
  request started.
- A dropped answer is asked for again as soon as no mutation is in flight.

### A4. A new thread is not removed by a lagging read

A thread or comment merged from an ok answer is kept until a poll has
contained its ID, or for 60 seconds, whichever comes first. After that the
ordinary missing-thread rule applies.

### A5. Typing must not trigger review keys

Today a key reaches a text input only when `filesTyping()` is true, which
means only the filter (`main.js:980-990`); otherwise it goes to
`files.key`. So a typed `x` in the composer would resolve a thread.

- The composer's and the dialog body's focus (from the textarea's `focus`
  and `blur` events) set the same typing flag as the filter, and
  `filesTyping()` covers them.
- `files.key` returns early while typing. The tab commands
  (`github.tab`, `github.backtab`) are swallowed while typing.
- `files.escape` (`main.js:594-602`) closes the composer first, then the
  filter, then leaves.
- Order in `files.key`: the typing check, then the held check
  (`files.js:334-335`), then the new keys, then the state check.
- Test: with the composer focused, `x`, `shift-d`, `shift-s`, `1` and the
  tab commands change nothing but the text.

### A6. Submit with no `reviewId`, and its unknown outcome

- Unknown outcome **with** `reviewId`: if a poll started after the send
  ended shows that review no longer pending, say "Your pending review is
  no longer pending" and treat it as sent.
- Unknown outcome **without** `reviewId`: "the pending review is gone"
  proves nothing, because there was none. Only a review by the viewer in
  the submitted state, submitted after the send started (read with
  `reviews(author: viewer, last: 1)`), counts. Otherwise "Could not
  confirm".
- Accepted risk, stated: between the binary's read and the mutation there
  is a window GitHub gives no way to close. Comparing `count` also misses
  one comment deleted and another added. The dialog's read-and-compare
  narrows the window; it does not remove it.
- Add to Verify first: what `addPullRequestReview` with an `event` does
  when a pending review already exists (refuses, leaves it alone, or
  publishes its comments). If it can publish comments the dialog did not
  show, stop and report before building the no-`reviewId` path.
- "`comment` with no body and no pending comments is refused" means the
  **event** `comment`, not `do: comment`.

### A7. `comment` with no pending review cannot answer `thread`

`addPullRequestReview`'s payload has the review and no thread. On that
path the answer carries `comment` and `review` only. The mod shows the
comment as sent, holds it by A4, and lets the next poll place the thread.

### A8. Reply with no pending review

- The empty pending review is created with `commitOID` set to the head
  from the pre-read.
- If the **first** mutation's outcome is unknown: say "No answer. An empty
  pending review may have been created." and run the reply check. A resend
  reads again and replies into whatever pending review then exists.
- If the deadline falls between the two mutations: refused for the reply,
  with the new `review` in the answer.

### A9. Drafts and head

A send always uses the head the diff is currently loaded at, and the row
must exist there with the same text. Otherwise the draft is unplaced and
cannot be sent. This holds for a composer left open across a reload.

### A10. Smaller points

- The new `do` values branch before the demo save at `app.go:356`. The new
  branch saves demo state itself, as `appFilesOp` does for `viewed`
  (`app.go:415`).
- The test harness: the pure modules are ESM in `.js` files and there is
  no `package.json`. Either add `app/mods/github/package.json` with
  `{"type": "module"}` (check `herdr-app check` and the installer ignore
  it) or pin Node 22.12 or later in `setup-node`. Agree the choice with
  the Instant open tab's harness.
- Whether the virtual list's render callback exposes the visible item
  range is unverified. If it does not, say so and propose how the scroll
  anchor is kept.
