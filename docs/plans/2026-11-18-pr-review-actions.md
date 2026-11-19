# Plan: review actions on the Files changed tab

Builds `docs/specs/2026-11-18-pr-review-actions.md` (with its Amendments,
which win). Sandbox: joshvera/herdr-github PR #2, branch
`sandbox-review-actions`, closed and deleted at the end. Raw GraphQL answers
for every probe are kept outside the repo (session scratchpad, `verify/`).

## Verify first: answers

Asked on PR #2 with `gh api graphql`, owner hardcoded to `joshvera`.

1. **Thread added to a pending review pinned to an older commit.** It lands
   on the PR's **current head**: the comment's `commit` and `originalCommit`
   are the new head, and `line` is read against the new head's diff. The
   review's own `commit` stays the old one, and its older threads are mapped
   forward (line 3 became 5). `AddPullRequestReviewThreadInput` has no
   commit field. So the spec's refusal is not needed for placement, but it
   breaks no rule and is kept (rule 4). Residual: a push between the
   binary's head read and the mutation places the line against the newer
   head. One round trip wide; GitHub offers no way to close it.
2. **`addPullRequestReview` with `commitOID`, one thread, no `event`.** Yes:
   state `PENDING`, `commit` is that oid, one comment, `PENDING`.
3. **Reply with `pullRequestReviewId`.** Stays `PENDING`. Without it while a
   pending review exists: it joins that pending review (still `PENDING`).
   Without it and **no** pending review: published at once (`SUBMITTED`).
   The binary always passes the ID.
4. **Empty pending review.** `addPullRequestReview` with no threads and no
   event creates one (0 comments, pinned to the head) and it can be replied
   into; the reply is `PENDING`.
5. **Deleting the last comment of a pending review deletes the review.** The
   mutation's payload still shows it `PENDING` with 0 comments, but the next
   read has no pending review and `node(id)` is `NOT_FOUND`. So `delete`
   answers `review: null` then; the review's body is lost with it.
6. **Resolving a thread that exists only in a pending review** works through
   the API, although `viewerCanResolve` is `false` for it. The mod follows
   `canResolve`, so `x` says it is not allowed there.
7. **Visibility delay.** None seen: the first read 0.4 s after creating the
   thread had it in `reviewThreads`, with `PENDING` comments, for the author.
8. **Stored body.** Byte for byte as sent: CRLF, tabs, leading and trailing
   spaces all kept. The binary's `clean` drops `\r` on the way in, so the
   mod compares with CRLF turned into LF and both sides trimmed, as the spec
   says.
9. **`request_changes` without a body.** Not tested: it cannot be tried on
   your own PR. Passed through as GitHub's refusal.
10. **Keys reaching the mod (`cmd-enter` via `submit` + `secondary`,
    `shift-s`, `shift-d`, typing).** Not verifiable without the live app.
    `keys.json` has no global `cmd-enter`, `shift-s` or `shift-d`;
    `escape`, `tab`, `shift-tab` arrive as `github.*` commands (handled per
    A5). The composer accepts both the textarea's `submit` with `secondary`
    and an `on_key_down` of `cmd-enter`, behind one synchronous guard.
    Hand test.
11. **`TextareaState` with `set_auto_grow` in the popup, focus and blur.**
    The API exists (`gpui-kit.d.ts:21456-21486`); behaviour in the popup is a
    hand test.
12. **Does the app kill the binary on exec timeout?** Unanswered:
    `herdr-app check` exits after one render, before a spawned exec runs.
    Safety does not depend on it: the binary bounds itself at 20 s and the
    mod waits 45 s.
13. **(A6) `addPullRequestReview` with an `event` while a pending review
    exists.** Refused: `UNPROCESSABLE`, "User can only have one pending
    review per pull request". The pending review and its comment were left
    alone. The no-`reviewId` submit path is safe to build.

