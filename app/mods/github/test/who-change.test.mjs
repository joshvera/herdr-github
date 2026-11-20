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
  assert.match(body(files, "read"), /this\.app\.gh\(req, \{ \.\.\.opts, why: user \? "asked" : "auto" \}\)/);
  assert.match(body(main, "gh"), /look: \(\) => this\.mayLook\(why\)/, "main's gh hands the rule, asked when it would look");
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

test("F1b: a who change on the PR screen says what was out before dropping it, held on the screen it lands on", () => {
  const s = body(main, "settle");
  const leave = s.indexOf("this.files?.leave(this.signedOut)");
  const toList = s.indexOf("this.toList(cx)");
  assert.ok(leave >= 0 && toList > leave, "leave() before the list");
  assert.ok(s.indexOf("this.hold(note, cx)") > toList, "held after toList, which clears what's said");
  // Nothing out: still told why the screen changed (sent.js whoChangedSays;
  // the 60 s re-ask may be what changed it).
  assert.match(s, /whoChangedSays\(\{ signedOut: this\.signedOut, direct: this\.direct, held: Boolean\(note\), statusErr: this\.statusErr \}\)/);
  assert.ok(s.indexOf("this.say(says.err, cx, true)") > toList && s.indexOf("this.say(says.flash, cx)") > toList);
  assert.match(s, /if \(says\.reread\) this\.loadDetail\(cx, "auto"\)/);
});

test("F1b: a change from the Overview with no answer is held, so the failing reads after it can't say over it", () => {
  assert.match(body(main, "act"), /this\.hold\(`No answer about #\$\{pr\.number\}\. Check that PR before trying again\.`, cx\)/);
});

test("F1b: what's held goes only when the user leaves the screen it's on, never when toList or say run", () => {
  for (const name of ["back", "enter"]) assert.match(body(main, name), /this\.notices = \[\];/, name);
  for (const name of ["toList", "say", "openPR", "settle", "statusFailed"]) assert.doesNotMatch(body(main, name), /this\.notices =/, name);
});

test("F3: a who change's reads on the PR screen are automatic; opening it and r may look", () => {
  const act = body(main, "act");
  assert.match(act, /this\.loadDetail\(cx, "auto"\)/);
  assert.match(act, /this\.loadAll\(cx, "auto"\)/);
  assert.match(body(main, "openPR"), /this\.loadDetail\(cx, "asked"\)/);
  assert.match(body(main, "reload"), /this\.loadDetail\(cx, "asked"\)/);
  // Every loadDetail says why; the two searches outside gh obey the same rule.
  assert.equal([...main.matchAll(/this\.loadDetail\(cx\)/g)].length, 0);
  assert.match(body(main, "loadDetail"), /this\.mayLook\(why\)\) \{\n\s*const found = await this\.findGitHub\(\)/);
  assert.match(body(main, "load"), /!this\.mayLook\(why\)\) throw e;\n\s*await this\.findGitHub\(\)/);
});

test("F4: a sign-out found by status forgets once, as a sign-out, and who stays for confirmWho's wipe", () => {
  const s = body(main, "statusFailed");
  assert.match(s, /e\?\.cachedSignedOut && !this\.forgotSignOut\) \{\n\s*this\.forgotSignOut = true;\n\s*this\.forget\(true\);/);
  assert.doesNotMatch(s, /this\.who = /);
  assert.match(body(main, "confirmWho"), /this\.forgotSignOut = false;/);
  assert.match(body(main, "forget"), /this\.signedOut = signedOut;/);
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
  assert.match(s, /this\.loadDetail\(cx, "auto"\)/);
});

test("F2: a view outlived by a who change is dead, and each change it sends carries the who it was made under", () => {
  assert.match(body(files, "alive"), /this\.app\.gen === this\.made/);
  assert.match(body(files, "send"), /this\.app\.mutate\(\{ \.\.\.req, pr: this\.prID\(\) \}, this\.made\)/);
  assert.match(body(main, "mutate"), /made/);
  assert.match(body(main, "mutate"), /sendOnce\(\{\s*who:/);
});
