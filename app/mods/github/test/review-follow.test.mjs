// Following the PR: merging a poll without moving the reader (follow.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeThreads, countThreads, refind, shiftedAbove, reviewChip, PollHealth, HOLD_MS, reviewsOf, applyPoll } from "../follow.js";
import { diffItems } from "../diffitems.js";

const NOW = 1_800_000_000_000;
const comment = (id, body = "hi") => ({ id, author: "sam", body, created: NOW, state: "submitted", url: "", mine: false, canEdit: false, canDelete: false });
const thread = (id, line, comments, extra = {}) => ({
  id, path: "a.go", subject: "line", line, side: "right", startLine: 0, startSide: "", originalLine: line, hunk: "",
  resolved: false, outdated: false, comments, canReply: true, canResolve: true, canUnresolve: false, ...extra,
});
const rows = Array.from({ length: 6 }, (_, i) => ({ kind: "add", new: i + 1, text: `line ${i + 1}` }));
const itemsOf = (threads, folded = () => false) => diffItems({ rows, threads, folded, width: 800 });

test("a new thread appears and a changed one updates in place", () => {
  const prev = [thread("T1", 2, [comment("C1")])];
  const answer = { threads: [thread("T1", 2, [comment("C1"), comment("C2")]), thread("T2", 4, [comment("C3")])], more: false };
  const { threads } = mergeThreads(prev, answer, new Map(), NOW);
  assert.deepEqual(threads.map((t) => t.id), ["T1", "T2"]);
  assert.deepEqual(threads[0].comments.map((c) => c.id), ["C1", "C2"]);
});

test("a thread missing from the answer goes, unless the answer has more", () => {
  const prev = [thread("T1", 2, [comment("C1")]), thread("T2", 4, [comment("C2")])];
  assert.deepEqual(mergeThreads(prev, { threads: [prev[0]], more: false }, new Map(), NOW).threads.map((t) => t.id), ["T1"]);
  assert.deepEqual(mergeThreads(prev, { threads: [prev[0]], more: true }, new Map(), NOW).threads.map((t) => t.id), ["T1", "T2"]);
});

test("a thread just sent is kept until a poll has it, or for 60 seconds", () => {
  const sent = thread("T9", 3, [comment("C9")]);
  const held = new Map([["T9", NOW + HOLD_MS], ["C9", NOW + HOLD_MS]]);
  const lagging = mergeThreads([sent], { threads: [], more: false }, held, NOW + 1000);
  assert.deepEqual(lagging.threads.map((t) => t.id), ["T9"], "kept while the read lags");
  const caught = mergeThreads(lagging.threads, { threads: [sent], more: false }, lagging.held, NOW + 2000);
  assert.equal(caught.held.size, 0, "let go once a poll has it");
  const expired = mergeThreads([sent], { threads: [], more: false }, held, NOW + HOLD_MS + 1);
  assert.deepEqual(expired.threads, [], "gone after 60 s");
});

test("a reply just sent stays in its thread while the poll lags", () => {
  const prev = [thread("T1", 2, [comment("C1"), comment("C2")])];
  const held = new Map([["C2", NOW + HOLD_MS]]);
  const { threads } = mergeThreads(prev, { threads: [thread("T1", 2, [comment("C1")])], more: false }, held, NOW);
  assert.deepEqual(threads[0].comments.map((c) => c.id), ["C1", "C2"]);
});

test("file counts follow the merged threads", () => {
  const files = [{ path: "a.go", threads: 1, open: 1 }, { path: "b.go", threads: 0, open: 0 }];
  const out = countThreads(files, [thread("T1", 2, []), thread("T2", 3, [], { resolved: true })]);
  assert.deepEqual(out.map((f) => [f.threads, f.open]), [[2, 1], [0, 0]]);
  assert.equal(out[1], files[1], "unchanged files keep their identity");
});

test("the cursor on a row stays on that row when a thread appears above it", () => {
  const before = itemsOf([]);
  const at = before.findIndex((it) => it.key === "r4");
  const after = itemsOf([thread("T1", 2, [comment("C1")])]);
  assert.equal(after[refind(before, after, at)].key, "r4");
});

test("the cursor on a thread that's gone goes to the row it sat under", () => {
  const before = itemsOf([thread("T1", 3, [comment("C1")]), thread("T2", 3, [comment("C2")])]);
  const at = before.findIndex((it) => it.key === "t:T2");
  const after = itemsOf([thread("T1", 3, [comment("C1")])]);
  assert.equal(after[refind(before, after, at)].key, "r2", "line 3 is row r2, not T1's comment");
});

test("folds are kept by thread id across a merge", () => {
  const fold = new Map([["T1", true]]);
  const folded = (t) => fold.get(t.id) ?? t.resolved;
  const after = itemsOf([thread("T1", 2, [comment("C1")]), thread("T2", 4, [comment("C2")])], folded);
  assert.equal(after.find((it) => it.key === "t:T1").folded, true);
  assert.equal(after.find((it) => it.key === "t:T2").folded, false, "a new unresolved thread arrives unfolded");
});

