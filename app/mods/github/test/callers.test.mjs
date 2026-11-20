// main.js imports the herdr runtime, so node can't run it. What it can do is
// read it: every way to act on a PR (keys, the "Merge…" button and the
// footer's pills all end in these functions) must ask canAct first, through
// mayAct. A source check, not a behavioural one: it proves the call is
// there, not that the screen refuses (that's on the hand-test list).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../main.js", import.meta.url), "utf8");

// A method's body: from `  name(` at two spaces in, to the next `  }` there.
function body(name) {
  const start = src.search(new RegExp(`\\n  ${name}\\(`));
  assert.ok(start >= 0, `main.js has no method ${name}`);
  const end = src.indexOf("\n  }\n", start);
  return src.slice(start, end);
}

for (const name of ["act", "toggleDraft", "mergeMenu", "cleanupMenu"]) {
  test(`${name} asks mayAct before anything else`, () => {
    const lines = body(name).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("//"));
    assert.equal(lines[1], "if (!this.mayAct(cx)) return;", `${name}'s first statement`);
  });
}

test("mayAct is canAct on what's shown, against who is signed in now", () => {
  assert.match(body("mayAct"), /canAct\(this\.detail && \{ d: this\.detail, \.\.\.this\.detailInfo \}, this\.gen\)/);
});

test("a change from the Overview is made under the gen its detail was read as", () => {
  for (const name of ["act", "cleanupMenu"]) assert.match(body(name), /const made = this\.detailInfo\.gen;/, name);
  assert.match(body("showDetail"), /gen: info\.gen/);
});

test("delete-branch, the one change sent without act, is only in cleanupMenu", () => {
  const sends = [...src.matchAll(/do: "delete-branch"/g)].map((m) => m.index);
  const cm = src.search(/\n  cleanupMenu\(/);
  const cmEnd = src.indexOf("\n  }\n", cm);
  assert.ok(sends.length > 0 && sends.every((i) => i > cm && i < cmEnd));
});

test("a cached or warmed detail never reaches a list row", () => {
  assert.doesNotMatch(body("showCachedDetail"), /replaceRow|this\.cur =/);
  assert.doesNotMatch(body("warmTick"), /replaceRow|this\.cur =/);
  assert.doesNotMatch(body("showDetail"), /replaceRow|this\.cur =/);
});
