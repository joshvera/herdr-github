// The cache's rules (cache.js): run with `node --test app/mods/github/test/*.test.mjs`.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  VERSION, LIMITS, empty, parse, whoOf, sameWho, mergeWho, applyPatch, writeWith, serial, stamper,
  seed, listPatch, resolveRepo, pickedRepo, takesOver, canAct, staleMark, utf8Length,
} from "../cache.js";

const DAY = 24 * 3600 * 1000;
const NOW = 1_800_000_000_000;
const sam = whoOf("", [{ host: "github.com", login: "sam" }], NOW - 1000);
const samLater = { ...sam, at: NOW };
const kim = whoOf("", [{ host: "github.com", login: "kim" }], NOW);

// A file held in memory, with herdr's compare-and-swap.
function memFile(text = null) {
  const f = {
    text,
    writes: 0,
    read: async () => f.text,
    write: async (_p, t, expected) => {
      if (expected !== f.text) throw new Error("stale snapshot");
      f.text = t;
      f.writes++;
    },
  };
  return f;
}

const listsDoc = (who, extra = {}) => ({ ...empty("lists", who), ...extra });

// ── the file format ──────────────────────────────────────────────────────

test("a file with no version, another version, or that doesn't parse is ignored", () => {
  const want = empty("lists");
  assert.deepEqual(parse(JSON.stringify({ login: "sam", lists: { mine: { prs: [1] } } }), "lists"), want);
  assert.deepEqual(parse(JSON.stringify({ version: 1, lists: { mine: { prs: [1], saved: 1 } } }), "lists"), want);
  assert.deepEqual(parse("{not json", "lists"), want);
  assert.deepEqual(parse(null, "lists"), want);
  assert.deepEqual(parse("null", "details"), empty("details"));
});

test("a version 2 file reads back its who and entries", () => {
  const doc = listsDoc(sam, { lists: { mine: { prs: [{ key: "a" }], next: "", saved: 5 } } });
  assert.deepEqual(parse(JSON.stringify(doc), "lists"), doc);
});

test("an old-format file is replaced by the first write", async () => {
  const f = memFile(JSON.stringify({ login: "sam", lists: { mine: { prs: [] } } }));
  assert.equal(await writeWith(f, "p", "lists", { who: sam, lists: { mine: { prs: [], next: "", saved: 1 } } }, () => NOW), true);
  assert.equal(JSON.parse(f.text).version, VERSION);
});

// ── who ──────────────────────────────────────────────────────────────────

test("who is the machine and each signed-in host; none signed in is null", () => {
  assert.deepEqual(whoOf("mac", [{ host: "GitHub.com", login: "sam" }, { host: "ghe.io", error: "x" }], 7), {
    machine: "mac", hosts: [{ host: "github.com", login: "sam" }], at: 7,
  });
  assert.equal(whoOf("", [{ host: "github.com", error: "not signed in" }], 7), null);
});

test("another login, or another machine, is another who; an erroring host is not", () => {
  assert.equal(sameWho(sam, kim), false);
  assert.equal(sameWho(sam, { ...sam, machine: "build-1" }), false);
  const two = whoOf("", [{ host: "github.com", login: "sam" }, { host: "ghe.io", login: "sam-corp" }], 1);
  assert.equal(sameWho(two, sam), true, "ghe.io answering with an error is unknown, not a new account");
  assert.equal(sameWho(sam, null), false);
});

test("a write from another account replaces the whole file, entries and all", async () => {
  const f = memFile(JSON.stringify(listsDoc(sam, {
    lists: { mine: { prs: [{ key: "sams" }], next: "", saved: 1 } },
    spaces: { "k": { repo: "github.com/o/r", found: "github.com/o/r", picked: false, saved: 1 } },
  })));
  await writeWith(f, "p", "lists", { who: kim }, () => NOW);
  const doc = parse(f.text, "lists");
  assert.deepEqual(doc.who, kim);
  assert.deepEqual(doc.lists, {});
  assert.deepEqual(doc.spaces, {});
});

