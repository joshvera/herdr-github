// Drafts kept in localStorage (drafts.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DraftStore, MAX_DRAFTS, DRAFTS_KEY, DEMO_DRAFTS_KEY, draftId, makeDraft, rowOf, rowTarget, placeDrafts, unplaced, droppedNote } from "../drafts.js";

// localStorage as the runtime has it: strings in, strings out, and a count
// of writes.
const memory = () => {
  const m = new Map();
  return {
    writes: 0,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      this.writes++;
      m.set(k, String(v));
    },
  };
};
const PR = "github.com/acme/app#7";
const onLine = (line, text, extra = {}) => ({ kind: "comment", pr: PR, path: "a.go", side: "right", line, text, head: "h1", ...extra });

test("a draft is kept and comes back in a new store (the popup reopened)", () => {
  const s = memory();
  const a = new DraftStore(s, DRAFTS_KEY);
  a.saveNow(makeDraft(onLine(4, "x := 1"), "first thought", 1));
  const b = new DraftStore(s, DRAFTS_KEY);
  const d = b.get(draftId(onLine(4, "x := 1")));
  assert.equal(d.body, "first thought");
  assert.equal(d.send, null);
  assert.equal(d.head, "h1");
});

test("typing is written on flush, not on every change", () => {
  const s = memory();
  const a = new DraftStore(s, DRAFTS_KEY);
  a.put(makeDraft(onLine(4, "x"), "a", 1));
  a.put(makeDraft(onLine(4, "x"), "ab", 2));
  assert.equal(s.writes, 0);
  assert.equal(a.get(draftId(onLine(4, "x"))).body, "ab", "what's pending reads back before it's written");
  a.flush();
  assert.equal(s.writes, 1);
  assert.equal(new DraftStore(s, DRAFTS_KEY).get(draftId(onLine(4, "x"))).body, "ab");
});

test("an emptied draft is dropped, unless it records a send", () => {
  const s = memory();
  const a = new DraftStore(s, DRAFTS_KEY);
  a.saveNow(makeDraft(onLine(4, "x"), "hi", 1));
  a.saveNow(makeDraft(onLine(4, "x"), "  \n", 2));
  assert.equal(a.get(draftId(onLine(4, "x"))), null);
  a.saveNow({ ...makeDraft(onLine(4, "x"), "", 3), send: { state: "unknown", since: 3, ids: [], body: "sent text" } });
  assert.notEqual(a.get(draftId(onLine(4, "x"))), null);
});

test("past 50 drafts the oldest goes, and is handed back to be named", () => {
  const s = memory();
  const a = new DraftStore(s, DRAFTS_KEY);
  // The oldest of all records a send: it's kept, the next oldest goes.
  a.saveNow({ ...makeDraft(onLine(1, "l1"), "sending one", 0), send: { state: "sending", since: 0, ids: [], body: "sending one" } });
  for (let i = 2; i <= MAX_DRAFTS; i++) a.put(makeDraft(onLine(i, `l${i}`), `draft ${i}`, i));
  assert.deepEqual(a.flush().dropped, []);
  const { dropped } = a.saveNow(makeDraft(onLine(99, "l99"), "the 51st", 99));
  assert.equal(dropped.length, 1);
  assert.equal(dropped[0].body, "draft 2");
  assert.equal(droppedNote(dropped[0]), "Dropped your oldest draft (on a.go)");
  assert.equal(droppedNote(makeDraft({ kind: "body", pr: PR }, "x", 1)), "Dropped your oldest draft (on the review's text)");
  const left = new DraftStore(s, DRAFTS_KEY).forPR(PR);
  assert.equal(left.length, MAX_DRAFTS);
  assert.ok(left.some((d) => d.body === "sending one"));
});