test("the scroll is put back only when something above the first visible item changed", () => {
  const before = itemsOf([]);
  const top = before.findIndex((it) => it.key === "r3");
  assert.equal(shiftedAbove(before, itemsOf([thread("T1", 5, [comment("C1")])]), top), false, "a thread below changes nothing above");
  assert.equal(shiftedAbove(before, itemsOf([thread("T1", 1, [comment("C1")])]), top), true);
});

test("the review chip", () => {
  assert.equal(reviewChip(null, false), "");
  assert.equal(reviewChip({ comments: 1 }, false), "Review pending: 1 comment");
  assert.equal(reviewChip({ comments: 7 }, true), "Review pending: 7 comments (or more)");
});

test("a failed poll shows nothing until three in a row", () => {
  const h = new PollHealth();
  h.failed("x");
  h.failed("x");
  assert.equal(h.error, "");
  h.failed("GitHub: HTTP 502");
  assert.equal(h.error, "GitHub: HTTP 502");
  h.ok();
  assert.equal(h.error, "");
});

test("an answer that leaves the review out (GitHub didn't say) keeps what was known; only null means none", () => {
  const prev = { review: { id: "PRR_1", comments: 7 }, submitted: { id: "PRR_0", at: 1 } };
  assert.deepEqual(reviewsOf({ head: "h", threads: [], more: true }, prev), prev);
  assert.deepEqual(reviewsOf({ review: null, submitted: null }, prev), { review: null, submitted: null });
  const next = { review: { id: "PRR_1", comments: 8 }, submitted: { id: "PRR_2", at: 2 } };
  assert.deepEqual(reviewsOf(next, prev), next);
  assert.deepEqual(reviewsOf({ review: null }, prev), { review: null, submitted: prev.submitted }, "an older binary with no submitted");
});

const shownWith = (threads, held = new Map(), extra = {}) => ({ threads, held, edited: new Map(), more: false, ...extra });

test("a comment deleted while held isn't drawn back from its thread's hold", () => {
  const sent = thread("T9", 3, [comment("C9")]);
  const held = new Map([["T9", NOW + HOLD_MS], ["C9", NOW + HOLD_MS]]);
  held.delete("C9"); // what shift-d y does as it sends
  assert.deepEqual(applyPoll(shownWith([sent], held), { threads: [], more: false }, NOW + 1000).threads, [], "the thread had nothing else");
  const two = thread("T9", 3, [comment("C9"), comment("C10")]);
  const held2 = new Map([["T9", NOW + HOLD_MS], ["C10", NOW + HOLD_MS]]);
  const out = applyPoll(shownWith([two], held2), { threads: [], more: false }, NOW + 1000).threads;
  assert.deepEqual(out.map((t) => t.comments.map((c) => c.id)), [["C10"]], "the reply just sent stays");
});

test("a poll's more replaces the last one: once the threads are all there, it's false", () => {
  const prev = [thread("T1", 2, [comment("C1")])];
  assert.equal(applyPoll(shownWith(prev, new Map(), { more: true }), { threads: prev, more: false }, NOW).more, false);
  assert.equal(applyPoll(shownWith(prev), { threads: prev, more: true }, NOW).more, true);
});

test("an edit just saved shows its new text until a poll has it, or for 60 seconds", () => {
  const before = [thread("T1", 2, [comment("C1", "old")])];
  const shown = shownWith([thread("T1", 2, [comment("C1", "new")])]);
  shown.edited = new Map([["C1", { body: "new", until: NOW + HOLD_MS }]]);
  const lagging = applyPoll(shown, { threads: before, more: false }, NOW + 1000);
  assert.equal(lagging.threads[0].comments[0].body, "new", "the poll from before the edit doesn't take it back");
  assert.equal(lagging.edited.size, 1);
  const caught = applyPoll({ ...shown, ...lagging }, { threads: [thread("T1", 2, [comment("C1", "new")])], more: false }, NOW + 2000);
  assert.equal(caught.edited.size, 0, "let go once a poll has it");
  const expired = applyPoll(shown, { threads: before, more: false }, NOW + HOLD_MS + 1);
  assert.equal(expired.threads[0].comments[0].body, "old", "GitHub's word after 60 s");
  assert.equal(expired.edited.size, 0);
});

test("a reload of the same head keeps what was just sent and not yet read back", () => {
  const sent = thread("T9", 3, [comment("C9")]);
  const held = new Map([["T9", NOW + HOLD_MS], ["C9", NOW + HOLD_MS]]);
  const files = { threads: [thread("T1", 2, [comment("C1")])], more: false };
  assert.deepEqual(applyPoll(shownWith([sent], held), files, NOW + 1000).threads.map((t) => t.id), ["T1", "T9"]);
});