test("a copy still on the old account can't write its entries back after the switch", async () => {
  const f = memFile(JSON.stringify(listsDoc(kim)));
  const ok = await writeWith(f, "p", "lists", { who: sam, lists: { mine: { prs: [{ key: "sams" }], next: "", saved: NOW } } }, () => NOW);
  assert.equal(ok, false);
  assert.deepEqual(parse(f.text, "lists").lists, {});
});

test("details follow the same who rule", async () => {
  const f = memFile(JSON.stringify({ ...empty("details", sam), details: { a: { d: { state: "OPEN" }, saved: 1 } } }));
  await writeWith(f, "p", "details", { who: kim }, () => NOW);
  assert.deepEqual(parse(f.text, "details").details, {});
});

// ── merge on write ───────────────────────────────────────────────────────

test("two writers with newer entries for different keys both survive", async () => {
  const f = memFile();
  await writeWith(f, "p", "lists", { who: sam, lists: { mine: { prs: [1], next: "", saved: 10 } } }, () => NOW);
  await writeWith(f, "p", "lists", { who: samLater, repos: { "github.com/o/r": { prs: [2], next: "", saved: 11 } } }, () => NOW);
  const doc = parse(f.text, "lists");
  assert.deepEqual(doc.lists.mine.prs, [1]);
  assert.deepEqual(doc.repos["github.com/o/r"].prs, [2]);
  assert.equal(doc.who.at, samLater.at, "the later confirmation is kept");
});

test("for the same key the newer saved wins, whichever writes last", () => {
  const doc = listsDoc(sam, { lists: { mine: { prs: ["new"], next: "", saved: 20 } } });
  const older = applyPatch(doc, { who: sam, lists: { mine: { prs: ["old"], next: "", saved: 10 } } }, "lists", NOW);
  assert.deepEqual(older.lists.mine.prs, ["new"]);
  const newer = applyPatch(doc, { who: sam, lists: { mine: { prs: ["newer"], next: "", saved: 30 } } }, "lists", NOW);
  assert.deepEqual(newer.lists.mine.prs, ["newer"]);
});

test("a patch with no who writes nothing", () => {
  assert.equal(applyPatch(empty("lists"), { lists: { mine: { saved: 1 } } }, "lists", NOW), null);
});

test("caps apply to the merged result: details keep the newest 50", () => {
  const details = {};
  for (let i = 0; i < LIMITS.details; i++) details[`pr${i}`] = { d: { state: "OPEN" }, saved: 100 + i };
  const doc = { ...empty("details", sam), details };
  const out = applyPatch(doc, { who: sam, details: { fresh: { d: { state: "OPEN" }, saved: 1000 } } }, "details", NOW);
  assert.equal(Object.keys(out.details).length, LIMITS.details);
  assert.ok(out.details.fresh);
  assert.equal(out.details.pr0, undefined, "the oldest went");
});

test("a pruned entry isn't brought back by the other writer", () => {
  const details = {};
  for (let i = 0; i < LIMITS.details; i++) details[`pr${i}`] = { d: { state: "OPEN" }, saved: 100 + i };
  const afterA = applyPatch({ ...empty("details", sam), details }, { who: sam, details: { a: { d: {}, saved: 1000 } } }, "details", NOW);
  assert.equal(afterA.details.pr0, undefined);
  // B had pr0 too, from before, and writes it with its own new entry.
  const afterB = applyPatch(afterA, { who: sam, details: { pr0: { d: { state: "OPEN" }, saved: 100 }, b: { d: {}, saved: 1001 } } }, "details", NOW);
  assert.equal(afterB.details.pr0, undefined);
  assert.ok(afterB.details.a && afterB.details.b);
});

test("a merged or closed PR's detail goes once it's a day old; an open one stays", () => {
  const doc = { ...empty("details", sam), details: {
    merged: { d: { state: "MERGED" }, saved: NOW - DAY - 1 },
    closed: { d: { state: "CLOSED" }, saved: NOW - DAY - 1 },
    fresh: { d: { state: "MERGED" }, saved: NOW - 1000 },
    open: { d: { state: "OPEN" }, saved: NOW - 5 * DAY },
  } };
  const out = applyPatch(doc, { who: sam }, "details", NOW);
  assert.deepEqual(Object.keys(out.details).sort(), ["fresh", "open"]);
});

