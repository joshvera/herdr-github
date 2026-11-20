// A thread's items know the kind of line they hang from, so the card is
// drawn on that line's colour (filesdraw.js), as on GitHub.
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffItems } from "../diffitems.js";

const thread = (id, side, line, extra = {}) => ({
  id, path: "a.go", subject: "line", line, side, startLine: 0, startSide: "", originalLine: line, hunk: "",
  resolved: false, outdated: false, canReply: true, canResolve: true, canUnresolve: false,
  comments: [{ id: `C${id}`, author: "sam", body: "hi", created: 0, state: "pending", url: "", mine: true, canEdit: true, canDelete: true }],
  ...extra,
});

test("a thread's items carry the kind of the line they hang from; a thread on no line, none", () => {
  const rows = [
    { kind: "ctx", old: 1, new: 1, text: "a" },
    { kind: "del", old: 2, new: 0, text: "b" },
    { kind: "add", old: 0, new: 2, text: "c" },
  ];
  const threads = [thread("ctx", "right", 1), thread("del", "left", 2), thread("add", "right", 2), thread("gone", "right", 99)];
  const items = diffItems({ rows, threads, folded: () => false, width: 800 });
  const under = (id) => new Set(items.filter((it) => it.t?.id === id).map((it) => it.under));
  assert.deepEqual(under("ctx"), new Set(["ctx"]));
  assert.deepEqual(under("del"), new Set(["del"]));
  assert.deepEqual(under("add"), new Set(["add"]));
  assert.deepEqual(under("gone"), new Set([undefined]));
  assert.ok(items.filter((it) => it.kind === "row").every((it) => !("under" in it)), "rows draw their own colour");
});
