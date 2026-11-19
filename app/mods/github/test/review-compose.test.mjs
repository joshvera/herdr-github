// The composer's state machine and its check (compose.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Composer, NOTES, CHECK_MS, BINARY_MS, REPEAT_MS, found, idsOn, request, purpose, sameBody, typedSince } from "../compose.js";

const T0 = 1_800_000_000_000;
const PR = "github.com/acme/app#7";
const target = { kind: "comment", pr: PR, path: "a.go", side: "right", line: 3, text: "x := 1", head: "h1" };
const reply = { kind: "reply", pr: PR, thread: "T1", path: "a.go", line: 3, author: "octocat" };
const comment = (id, body, mine = true) => ({ id, author: mine ? "sam" : "octocat", body, state: "pending", mine, canEdit: mine, canDelete: mine });
const thread = (id, comments, extra = {}) => ({ id, path: "a.go", subject: "line", side: "right", line: 3, resolved: false, comments, ...extra });
const sendOf = (body, ids = [], since = T0) => ({ state: "sending", since, ids, body });

// A composer that pressed cmd-enter at T0 and has sent `body`.
const sent = (body = "Looks off by one.", ids = []) => {
  const c = new Composer(target, null, T0);
  assert.equal(c.press(T0, null), "send");
  c.sending(sendOf(body, ids));
  return c;
};

test("ok closes it", () => {
  const c = sent();
  c.outcome("ok", "", T0 + 500);
  assert.equal(c.phase, "done");
});

test("two deliveries of one press, in one tick, send once", () => {
  const c = new Composer(target, null, T0);
  assert.equal(c.press(T0, null), "send", "the textarea's submit");
  assert.equal(c.press(T0, false), null, "the same press as a key, before the send is even recorded");
  c.sending(sendOf("x"));
  assert.equal(c.press(T0 + 2000, false), null, "nothing sends while one is out");
});

test("a held cmd-enter never sends, and a submit right after a press is its repeat", () => {
  const c = new Composer(target, null, T0);
  assert.equal(c.press(T0, true), null);
  assert.equal(c.press(T0 + 400, null), null, "the textarea's submit has no held flag: this soon, a repeat");
  assert.equal(c.press(T0 + 400 + REPEAT_MS, null), "send", "a press after a pause");
});

test("refused: the text is editable again with GitHub's words, and can be sent again", () => {
  const c = sent();
  c.outcome("refused", "GitHub: Line could not be resolved", T0 + 500);
  assert.equal(c.phase, "editing");
  assert.equal(c.note, "GitHub: Line could not be resolved");
  assert.equal(c.send, null);
  assert.equal(c.press(T0 + 5000, false), "send", "a refusal is known: no second confirm");
});

test("unknown: checking, found by a new id of yours with the text sent", () => {
  const c = sent("Looks off by one.\r\n", ["C1"]);
  c.outcome("unknown", "", T0 + 1000);
  assert.equal(c.phase, "checking");
  assert.equal(c.note, NOTES.unknown);
  const threads = [thread("T1", [comment("C1", "older"), comment("C2", "Looks off by one.")])];
  assert.equal(c.poll(threads, T0 + 1200), "sent");
  assert.equal(c.phase, "done");
});

test("the check isn't answered by a poll started before the send ended", () => {
  const c = sent("hi");
  c.outcome("unknown", "", T0 + 1000);
  const threads = [thread("T1", [comment("C9", "hi")])];
  assert.equal(c.poll(threads, T0 + 999), null);
  assert.equal(c.phase, "checking");
});

test("the check isn't fooled by an older comment with the same text", () => {
  const c = sent("Same words again", ["C1"]);
  c.outcome("unknown", "", T0 + 1000);
  const threads = [thread("T1", [comment("C1", "Same words again")])];
  assert.equal(c.poll(threads, T0 + 2000), "waiting");
  assert.equal(c.note, NOTES.notYet);
  const others = [thread("T1", [comment("C1", "Same words again"), comment("C7", "Same words again", false)])];
  assert.equal(c.poll(others, T0 + 7000), "waiting", "someone else's comment isn't yours");
});

test("not found in 60 s: could not confirm, and sending again needs a second press", () => {
  const c = sent("hi");
  c.outcome("unknown", "", T0 + 1000);
  assert.equal(c.tick(T0 + 1000 + CHECK_MS - 1), null);
  c.poll([], T0 + 6000);
  assert.equal(c.tick(T0 + 1000 + CHECK_MS), "unconfirmed");
  assert.equal(c.phase, "editing");
  assert.equal(c.note, NOTES.unconfirmed);
  assert.equal(c.press(T0 + 70000, null), "ask", "the first cmd-enter only asks");
  assert.equal(c.note, NOTES.again);
  assert.equal(c.press(T0 + 70001, false), null, "the same press arriving again is not the second");
  assert.equal(c.press(T0 + 70100, true), null, "nor is it held");
  assert.equal(c.press(T0 + 71000, false), "send", "a second press sends");
});