test("details stay under the byte budget however big each is", () => {
  const body = "x".repeat(20 * 1024);
  const details = {};
  for (let i = 0; i < LIMITS.details; i++) details[`pr${i}`] = { d: { state: "OPEN", body }, saved: 100 + i };
  const out = applyPatch({ ...empty("details", sam), details }, { who: sam }, "details", NOW);
  assert.ok(utf8Length(JSON.stringify(out)) < LIMITS.detailBytes + 1024);
  assert.ok(out.details[`pr${LIMITS.details - 1}`], "the newest stays");
  assert.equal(out.details.pr0, undefined, "the oldest goes");
});

test("repos and spaces keep the newest 30, and repos give way to the byte budget", () => {
  const repos = {};
  const spaces = {};
  for (let i = 0; i < 40; i++) {
    repos[`github.com/o/r${i}`] = { prs: [], next: "", saved: i };
    spaces[`:/s${i}`] = { repo: "", found: "", picked: false, saved: i };
  }
  const out = applyPatch(listsDoc(sam, { repos, spaces }), { who: sam }, "lists", NOW);
  assert.equal(Object.keys(out.repos).length, LIMITS.repos);
  assert.equal(Object.keys(out.spaces).length, LIMITS.spaces);
  assert.ok(out.repos["github.com/o/r39"] && !out.repos["github.com/o/r0"]);

  const row = { key: "x", title: "y".repeat(1000) };
  const big = {};
  for (let i = 0; i < 30; i++) big[`github.com/o/b${i}`] = { prs: Array(30).fill(row), next: "", saved: i };
  const capped = applyPatch(listsDoc(sam, { repos: big, lists: { mine: { prs: Array(30).fill(row), next: "", saved: 1 } } }), { who: sam }, "lists", NOW);
  assert.ok(utf8Length(JSON.stringify(capped)) <= LIMITS.listBytes);
  assert.ok(capped.lists.mine, "Mine is never dropped for room");
  assert.ok(capped.repos["github.com/o/b29"], "the newest repo stays");
});

// ── the write loop ───────────────────────────────────────────────────────

test("a rejected compare-and-swap reads again, merges again and retries", async () => {
  const f = memFile();
  let raced = false;
  const io = {
    read: f.read,
    write: async (p, t, expected) => {
      if (!raced) {
        raced = true;
        // Another copy writes between our read and our write.
        f.text = JSON.stringify(listsDoc(sam, { lists: { review: { prs: ["theirs"], next: "", saved: 5 } } }));
      }
      return f.write(p, t, expected);
    },
  };
  assert.equal(await writeWith(io, "p", "lists", { who: sam, lists: { mine: { prs: ["ours"], next: "", saved: 6 } } }, () => NOW), true);
  const doc = parse(f.text, "lists");
  assert.deepEqual(doc.lists.review.prs, ["theirs"]);
  assert.deepEqual(doc.lists.mine.prs, ["ours"]);
});

test("three rejections give up without throwing", async () => {
  let tries = 0;
  const io = { read: async () => null, write: async () => { tries++; throw new Error("stale snapshot"); } };
  assert.equal(await writeWith(io, "p", "lists", { who: sam }, () => NOW), false);
  assert.equal(tries, 3);
});

test("a file that can't be read gives up without throwing", async () => {
  const io = { read: async () => { throw new Error("too big"); }, write: async () => assert.fail("no write") };
  assert.equal(await writeWith(io, "p", "details", { who: sam }, () => NOW), false);
});

test("writes in one copy run one at a time, in order", async () => {
  const run = serial();
  const log = [];
  let release;
  const gate = new Promise((r) => (release = r));
  const a = run(async () => { log.push("a start"); await gate; log.push("a end"); });
  const b = run(async () => { log.push("b"); });
  const c = run(async () => { throw new Error("c fails"); });
  const d = run(async () => { log.push("d"); });
  await Promise.resolve();
  release();
  await Promise.all([a, b, d, c.catch(() => {})]);
  assert.deepEqual(log, ["a start", "a end", "b", "d"]);
});

