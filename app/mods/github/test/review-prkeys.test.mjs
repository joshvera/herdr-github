// The PR screen's key routing (prkeys.js): run with `node --test app/mods/github/test/*.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { tabFor, prRoute } from "../prkeys.js";

test("1 2 3, tab and shift-tab pick tabs", () => {
  assert.equal(tabFor("3", "overview"), "files");
  assert.equal(tabFor("tab", "files"), "overview");
  assert.equal(tabFor("shift-tab", "overview"), "files");
  assert.equal(tabFor("x", "files"), null);
});

test("the PR's actions never reach the Files tab", () => {
  for (const k of ["m", "d", "w", "s", "a", "l", "c", "x", "h"]) {
    assert.equal(prRoute(k, "files", false), "ignore", `${k} on Files`);
  }
  assert.equal(prRoute("d", "overview", false), "action");
});

test("a held key that changes something does nothing", () => {
  assert.equal(prRoute("d", "overview", false, true), "ignore");
  assert.equal(prRoute("r", "files", false, true), "ignore");
  assert.equal(prRoute("j", "checks", false, true), "checks");
});
