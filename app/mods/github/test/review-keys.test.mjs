// What a key does on the Files tab once review actions are in (reviewkeys.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { route, reviewAction, OLD_BINARY } from "../reviewkeys.js";

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