test("request stamps always go up, even within one millisecond", () => {
  const stamp = stamper(() => 5);
  assert.deepEqual([stamp(), stamp(), stamp()], [5, 6, 7]);
});

// ── seeding ──────────────────────────────────────────────────────────────

test("each tab seeds from the cache", () => {
  const doc = listsDoc(sam, {
    lists: { mine: { prs: ["m"], next: "c", saved: 1 }, review: { prs: ["r"], next: "", saved: 2 } },
    repos: { "github.com/o/r": { prs: ["o"], next: "", saved: 3 } },
  });
  const lists = { mine: { prs: [] }, review: { prs: [] }, repo: { prs: [] } };
  seed(lists.mine, doc.lists.mine);
  seed(lists.review, doc.lists.review);
  seed(lists.repo, doc.repos["github.com/o/r"]);
  assert.deepEqual([lists.mine.prs, lists.review.prs, lists.repo.prs], [["m"], ["r"], ["o"]]);
  assert.equal(lists.mine.cached && lists.mine.loaded, true);
  assert.equal(lists.repo.saved, 3);
});

test("a live answer is never overwritten by a late cache read", () => {
  const l = { prs: ["live"], next: "", loaded: true, cached: false };
  assert.equal(seed(l, { prs: ["old"], next: "", saved: 1 }), false);
  assert.deepEqual(l.prs, ["live"]);
});

test("seeding keeps the list object, so a load in flight still answers into it", () => {
  const l = { prs: [], loading: true };
  const held = l;
  seed(l, { prs: ["c"], next: "", saved: 1 });
  assert.equal(held.loading, true);
  assert.deepEqual(held.prs, ["c"]);
});

// ── repo capture ─────────────────────────────────────────────────────────

test("an answer for repo A arriving after a switch to B is stored under A and not shown", () => {
  const lists = { repo: { prs: [], spec: "github.com/o/a", loading: true } };
  const asked = lists.repo; // the load for A holds its list and its spec
  const spec = asked.spec;
  lists.repo = { prs: [], spec: "github.com/o/b" }; // Change repo
  asked.prs = ["a's row"];
  const patch = listPatch(sam, "repo", spec, asked, 9);
  assert.deepEqual(Object.keys(patch.repos), ["github.com/o/a"]);
  assert.notEqual(lists.repo, asked);
  assert.deepEqual(lists.repo.prs, []);
});

test("Mine and Review are kept under their tab", () => {
  assert.deepEqual(listPatch(sam, "mine", "github.com/o/a", { prs: [1], next: "n" }, 3), { who: sam, lists: { mine: { prs: [1], next: "n", saved: 3 } } });
});

// ── the remembered repo ──────────────────────────────────────────────────

const A = "github.com/o/a";
const B = "github.com/o/b";

test("findRepo answering the remembered repo changes nothing", () => {
  assert.deepEqual(resolveRepo({ repo: A, found: A, picked: false }, { kind: "found", spec: A }), { spec: A, keep: null });
});

test("findRepo answering another repo replaces it", () => {
  assert.deepEqual(resolveRepo({ repo: A, found: A, picked: false }, { kind: "found", spec: B }), { spec: B, keep: { repo: B, found: B, picked: false } });
  assert.deepEqual(resolveRepo(null, { kind: "found", spec: B }), { spec: B, keep: { repo: B, found: B, picked: false } });
});

test("a real 'no GitHub remote' clears the tab; no answer keeps the remembered repo", () => {
  assert.deepEqual(resolveRepo({ repo: A, found: A, picked: false }, { kind: "none" }), { spec: null, keep: { repo: "", found: "", picked: false } });
  assert.deepEqual(resolveRepo({ repo: A, found: A, picked: false }, { kind: "failed" }), { spec: A, keep: null });
  assert.deepEqual(resolveRepo(null, { kind: "failed" }), { spec: null, keep: null });
});

