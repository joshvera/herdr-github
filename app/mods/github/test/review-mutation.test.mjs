// Sending a mutation once, and ordering polls against it (mutation.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { sendOnce, classify, MutationGate } from "../mutation.js";

// A run that counts how often it was called.
const counted = (impl) => {
  const f = async (bin) => {
    f.calls++;
    return impl(bin);
  };
  f.calls = 0;
  return f;
};

test("an answer without an error is ok, and the request ran once", async () => {
  const run = counted(() => ({ stdout: '{"ok":true,"comment":{"id":"PRRC_1"}}' }));
  const r = await sendOnce({ prepare: async () => "/bin/hg", run });
  assert.equal(r.kind, "ok");
  assert.equal(r.answer.comment.id, "PRRC_1");
  assert.equal(run.calls, 1);
});

test("GitHub's refusal is refused, and keeps the whole answer", async () => {
  const run = counted(() => ({ stdout: '{"error":"Line could not be resolved","review":{"id":"PRR_1","comments":2}}' }));
  const r = await sendOnce({ prepare: async () => "/bin/hg", run });
  assert.equal(r.kind, "refused");
  assert.equal(r.error, "Line could not be resolved");
  assert.equal(r.answer.review.comments, 2);
  assert.equal(run.calls, 1);
});

test("an answer marked unknown is unknown, not refused", async () => {
  const r = await sendOnce({ prepare: async () => "/bin/hg", run: async () => ({ stdout: '{"error":"HTTP 502","unknown":true}' }) });
  assert.equal(r.kind, "unknown");
  assert.equal(r.answer.unknown, true);
});

test("exec rejecting (a timeout, a lost machine) is unknown, and is not tried again", async () => {
  const run = counted(() => {
    throw new Error("timed out");
  });
  const r = await sendOnce({ prepare: async () => "/bin/hg", run });
  assert.equal(r.kind, "unknown");
  assert.equal(run.calls, 1);
});

test("output that isn't JSON is unknown: the binary may have died after sending", () => {
  assert.equal(classify("panic: runtime error").kind, "unknown");
  assert.equal(classify("").kind, "unknown");
  assert.equal(classify(undefined).kind, "unknown");
  assert.equal(classify("null").kind, "unknown");
  assert.equal(classify("42").kind, "unknown");
});

test("failing to find the binary is refused, and nothing runs", async () => {
  const run = counted(() => ({ stdout: "{}" }));
  const r = await sendOnce({
    prepare: async () => {
      throw new Error("no release for this machine");
    },
    run,
  });
  assert.equal(r.kind, "refused");
  assert.match(r.error, /Nothing was sent/);
  assert.equal(run.calls, 0);
});

test("a poll that started before a mutation ended is dropped, and owed again", () => {
  const g = new MutationGate();
  const stamp = g.startPoll();
  assert.notEqual(stamp, null);
  g.begin();
  assert.equal(g.end(), true);
  assert.equal(g.fresh(stamp), false);
  assert.equal(g.takeOwed(), true);
  assert.equal(g.takeOwed(), false, "owed once");
  const again = g.startPoll();
  assert.equal(g.fresh(again), true);
});

test("no poll starts while a mutation is out; one is owed when it ends", () => {
  const g = new MutationGate();
  g.begin();
  assert.equal(g.startPoll(), null);
  assert.equal(g.takeOwed(), false, "not while still out");
  g.end();
  assert.equal(g.takeOwed(), true);
});

test("two mutations out: polls wait for both", () => {
  const g = new MutationGate();
  g.begin();
  g.begin();
  assert.equal(g.end(), false);
  assert.equal(g.startPoll(), null);
  assert.equal(g.end(), true);
  assert.notEqual(g.startPoll(), null);
});

test("a poll that started after the mutation ended is used", () => {
  const g = new MutationGate();
  g.begin();
  g.end();
  g.takeOwed();
  const stamp = g.startPoll();
  assert.equal(g.fresh(stamp), true);
});

// Who a change goes as (sendOnce's `who`): a fake of main's status search.
// `live`: status has said who this opening; `gen`: moves when who changes.
function account({ live = true, gen = 0, finding = null, find = async () => {} } = {}) {
  const a = { live, gen, finding, finds: 0 };
  a.who = {
    finding: () => a.finding,
    live: () => a.live,
    find: async () => {
      a.finds++;
      await find(a);
      a.live = true;
    },
    gen: () => a.gen,
    made: gen,
  };
  return a;
}
const okRun = () => counted(() => ({ stdout: '{"ok":true}' }));

test("who only from the cache: status is asked before anything is sent", async () => {
  const a = account({ live: false });
  const run = okRun();
  const r = await sendOnce({ who: a.who, prepare: async () => "/bin/hg", run });
  assert.equal(a.finds, 1, "status asked first");
  assert.equal(r.kind, "ok");
  assert.equal(run.calls, 1);
});

test("a status search already out is waited for, and not asked again", async () => {
  const a = account({ live: false });
  let done;
  a.finding = new Promise((resolve) => (done = resolve)).then(() => {
    a.live = true;
    a.finding = null;
  });
  const run = okRun();
  const sending = sendOnce({ who: a.who, prepare: async () => "/bin/hg", run });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(run.calls, 0, "nothing sent while status is out");
  done();
  const r = await sending;
  assert.equal(r.kind, "ok");
  assert.equal(a.finds, 0, "the search out was enough");
  assert.equal(run.calls, 1);
});

test("status failing refuses: nothing was sent, and nothing runs", async () => {
  const a = account({ live: false, find: async () => { throw new Error("no machine answered"); } });
  const run = okRun();
  const r = await sendOnce({ who: a.who, prepare: async () => "/bin/hg", run });
  assert.equal(r.kind, "refused");
  assert.match(r.error, /^Nothing was sent: .*no machine answered/);
  assert.equal(run.calls, 0);
});

test("a status search out that fails refuses too", async () => {
  const a = account({ live: false });
  a.finding = Promise.reject(new Error("gh isn't signed in"));
  a.finding.catch(() => {});
  const run = okRun();
  const r = await sendOnce({ who: a.who, prepare: async () => "/bin/hg", run });
  assert.equal(r.kind, "refused");
  assert.match(r.error, /^Nothing was sent: /);
  assert.equal(run.calls, 0);
});

test("made under one who, sent as another: refused, nothing runs", async () => {
  // Status, while the change waited on it, found someone else signed in.
  const a = account({ live: false, find: async (a) => void a.gen++ });
  const run = okRun();
  const r = await sendOnce({ who: a.who, prepare: async () => "/bin/hg", run });
  assert.equal(r.kind, "refused");
  assert.match(r.error, /^Nothing was sent: /);
  assert.equal(run.calls, 0);
});

test("a change made before who changed is refused even when status needn't be asked", async () => {
  const a = account({ live: true });
  a.gen++;
  const run = okRun();
  const r = await sendOnce({ who: a.who, prepare: async () => "/bin/hg", run });
  assert.equal(r.kind, "refused");
  assert.equal(run.calls, 0);
});

test("confirmed and unchanged: sent once, status not asked", async () => {
  const a = account({ live: true });
  const run = okRun();
  const r = await sendOnce({ who: a.who, prepare: async () => "/bin/hg", run });
  assert.equal(r.kind, "ok");
  assert.equal(a.finds, 0);
  assert.equal(run.calls, 1);
});