Refusal shapes seen (A1 asked to write them down). Each is
`{"data": {"<mutation>": null}, "errors": [{"type": ..., "path": ["<mutation>"], ...}]}`:
`UNPROCESSABLE` ("Line could not be resolved", the one-pending-review rule),
`NOT_FOUND` (a deleted comment), `VALIDATION` ("The commitOID is not part of
the pull request").

Schema: `reviews(author:)` takes a login `String`; there is no `viewer`
literal. The binary filters `reviews(states: PENDING)` on `viewerDidAuthor`.
For A6's "submitted after the send started" it reads `reviews(last: 10)` and
filters on `viewerDidAuthor` and `submittedAt`.

`ItemRange` (`gpui-kit.d.ts:20321`) has `start` and `end`, and
`v_virtual_list`'s render callback receives it: the scroll anchor uses it.

## Contract between binary and mod

`files` and `threads` add:

```json
"pr": { "id": "PR_...", "mine": true, "state": "open" },
"review": { "id": "PRR_...", "body": "", "comments": 7, "commit": "<oid>" }
```

```json
"submitted": { "id": "PRR_...", "state": "approved", "at": 1795024345000 }
```

`review` is `null` when there is none. `submitted` is the viewer's latest
submitted review on the PR (`state` is `commented`, `approved`,
`changes_requested` or `dismissed`; `at` is GitHub's `submittedAt` in ms
since the epoch), or `null`. It is read on the first page as
`submitted: reviews(last: 10)`, filtered on `viewerDidAuthor` and a
non-null `submittedAt` (confirmed on PR #2: the aliased read answers). The
mod uses it for A6: an unknown submit with no `reviewId` went through when
a poll started after the send ended shows a `submitted.id` other than the
one known before the send, with `at` no earlier than the send's start less
60 s (GitHub's clock is not the mod's). Each thread adds `canReply`,
`canResolve`, `canUnresolve`; each comment adds `mine`, `canEdit`,
`canDelete`. `threads` answers `head`, `pr`, `review`, `submitted`,
`threads`, `more`.

`act` answers, on ok (always `"ok": true`):

| `do` | answer |
|---|---|
| `comment` | `comment` (object, files shape), `review`; plus `thread` (object) only when a pending review already existed (A7) |
| `reply` | `thread` (ID), `comment` (object), `review` |
| `resolve`, `unresolve` | `resolved` |
| `edit` | `comment` (object) |
| `delete` | `review` (may be `null`, verify 5) |
| `submit` | `url` |
| `discard` | nothing more |

Comment objects are cleaned like every inbound string. On refused or
unknown: `{"error": "...", "unknown": true?, "review": ...?, "stale": true?,
"changed": true?}`; `changed` marks the submit/discard "review changed"
refusal and carries the current `review`.

## Steps

Each ends with the gate: `gofmt -l`, `go vet ./...`,
`go test -race -count=1 ./...`, `sh scripts/test-build.sh`,
`node --test app/mods/github/test/*.test.mjs` (locally through
`mise x node@24.16.0 --`, since node is not on PATH here),
`herdr-app check app/mods/github`.

1. Verify first. Done (above).
2. Harness: `app/mods/github/test/`, Instant open's exact CI step (Node 24
   via `setup-node@949feb2`, no `package.json`). Test files here are named
   `review-*.test.mjs`.
3. Go (spine, Opus high, delegated): mutation classifier per A1 (with
   `httptrace` to tell "not written" from "written"), the 20 s deadline and
   the 8 s pre-send check, routing, `threads`, new `files` fields, each `do`,
   demo state in `app-demo.json` with `!unknown`, tests; existing `act`
   values get the deadline and the `unknown` flag too.
4. Mod (spine): `mutate()` caller and the A3 poll gate in a pure module;
   move `act`, `delete-branch` and `viewed`/`unviewed` onto it.
5. Mod: follow the PR (poll, merge with identity cursor, folds, scroll
   anchor, A4 hold, head notice replacing the automatic reload), the review
   chip. **Stop for a hand test.**
6. `x`. 7. Composer, drafts, `c`, `e`, `shift-d`, A5 typing gate.
8. Submit dialog and discard.

## Open for the owner

- Rule 2's window (A6 accepts it) and rule 4's push-between-read-and-send
  window (verify 1) are both one round trip wide.
- The refusal on "pending review on an older commit" is stricter than
  GitHub needs (verify 1); relaxing it is a spec change, not done here.
- The first spec's "no key that deletes anything on the Files tab" is
  contradicted by `shift-d`; the spec should say it is amended.
