// What a key does on the Files tab once review actions are in (reviewkeys.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { route, reviewAction, latestMine, deletePrompt, OLD_BINARY, NEW_COMMITS, OLDER_COMMIT } from "../reviewkeys.js";

const view = { keyboard: "view" };
const comment = (id, extra = {}) => ({ id, author: "sam", body: "hi", state: "submitted", mine: false, canEdit: false, canDelete: false, ...extra });
const thread = (extra = {}) => ({ id: "T1", resolved: false, canResolve: true, canUnresolve: false, canReply: true, comments: [comment("C1")], ...extra });
const onThread = (t) => ({ state: "ok", follows: true, item: { kind: "thread", key: `t:${t.id}`, t } });
const onRow = (kind = "add") => ({ state: "ok", follows: true, item: { kind: "row", key: "r3", row: { kind, old: 0, new: 4, text: "x := 1" } } });

test("x is a review key, decided before the view's state", () => {
  assert.equal(route(view, "x", false), "review");
  assert.equal(route(view, "j", false), "view");
});

test("a held key never acts unless it's a move", () => {
  assert.equal(route(view, "x", true), "swallow");
  assert.equal(route(view, "j", true), "view");
});

test("while the filter has the keyboard, x is typed", () => {
  assert.equal(route({ keyboard: "filter" }, "x", false), "type");
});

test("x resolves an unresolved thread and unresolves a resolved one", () => {
  const t = thread();
  assert.deepEqual(reviewAction("x", onThread(t)), { act: "resolve", thread: t, to: true });
  const r = thread({ resolved: true, canResolve: false, canUnresolve: true });
  assert.deepEqual(reviewAction("x", onThread(r)), { act: "resolve", thread: r, to: false });
});

