// What an automatic read and a change of who may do to the Files tab.
// main.js and files.js import the herdr runtime, so node can't run them; it
// reads them. These prove the wiring is there, not that the screen behaves
// (that's on the hand-test list); the rules the wiring calls are tested on
// their own (reads.test.mjs, review-sent.test.mjs, review-mutation.test.mjs).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
const main = read("main.js");
const files = read("files.js");

// A method's body: from `  name(` (or `  async name(`) at two spaces in,
// to the next `  }` there.
function body(src, name) {
  const start = src.search(new RegExp(`\\n  (async )?${name}\\(`));
  assert.ok(start >= 0, `no method ${name}`);
  const end = src.indexOf("\n  }\n", start);
  return src.slice(start, end);
}

test("F1a: every Files tab read goes through one place, which looks for GitHub again only when a person asked", () => {
  assert.equal([...files.matchAll(/this\.app\.gh\(/g)].length, 1, "files.js asks gh only in read()");
  assert.match(body(files, "read"), /this\.app\.gh\(req, \{ \.\.\.opts, auto: !user \}\)/);
  assert.match(body(main, "gh"), /askSignedIn\(\{[^}]*auto/s, "main's gh hands auto to the rule");
});

test("F1a: a poll, a reload owed after a change, and a diff are automatic; only shown and r are a person's", () => {
  assert.match(body(files, "poll"), /this\.read\(\{ op: "threads", pr: this\.prID\(\) \}\)/);
  assert.match(body(files, "fetchDiff"), /this\.read\(\{ op: "diff", pr: this\.prID\(\), path, head \}, SLOW\)/);
  assert.match(body(files, "loadFiles"), /this\.read\(\{ op: "files", pr: this\.prID\(\) \}, SLOW, user\)/);
  assert.match(body(files, "tick"), /return this\.loadFiles\(cx\);/);
  // Every load a person started says so; no other does.
  const started = [...files.matchAll(/this\.loadFiles\(cx, [^)]*true\)/g)].map((m) => m.index);
  const shown = files.search(/\n {2}shown\(/);
  const reload = files.search(/\n {2}reload\(/);
  const inside = (i, at) => i > at && i < files.indexOf("\n  }\n", at);
  assert.ok(started.length >= 2 && started.every((i) => inside(i, shown) || inside(i, reload)));
});

test("F1b: a who change on the PR screen says what was out before dropping it, after the screen it lands on is drawn", () => {
  const s = body(main, "settle");
  const leave = s.indexOf("this.files?.leave()");
  const toList = s.indexOf("this.toList(cx)");
  assert.ok(leave >= 0 && toList > leave, "leave() before the list");
  assert.ok(s.lastIndexOf("this.say(") > toList, "said after toList, which clears what's said");
});

test("F1b: leaving lets go of the composer, the dialog and the delete's y, its drafts written", () => {
  const l = body(files, "leave");
  assert.match(l, /leaveNote\(/);
  assert.match(l, /this\.close\(\)/);
  for (const field of ["composer", "dialog", "confirm"]) assert.match(l, new RegExp(`this\\.${field} = null`));
});

test("F2: a who change gives a PR opened straight a fresh Files tab and drops its Overview", () => {
  const s = body(main, "settle");
  assert.match(s, /this\.files = new FilesView\(this, this\.filesUI\)/);
  assert.match(s, /this\.detail = null/);
  assert.match(s, /this\.loadDetail\(cx\)/);
});

test("F2: a view outlived by a who change is dead, and each change it sends carries the who it was made under", () => {
  assert.match(body(files, "alive"), /this\.app\.gen === this\.made/);
  assert.match(body(files, "send"), /this\.app\.mutate\(\{ \.\.\.req, pr: this\.prID\(\) \}, this\.made\)/);
  assert.match(body(main, "mutate"), /made/);
  assert.match(body(main, "mutate"), /sendOnce\(\{\s*who:/);
});
