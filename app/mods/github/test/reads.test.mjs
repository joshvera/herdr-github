// When a read may look for GitHub again (reads.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { askSignedIn, NOT_YET } from "../reads.js";

// A machine that may drop the exec, and a search that counts itself.
function rig({ chosen = true, fails = 1 } = {}) {
  const r = { chosen, fails, asks: 0, finds: 0 };
  r.args = (auto) => ({
    ask: async () => {
      r.asks++;
      if (r.fails-- > 0) throw new Error("exec: connection lost");
      return { ok: true };
    },
    find: async () => {
      r.finds++;
      r.chosen = true;
    },
    chosen: () => r.chosen,
    settled: (e) => e?.settled === true,
    auto,
  });
  return r;
}

test("an automatic read that fails just fails: no search, so no who change", async () => {
  const r = rig();
  await assert.rejects(askSignedIn(r.args(true)), /connection lost/);
  assert.equal(r.finds, 0);
  assert.equal(r.asks, 1);
});

test("an automatic read with no machine chosen fails without searching", async () => {
  const r = rig({ chosen: false, fails: 0 });
  await assert.rejects(askSignedIn(r.args(true)), new RegExp(NOT_YET));
  assert.equal(r.finds, 0);
  assert.equal(r.asks, 0);
});

test("a read a person asked for looks again once, and asks once more", async () => {
  const r = rig();
  assert.deepEqual(await askSignedIn(r.args(false)), { ok: true });
  assert.equal(r.finds, 1);
  assert.equal(r.asks, 2);
});

test("a person's read with no machine chosen looks first", async () => {
  const r = rig({ chosen: false, fails: 0 });
  await askSignedIn(r.args(false));
  assert.equal(r.finds, 1);
  assert.equal(r.asks, 1);
});

test("an answer from GitHub or the machine (settled) isn't asked elsewhere", async () => {
  const r = rig({ fails: 0 });
  const args = r.args(false);
  args.ask = async () => {
    r.asks++;
    throw Object.assign(new Error("HTTP 404"), { settled: true });
  };
  await assert.rejects(askSignedIn(args), /404/);
  assert.equal(r.finds, 0);
});