test("x says why when it can't act", () => {
  assert.match(reviewAction("x", onRow()).say, /put the cursor on one/);
  assert.match(reviewAction("x", onThread(thread({ canResolve: false }))).say, /can't resolve/);
  assert.match(reviewAction("x", onThread(thread({ canResolve: false, comments: [comment("C1", { state: "pending" })] }))).say, /until your review is sent/);
  assert.match(reviewAction("x", onThread(thread({ resolved: true, canUnresolve: false }))).say, /can't unresolve/);
  assert.match(reviewAction("x", onThread(thread({ local: true }))).say, /read back/);
});

test("an old herdr-github is named, and loading isn't mistaken for one", () => {
  assert.equal(reviewAction("x", { ...onThread(thread()), follows: false }).say, OLD_BINARY);
  assert.equal(reviewAction("x", { state: "old", follows: false, item: null }).say, OLD_BINARY);
  assert.match(reviewAction("x", { state: "loading", follows: false, item: null }).say, /Still loading/);
});

const composing = { keyboard: "composer", composer: true };

test("A5: with the composer focused, review and tab keys only type", () => {
  for (const k of ["x", "c", "e", "shift-d", "shift-s", "1", "2", "y", "j", "enter"]) assert.equal(route(composing, k, false), "type", k);
  assert.equal(route(composing, "tab", false), "swallow", "github.tab does nothing");
  assert.equal(route(composing, "shift-tab", false), "swallow");
  assert.equal(route(composing, "cmd-enter", false), "send");
});

test("with the composer open but not focused, cmd-enter sends and the rest act on the diff", () => {
  const open = { keyboard: "view", composer: true };
  assert.equal(route(open, "cmd-enter", false), "send");
  assert.equal(route(open, "cmd-enter", true), "swallow", "never held");
  assert.equal(route(open, "c", false), "review");
});

test("a delete waits for y; a held y never confirms", () => {
  const confirm = { keyboard: "view", confirm: true };
  assert.equal(route(confirm, "y", false), "confirm");
  assert.equal(route(confirm, "j", false), "confirm", "any other key keeps it");
  assert.equal(route(confirm, "y", true), "swallow");
  assert.match(deletePrompt({ state: "pending" }), /^Delete your pending comment\? y deletes/);
  assert.match(deletePrompt({ state: "submitted" }), /Others will see it gone/);
});

test("Send again? takes the next key", () => {
  assert.equal(route({ keyboard: "view", composer: true, again: true }, "cmd-enter", false), "again");
  assert.equal(route({ keyboard: "view", composer: true, again: true }, "cmd-enter", true), "swallow");
});

test("c, e and shift-d are review keys, and never act held", () => {
  for (const k of ["c", "e", "shift-d"]) {
    assert.equal(route(view, k, false), "review", k);
    assert.equal(route(view, k, true), "swallow", k);
  }
});

const mine = (id, extra = {}) => comment(id, { mine: true, canEdit: true, canDelete: true, ...extra });

test("c on a line comments on it; on a hunk header or a note it says why", () => {
  for (const kind of ["add", "del", "ctx"]) assert.equal(reviewAction("c", onRow(kind)).act, "comment", kind);
  assert.match(reviewAction("c", onRow("hunk")).say, /hunk/);
  assert.match(reviewAction("c", onRow("note")).say, /a line/);
  assert.match(reviewAction("c", { state: "ok", follows: true, item: null, diff: "binary" }).say, /no diff lines/);
});

test("c refuses a stale head and a pending review on an older commit", () => {
  assert.equal(reviewAction("c", { ...onRow(), behind: true }).say, NEW_COMMITS);
  assert.equal(reviewAction("c", { ...onRow(), head: "h2", review: { commit: "h1" } }).say, OLDER_COMMIT);
  assert.equal(reviewAction("c", { ...onRow(), head: "h2", review: { commit: "h2" } }).act, "comment");
});

test("c on a thread replies, if you may", () => {
  const t = thread();
  assert.deepEqual(reviewAction("c", onThread(t)), { act: "reply", thread: t });
  assert.match(reviewAction("c", onThread(thread({ canReply: false }))).say, /can't reply/);
});

test("e and shift-d act on your latest comment, if GitHub lets you", () => {
  const t = thread({ comments: [mine("C1"), comment("C2"), mine("C3", { state: "pending" })] });
  assert.equal(latestMine(t).id, "C3");
  assert.deepEqual(reviewAction("e", onThread(t)), { act: "edit", thread: t, comment: t.comments[2] });
  assert.deepEqual(reviewAction("shift-d", onThread(t)), { act: "delete", thread: t, comment: t.comments[2] });
  assert.match(reviewAction("e", onThread(thread())).say, /no comment in this thread/);
  assert.match(reviewAction("e", onThread(thread({ comments: [mine("C1", { canEdit: false })] }))).say, /doesn't let you edit/);
  assert.match(reviewAction("shift-d", onThread(thread({ comments: [mine("C1", { canDelete: false })] }))).say, /doesn't let you delete/);
  assert.match(reviewAction("e", onRow()).say, /put the cursor on one/);
});

test("e on a pending comment waits for r after new commits; a published one doesn't", () => {
  const pending = thread({ comments: [mine("C1", { state: "pending" })] });
  assert.equal(reviewAction("e", { ...onThread(pending), behind: true }).say, NEW_COMMITS);
  const published = thread({ comments: [mine("C1")] });
  assert.equal(reviewAction("e", { ...onThread(published), behind: true }).act, "edit");
});

test("every review key on an old herdr-github says so", () => {
  for (const k of ["c", "x", "e", "shift-d"]) assert.equal(reviewAction(k, { ...onRow(), follows: false }).say, OLD_BINARY, k);
});

test("shift-s opens the submit dialog from anywhere on the tab, once the files are read", () => {
  assert.equal(route(view, "shift-s", false), "review");
  assert.equal(route(view, "shift-s", true), "swallow");
  assert.deepEqual(reviewAction("shift-s", onRow()), { act: "submit" });
  assert.deepEqual(reviewAction("shift-s", { state: "ok", follows: true, item: null }), { act: "submit" });
  assert.equal(reviewAction("shift-s", { state: "ok", follows: false, item: null }).say, OLD_BINARY);
  assert.match(reviewAction("shift-s", { state: "loading", follows: false, item: null }).say, /Still loading/);
});