test("two views' stores write only their own drafts back", () => {
  const s = memory();
  const a = new DraftStore(s, DRAFTS_KEY);
  const b = new DraftStore(s, DRAFTS_KEY);
  a.put(makeDraft(onLine(1, "x"), "from a", 1));
  b.saveNow(makeDraft(onLine(2, "y"), "from b", 2));
  a.flush();
  const c = new DraftStore(s, DRAFTS_KEY);
  assert.deepEqual(c.forPR(PR).map((d) => d.body).sort(), ["from a", "from b"]);
});

test("the demo's drafts are kept apart", () => {
  const s = memory();
  new DraftStore(s, DEMO_DRAFTS_KEY).saveNow(makeDraft(onLine(1, "x"), "demo", 1));
  assert.deepEqual(new DraftStore(s, DRAFTS_KEY).forPR(PR), []);
});

test("unreadable storage reads as no drafts", () => {
  const s = memory();
  s.setItem(DRAFTS_KEY, "{not json");
  assert.deepEqual(new DraftStore(s, DRAFTS_KEY).forPR(PR), []);
  s.setItem(DRAFTS_KEY, "[1,2]");
  assert.deepEqual(new DraftStore(s, DRAFTS_KEY).forPR(PR), []);
});

test("a draft's id is its target: a reply's thread, an edit's comment, a line's text", () => {
  assert.notEqual(draftId(onLine(4, "a")), draftId(onLine(4, "b")), "same line, other text: another draft");
  assert.equal(draftId(onLine(4, "a")), draftId(onLine(4, "a", { head: "h2" })), "the head isn't part of it");
  assert.notEqual(draftId({ kind: "reply", pr: PR, thread: "T1" }), draftId({ kind: "edit", pr: PR, comment: "T1" }));
});

const rows = [
  { kind: "hunk", old: 0, new: 0, text: "@@ -1,3 +1,4 @@" },
  { kind: "ctx", old: 1, new: 1, text: "package a" },
  { kind: "del", old: 2, new: 0, text: "old line" },
  { kind: "add", old: 0, new: 2, text: "new line" },
  { kind: "add", old: 0, new: 3, text: "x := 1" },
];

test("c's side and line: a deleted line is the old side, the rest the new", () => {
  const at = { pr: PR, path: "a.go", head: "h1" };
  assert.deepEqual(rowTarget(rows[2], at), { kind: "comment", pr: PR, path: "a.go", side: "left", line: 2, text: "old line", head: "h1" });
  assert.equal(rowTarget(rows[3], at).side, "right");
  assert.equal(rowTarget(rows[1], at).line, 1);
  assert.equal(rowTarget(rows[0], at), null, "not on a hunk's header");
});

test("a draft's row is found by side, line and text", () => {
  assert.equal(rowOf(rows, { side: "right", line: 3, text: "x := 1" }), 4);
  assert.equal(rowOf(rows, { side: "left", line: 2, text: "old line" }), 2);
  assert.equal(rowOf(rows, { side: "right", line: 3, text: "x := 2" }), -1, "same line, changed text");
  assert.equal(rowOf(rows, { side: "left", line: 3, text: "x := 1" }), -1, "other side");
});

test("after new commits a draft is placed again only where its line is unchanged, never by line number alone", () => {
  const drafts = [
    makeDraft(onLine(3, "x := 1"), "same row", 1),
    makeDraft(onLine(2, "was here"), "text changed", 2),
    makeDraft(onLine(9, "new line"), "text moved to line 2", 3),
    makeDraft({ ...onLine(3, "x := 1"), path: "b.go" }, "other file", 4),
  ];
  const moved = placeDrafts(drafts, "a.go", "h2", rows);
  assert.deepEqual(moved.map((d) => d.body), ["same row"]);
  assert.equal(moved[0].head, "h2");
  const now = drafts.map((d) => moved.find((m) => m.id === d.id) ?? d);
  assert.deepEqual(unplaced(now, "h2").map((d) => d.body), ["text changed", "text moved to line 2", "other file"]);
  assert.deepEqual(unplaced(now, "h1").map((d) => d.body), ["same row"], "only new-comment drafts can be unplaced");
});
