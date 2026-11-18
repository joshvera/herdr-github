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
