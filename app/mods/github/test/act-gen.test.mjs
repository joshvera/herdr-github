// A change from the Overview is built from the detail shown, and that detail
// was read as one account. Between who changing (main's forget, gen++) and
// settle dropping the detail (up to 200 ms), it's still on screen and live:
// nothing may act on it, and what was built from it carries its gen, so
// mutation.js refuses it as the new account.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canAct } from "../cache.js";
import { sendOnce } from "../mutation.js";

test("a live detail read as one account can't be acted on once who has changed", () => {
  const shown = { d: { number: 1 }, at: 2, cached: false, gen: 1 };
  assert.equal(canAct(shown, 1), true, "the account it was read as");
  assert.equal(canAct(shown, 2), false, "who changed since: settle hasn't dropped it yet");
});

test("a change made from that detail carries its gen: sent as the new account, it's refused and nothing runs", async () => {
  const shown = { d: { number: 1 }, at: 2, cached: false, gen: 1 };
  let runs = 0;
  const r = await sendOnce({
    who: { finding: () => null, live: () => true, find: async () => {}, gen: () => 2, made: shown.gen },
    prepare: async () => "/bin/hg",
    run: async () => {
      runs++;
      return { stdout: '{"ok":true}' };
    },
  });
  assert.equal(r.kind, "refused");
  assert.match(r.error, /^Nothing was sent: /);
  assert.equal(runs, 0);
});