test("esc at Send again? keeps the draft unsent and still asks next time", () => {
  const c = sent("hi");
  c.outcome("unknown", "", T0 + 1000);
  c.poll([], T0 + 6000);
  c.tick(T0 + 1000 + CHECK_MS);
  c.press(T0 + 70000, false);
  c.keep();
  assert.equal(c.phase, "editing");
  assert.equal(c.press(T0 + 72000, false), "ask");
});

test("with every poll failing, 60 s still ends in 'could not confirm'", () => {
  const c = sent("hi");
  c.outcome("unknown", "", T0 + 1000);
  assert.equal(c.tick(T0 + 1000 + CHECK_MS), "unconfirmed");
  assert.equal(c.phase, "editing");
});

test("found after more was typed: only the send is let go, the newer text is kept", () => {
  const send = sendOf("first words");
  assert.equal(typedSince({ body: "first words\r\n", send }, send), false, "the same text: the draft goes");
  assert.equal(typedSince({ body: "second thoughts", send }, send), true);
  assert.equal(typedSince({ body: "  ", send }, send), false);
  assert.equal(typedSince(null, send), false);
});

test("reopened with a draft that was sending: it checks before it can be sent", () => {
  const since = T0;
  const draft = { ...target, id: "d", body: "hi", at: since, send: sendOf("hi", ["C1"], since) };
  const now = since + 3000; // the popup came back 3 s after the send began
  const c = new Composer(target, draft, now);
  assert.equal(c.phase, "checking");
  assert.equal(c.note, NOTES.reopened);
  assert.equal(c.press(now + 2000, false), null, "not sendable while checking");
  // The old send may still land until the binary's deadline: a poll before
  // that can find it but can't say it isn't there.
  assert.equal(c.poll([], now + 100), "waiting");
  assert.equal(c.tick(since + BINARY_MS + CHECK_MS - 1), null, "60 s from the binary's deadline, not from the reopen");
  assert.equal(c.poll([thread("T1", [comment("C1", "hi"), comment("C5", "hi")])], since + BINARY_MS + 1), "sent");
});

test("an edit is found by its comment's id and the new text", () => {
  const edit = { kind: "edit", pr: PR, comment: "C3", thread: "T1", path: "a.go", line: 3, published: true };
  const send = sendOf("new words");
  assert.equal(found(edit, send, [thread("T1", [comment("C3", "old words")])]), false);
  assert.equal(found(edit, send, [thread("T1", [comment("C3", "new words\n")])]), true);
});

test("a reply is looked for in its thread only", () => {
  const send = sendOf("ok", []);
  assert.equal(found(reply, send, [thread("T2", [comment("C4", "ok")])]), false);
  assert.equal(found(reply, send, [thread("T1", [comment("C4", "ok")])]), true);
});

test("the ids kept before a send are yours on that target", () => {
  const threads = [
    thread("T1", [comment("C1", "a"), comment("C2", "b", false)]),
    thread("T2", [comment("C3", "c")], { line: 4 }),
    thread("T3", [comment("C4", "d")], { side: "left" }),
  ];
  assert.deepEqual(idsOn(target, threads), ["C1"]);
  assert.deepEqual(idsOn(reply, threads), ["C1"]);
});

test("bodies compare as GitHub keeps them: CRLF and outer whitespace aside", () => {
  assert.ok(sameBody("a\r\nb  \n", "a\nb"));
  assert.ok(!sameBody("a b", "a  b"));
});

test("the request a draft sends, on the head shown", () => {
  assert.deepEqual(request(target, "hi", "h2"), { op: "act", do: "comment", head: "h2", path: "a.go", line: 3, side: "RIGHT", body: "hi" });
  assert.deepEqual(request({ ...target, side: "left" }, "hi", "h2").side, "LEFT");
  assert.deepEqual(request(reply, "hi", "h2"), { op: "act", do: "reply", thread: "T1", body: "hi" });
  assert.deepEqual(request({ kind: "edit", pr: PR, comment: "C3" }, "hi", "h2"), { op: "act", do: "edit", comment: "C3", body: "hi" });
});

test("the line above the composer says what it's for", () => {
  assert.equal(purpose(target), "Comment on a.go line 3 (new side), pending");
  assert.equal(purpose(reply), "Reply to octocat on a.go line 3, pending");
  assert.equal(purpose({ kind: "edit", path: "a.go", line: 3, published: false }), "Edit your pending comment on a.go line 3");
  assert.equal(purpose({ kind: "edit", path: "a.go", line: 3, published: true }), "Edit your published comment on a.go line 3. Changes show at once.");
});

test("a refused resend after 'could not confirm' still asks first next time", () => {
  const c = sent("hi");
  c.outcome("unknown", "", T0 + 1000);
  c.poll([], T0 + 6000);
  c.tick(T0 + 1000 + CHECK_MS);
  c.press(T0 + 70000, false);
  assert.equal(c.press(T0 + 71000, false), "send");
  c.sending(sendOf("hi", [], T0 + 71000));
  c.outcome("refused", "GitHub: Line could not be resolved", T0 + 72000);
  assert.equal(c.press(T0 + 80000, false), "ask", "the first send may still have gone");
});