test("a picked repo wins until the folder's remote changes", () => {
  const picked = pickedRepo({ repo: A, found: A, picked: false }, B);
  assert.deepEqual(picked, { repo: B, found: A, picked: true });
  assert.deepEqual(resolveRepo(picked, { kind: "found", spec: A }), { spec: B, keep: null });
  const moved = "github.com/o/c";
  assert.deepEqual(resolveRepo(picked, { kind: "found", spec: moved }), { spec: moved, keep: { repo: moved, found: moved, picked: false } });
});

// ── a PR's detail ────────────────────────────────────────────────────────

test("a cached detail fills an empty screen but never replaces a live one", () => {
  assert.equal(takesOver(null, { at: 1, cached: true }), true);
  assert.equal(takesOver({ at: 1, cached: false }, { at: 5, cached: true }), false);
});

test("a warm answer older than the shown one doesn't replace it", () => {
  assert.equal(takesOver({ at: 10, cached: true }, { at: 5, cached: true }), false);
  assert.equal(takesOver({ at: 10, cached: false }, { at: 5, cached: false }), false);
  assert.equal(takesOver({ at: 5, cached: true }, { at: 10, cached: true }), true);
});

test("a live answer replaces a cached one, and a later live one an earlier", () => {
  assert.equal(takesOver({ at: 10, cached: true }, { at: 5, cached: false }), true, "the cached one locks actions; this copy's own answer must unlock them");
  assert.equal(takesOver({ at: 5, cached: false }, { at: 10, cached: false }), true);
});

test("canAct: false while cached, false after a failed refresh, true after a fresh answer", () => {
  const cached = { d: { number: 1 }, at: 1, cached: true };
  assert.equal(canAct(cached), false);
  assert.equal(canAct({ ...cached, error: "timed out" }), false);
  assert.equal(canAct({ d: { number: 1 }, at: 2, cached: false }), true);
  assert.equal(canAct(null), false);
  assert.equal(canAct({ d: null, at: 1, cached: false }), false);
});

test("the stale mark says it's refreshing, or why not, with the age; nothing when live", () => {
  const at = new Date(2026, 10, 18, 14, 2).getTime();
  assert.equal(staleMark(false, at, ""), "");
  assert.equal(staleMark(true, at, ""), "Refreshing… · from 14:02");
  assert.equal(staleMark(true, at, "timed out"), "timed out · showing from 14:02");
  assert.equal(staleMark(true, at, "", false), "from 14:02");
});

test("a host that errored once is kept in who, so a later sign-in as someone else there is caught", async () => {
  const both = whoOf("", [{ host: "github.com", login: "alice" }, { host: "ghe.io", login: "bob" }], 1);
  const flaky = whoOf("", [{ host: "github.com", login: "alice" }, { host: "ghe.io", error: "timeout" }], 2);
  const f = memFile();
  await writeWith(f, "p", "lists", { who: both }, () => NOW);
  await writeWith(f, "p", "lists", { who: flaky }, () => NOW);
  const kept = parse(f.text, "lists").who;
  assert.deepEqual(kept.hosts, both.hosts, "ghe.io's bob survives the flaky confirmation");
  assert.equal(kept.at, 2);
  const carol = whoOf("", [{ host: "github.com", login: "alice" }, { host: "ghe.io", login: "carol" }], 3);
  assert.equal(sameWho(kept, carol), false);
  assert.deepEqual(mergeWho(flaky, both).hosts, both.hosts, "order of arguments doesn't matter");
});

test("a repo picked in a folder with no GitHub remote stays picked", () => {
  const picked = pickedRepo({ repo: "", found: "", picked: false }, A);
  assert.deepEqual(resolveRepo(picked, { kind: "none" }), { spec: A, keep: null });
  assert.deepEqual(resolveRepo(picked, { kind: "found", spec: B }), { spec: B, keep: { repo: B, found: B, picked: false } }, "a remote appearing is a change");
});
