// What a change sent from the Files tab does to the threads shown (sent.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { withResolved, withComment, withReply, withEdit, withoutComment, withoutPending, checked, answerChecks, viewedAfter } from "../sent.js";

const comment = (id, extra = {}) => ({ id, author: "sam", body: "hi", created: 1, state: "submitted", url: "", mine: false, canEdit: false, canDelete: false, ...extra });
const thread = (id, comments, extra = {}) => ({
  id, path: "a.go", subject: "line", line: 3, side: "right", startLine: 0, startSide: "", originalLine: 3, hunk: "",
  resolved: false, outdated: false, comments, canReply: true, canResolve: true, canUnresolve: false, ...extra,
});

test("resolving makes new threads and flips what the viewer may do next", () => {
  const before = [thread("T1", [comment("C1")]), thread("T2", [comment("C2")])];
  const after = withResolved(before, "T1", true);
  assert.notEqual(after, before);
  assert.notEqual(after[0], before[0], "a new object, so the view's items are rebuilt");
  assert.equal(after[1], before[1], "the others are untouched");
  assert.deepEqual([after[0].resolved, after[0].canResolve, after[0].canUnresolve], [true, false, true]);
  assert.equal(before[0].resolved, false, "the old threads are left alone");
  const back = withResolved(after, "T1", false);
  assert.deepEqual([back[0].resolved, back[0].canResolve, back[0].canUnresolve], [false, true, false]);
});

test("a comment whose answer has its thread adds that thread", () => {
  const t = thread("T9", [comment("C9", { state: "pending", mine: true })]);
  const out = withComment([thread("T1", [comment("C1")])], { thread: t, comment: t.comments[0] }, { path: "a.go", side: "right", line: 3 });
  assert.deepEqual(out.map((x) => x.id), ["T1", "T9"]);
});

test("a comment that started the pending review (no thread in the answer) is held under its own id", () => {
  const c = comment("C9", { state: "pending", mine: true });
  const out = withComment([], { comment: c }, { path: "b.go", side: "left", line: 7 });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "C9", "the comment's id, which the poll that has the real thread contains");
  assert.equal(out[0].local, true);
  assert.deepEqual([out[0].path, out[0].side, out[0].line], ["b.go", "left", 7]);
  assert.equal(out[0].canReply, false, "nothing to reply to until GitHub's thread comes");
});

test("a reply is added once, however often it's merged", () => {
  const before = [thread("T1", [comment("C1")])];
  const once = withReply(before, "T1", comment("C2"));
  const twice = withReply(once, "T1", comment("C2"));
  assert.deepEqual(twice[0].comments.map((c) => c.id), ["C1", "C2"]);
});

test("an edit changes the comment's body in place", () => {
  const out = withEdit([thread("T1", [comment("C1"), comment("C2")])], { id: "C2", body: "new" });
  assert.deepEqual(out[0].comments.map((c) => c.body), ["hi", "new"]);
});

test("deleting the last comment of a thread takes the thread too", () => {
  const before = [thread("T1", [comment("C1"), comment("C2")]), thread("T2", [comment("C3")])];
  assert.deepEqual(withoutComment(before, "C2")[0].comments.map((c) => c.id), ["C1"]);
  assert.deepEqual(withoutComment(before, "C3").map((t) => t.id), ["T1"]);
});

test("discarding drops pending comments and the threads they leave empty", () => {
  const before = [
    thread("T1", [comment("C1"), comment("C2", { state: "pending" })]),
    thread("T2", [comment("C3", { state: "pending" })]),
  ];
  const out = withoutPending(before);
  assert.deepEqual(out.map((t) => t.id), ["T1"]);
  assert.deepEqual(out[0].comments.map((c) => c.id), ["C1"]);
});

test("a check after an unknown outcome reads the truth from the poll", () => {
  const resolved = [thread("T1", [comment("C1")], { resolved: true })];
  assert.deepEqual(checked({ kind: "resolve", thread: "T1", want: true }, resolved), { text: "It went through: resolved.", err: false });
  assert.equal(checked({ kind: "resolve", thread: "T1", want: false }, resolved).err, true);
  assert.equal(checked({ kind: "resolve", thread: "T9", want: true }, resolved).err, true);
  assert.deepEqual(checked({ kind: "delete", comment: "C9" }, resolved), { text: "It went through: deleted.", err: false });
  assert.equal(checked({ kind: "delete", comment: "C1" }, resolved).err, true);
});

test("a check reads the poll's own threads, and waits when the poll can't say (more, or a thread still held)", () => {
  const poll = { threads: [thread("T1", [comment("C1")])], more: false };
  const del = { kind: "delete", comment: "C9", after: 100 };
  assert.deepEqual(answerChecks([del], poll, new Map(), 200), { said: { text: "It went through: deleted.", err: false }, left: [] });
  assert.deepEqual(answerChecks([del], poll, new Map(), 50), { said: null, left: [del] }, "a poll from before the send ended");
  assert.deepEqual(answerChecks([del], { ...poll, more: true }, new Map(), 200), { said: null, left: [del] }, "not in a page of more: not known gone");
  const res = { kind: "resolve", thread: "T9", want: true, after: 100 };
  assert.deepEqual(answerChecks([res], poll, new Map([["T9", 999]]), 200), { said: null, left: [res] }, "just sent, not read back yet");
  assert.deepEqual(answerChecks([res], poll, new Map(), 200).said, { text: "That thread is gone from the PR.", err: true });
  assert.deepEqual(answerChecks([res], { ...poll, more: true }, new Map(), 200), { said: null, left: [res] });
});

test("an unknown delete of a comment not read back yet waits: a poll lagging its creation can't say it's gone", () => {
  const poll = { threads: [thread("T1", [comment("C1")])], more: false };
  const del = { kind: "delete", comment: "C9", after: 100, unreadUntil: 500 };
  assert.deepEqual(answerChecks([del], poll, new Map(), 200), { said: null, left: [del] }, "C9 was held when the poll began");
  assert.deepEqual(answerChecks([del], poll, new Map(), 600).said, { text: "It went through: deleted.", err: false }, "the hold had run out");
  const there = { threads: [thread("T1", [comment("C1"), comment("C9")])], more: false };
  assert.equal(answerChecks([del], there, new Map(), 200).said.err, true, "seen: it's GitHub's word");
});

test("an unknown viewed mark stays as asked; only a refusal puts it back", () => {
  assert.equal(viewedAfter("ok", "unviewed", "viewed"), "viewed");
  assert.equal(viewedAfter("refused", "unviewed", "viewed"), "unviewed");
  assert.equal(viewedAfter("unknown", "unviewed", "viewed"), "viewed", "a guess either way; as asked, with the No answer line");
});
