// ⌘G and ⌘L on GitHub's own view (modkeys.js): the global `mod.open` can't
// close a GitHub that Linear opened, so the mod's own keys do.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { modKey } from "../modkeys.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const pr = { mod: "github", label: "#12", props: { pr: { host: "github.com", repo: "o/r", number: 12 } } };
const issue = { mod: "linear", label: "HAL-212", props: { issue: { key: "HAL-212" } } };

test("its own key closes this view, wherever it was opened from", () => {
  assert.deepEqual(modKey("github", "github", null), { close: true });
  assert.deepEqual(modKey("github", "github", issue), { close: true });
});

test("the key of the mod it came from goes back there, to that issue", () => {
  assert.deepEqual(modKey("github", "linear", issue), { close: true, open: issue });
  assert.deepEqual(modKey("linear", "github", pr), { close: true, open: pr });
});

test("any other mod's key does what the global key does", () => {
  assert.deepEqual(modKey("github", "linear", null), { toggle: "linear" });
  assert.deepEqual(modKey("github", "linear", { mod: "recap" }), { toggle: "linear" });
});

test("keys.json binds both keys on GitHub's view, over the global ones", () => {
  const keys = JSON.parse(read("../../../keys.json"));
  assert.equal(keys.global["cmd-g"], "mod.open:github");
  assert.equal(keys["mod:github"]["cmd-g"], "github.close");
  assert.equal(keys["mod:github"]["cmd-l"], "github.linear");
});

test("main.js sends those commands to modkeys.js's answer", () => {
  const main = read("../main.js");
  assert.match(main, /else if \(c === "close" \|\| c === "linear"\) this\.modKeyPressed\(c === "close" \? "github" : c\);/);
  const body = main.slice(main.indexOf("\n  modKeyPressed("), main.indexOf("\n  }\n", main.indexOf("\n  modKeyPressed(")));
  assert.match(body, /modKey\("github", pressed, this\.backTo\)/);
  assert.match(body, /if \(k\.close\) this\.dismiss\(\);/);
  assert.match(body, /if \(k\.open\) openOverlay\(\{ mod: k\.open\.mod, kind: "dialog"/);
  assert.match(body, /if \(k\.toggle\) run\("mod\.open", \{ name: k\.toggle \}\);/);
});
