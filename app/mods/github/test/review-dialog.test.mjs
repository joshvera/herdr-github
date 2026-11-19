// The submit dialog (dialog.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { SubmitDialog, DIALOG_NOTES, CHECK_MS, SKEW_MS } from "../dialog.js";
import { route } from "../reviewkeys.js";

const T0 = 1_800_000_000_000;
const review = (comments, id = "PRR_1") => ({ id, comments });
const open = (r = review(7), mine = false, submitted = null) => new SubmitDialog({ review: r, mine, submitted });
// Picks with the choices focused, as the keys come.
const keys = (d, ks, body = "", t = T0) => ks.map((k, i) => d.key(k, false, body, t + i * 2000));

test("the dialog takes tab and 1 2 3: none of them reach the PR's tabs", () => {
  for (const k of ["tab", "shift-tab", "1", "2", "3", "x", "j", "escape"]) {
    assert.equal(route({ keyboard: "view", dialog: true }, k, false), "dialog", k);
  }
  assert.equal(route({ keyboard: "body", dialog: true }, "tab", false), "dialog", "tab leaves the body box");
  assert.equal(route({ keyboard: "body", dialog: true }, "1", false), "type", "1 is typed in the body");
  assert.equal(route({ keyboard: "body", dialog: true }, "cmd-enter", false), "send");
});

test("tab moves between the body and the choices; 1 2 3 pick when the body hasn't the keyboard", () => {
  const d = open();
  assert.deepEqual(d.key("tab", false, "", T0), { do: "focus-choices" });
  assert.deepEqual(d.key("2", false, "", T0), { do: "none" });
  assert.equal(d.pick, "approve");
  d.key("3", false, "", T0);
  assert.equal(d.pick, "request_changes");
  assert.deepEqual(d.key("tab", false, "", T0), { do: "focus-body" });
});

test("a held key does nothing in the dialog", () => {
  const d = open();
  assert.deepEqual(d.key("2", true, "", T0), { do: "none" });
  assert.equal(d.pick, "comment");
  assert.deepEqual(d.key("cmd-enter", true, "", T0), { do: "none" });
  assert.equal(d.phase, "choose");
});

test("what's offered: no approve or request changes on your own PR; no comment with nothing to say", () => {
  assert.deepEqual(open(review(7), true).offered("").map((c) => c.id), ["comment", "discard"]);
  assert.deepEqual(open(null, false).offered("").map((c) => c.id), ["approve", "request_changes"]);
  assert.deepEqual(open(null, false).offered("lgtm").map((c) => c.id), ["comment", "approve", "request_changes"]);
  const mine = open(review(7), true);
  assert.equal(mine.key("2", false, "", T0).do, "say");
  assert.equal(mine.pick, "comment");
});

test("submit sends the review shown and the count shown at the press", () => {
  const d = open(review(7));
  d.key("3", false, "", T0);
  assert.equal(d.button("Please split this."), "Submit: request changes, 7 comments");
  d.follow(review(8), null, T0 + 1000);
  assert.equal(d.flashing(T0 + 1500), "Now 8");
  const step = d.press(T0 + 2000, false, "Please split this.");
  assert.deepEqual(step, { do: "send", req: { op: "act", do: "submit", reviewId: "PRR_1", count: 8, event: "request_changes", body: "Please split this." } });
  assert.equal(d.phase, "sending");
  assert.equal(d.press(T0 + 4000, false, "x").do, "none", "nothing more while it's out");
});

test("a changed-review refusal keeps the dialog open with the new count, and needs cmd-enter again", () => {
  const d = open(review(7));
  d.press(T0, false, "");
  d.outcome("refused", { error: "Your pending review changed (now 9 comments). Nothing was sent.", changed: true, review: review(9) }, "Your pending review changed (now 9 comments). Nothing was sent.", T0 + 500);
  assert.equal(d.phase, "choose");
  assert.equal(d.count, 9);
  assert.equal(d.flashing(T0 + 600), "Now 9");
  assert.match(d.note, /changed/);
  assert.equal(d.press(T0 + 3000, false, "").req.count, 9);
});

test("one press delivered twice (the body's submit and the key) sends once", () => {
  const d = open(review(1));
  assert.equal(d.press(T0, null, "").do, "send");
  assert.equal(d.press(T0 + 1, false, "").do, "none");
});

test("discard: typed 'discard' and enter sends the review and count shown; anything else cancels", () => {
  const d = open(review(7));
  d.key("tab", false, "", T0);
  d.key("down", false, "", T0);
  d.key("down", false, "", T0);
  d.key("down", false, "", T0);
  assert.equal(d.pick, "discard");
  assert.equal(d.button(""), "Discard review");
  assert.deepEqual(d.key("cmd-enter", false, "", T0), { do: "focus-choices" });
  assert.equal(d.phase, "discard");
  assert.match(d.discardLine(), /its 7 comments\? This cannot be undone\. Type discard and press enter\./);
  for (const k of "disc") d.key(k, false, "", T0);
  assert.equal(d.key("enter", false, "", T0).do, "say", "enter before it's all typed cancels");
  assert.equal(d.phase, "choose");
  d.key("enter", false, "", T0 + 2000);
  assert.equal(d.phase, "discard");
  for (const k of "dix") d.key(k, false, "", T0 + 2000);
  assert.equal(d.phase, "choose", "a wrong letter cancels");
  d.key("enter", false, "", T0 + 4000);
  for (const k of "discard") d.key(k, false, "", T0 + 4000);
  assert.deepEqual(d.key("enter", false, "", T0 + 4000), { do: "send", req: { op: "act", do: "discard", reviewId: "PRR_1", count: 7 } });
});

test("held letters never type 'discard'", () => {
  const d = open(review(7));
  d.pick = "discard";
  d.press(T0, false, "");
  for (const k of "discard") d.key(k, true, "", T0);
  assert.equal(d.typed, "");
});

test("unknown with a review: the review gone from a later poll means it went through", () => {
  const d = open(review(7));
  d.press(T0, false, "");
  d.outcome("unknown", { error: "x", unknown: true }, "x", T0 + 1000);
  assert.equal(d.note, DIALOG_NOTES.unknown);
  assert.equal(d.poll({ review: null }, T0 + 999), null, "a poll from before the send ended says nothing");
  assert.equal(d.poll({ review: review(7) }, T0 + 2000), "waiting");
  assert.equal(d.poll({ review: null }, T0 + 7000), "sent");
  assert.equal(d.note, DIALOG_NOTES.gone);
});

test("unknown without a review: only a new submitted review of yours, from after the send, counts (A6)", () => {
  const before = { id: "PRR_old", at: T0 - 3_600_000 };
  const d = open(null, false, before);
  d.key("tab", false, "", T0);
  d.key("2", false, "", T0);
  d.press(T0, false, "");
  d.outcome("unknown", null, "x", T0 + 1000);
  assert.equal(d.poll({ review: null, submitted: before }, T0 + 2000), "waiting", "the review that was already there");
  assert.equal(d.poll({ review: null, submitted: { id: "PRR_ancient", at: T0 - SKEW_MS - 1 } }, T0 + 7000), "waiting", "older than the send");
  assert.equal(d.poll({ review: null, submitted: { id: "PRR_new", at: T0 - 2000 } }, T0 + 12000), "sent", "GitHub's clock a little behind ours");
});

test("not found in 60 s: could not confirm, and sending again needs a second press", () => {
  const d = open(review(7));
  d.press(T0, false, "");
  d.outcome("unknown", null, "x", T0 + 1000);
  assert.equal(d.tick(T0 + 1000 + CHECK_MS), null, "no poll has looked yet");
  d.poll({ review: review(7) }, T0 + 6000);
  assert.equal(d.tick(T0 + 1000 + CHECK_MS), "unconfirmed");
  assert.equal(d.note, DIALOG_NOTES.unconfirmed);
  assert.deepEqual(d.press(T0 + 70000, false, ""), { do: "focus-choices" });
  assert.equal(d.note, DIALOG_NOTES.again);
  assert.equal(d.key("cmd-enter", false, "", T0 + 70001).do, "none", "the same press, again");
  assert.equal(d.key("cmd-enter", false, "", T0 + 71000).do, "send");
});

test("a refused resend still asks first next time", () => {
  const d = open(review(7));
  d.press(T0, false, "");
  d.outcome("unknown", null, "x", T0 + 1000);
  d.poll({ review: review(7) }, T0 + 6000);
  d.tick(T0 + 1000 + CHECK_MS);
  d.press(T0 + 70000, false, "");
  d.key("cmd-enter", false, "", T0 + 71000);
  d.outcome("refused", null, "Can not approve your own pull request", T0 + 72000);
  assert.deepEqual(d.press(T0 + 80000, false, ""), { do: "focus-choices" }, "asks, not sends");
});

test("the count follows a poll while the dialog is open, and says when the review is gone", () => {
  const d = open(review(7));
  d.pick = "discard";
  d.follow(null, null, T0);
  assert.equal(d.countLine(), "No pending comments");
  assert.equal(d.flashing(T0), "Your pending review is gone.");
  assert.equal(d.pick, "comment", "nothing left to discard");
  assert.equal(d.flashing(T0 + 10000), "");
});
