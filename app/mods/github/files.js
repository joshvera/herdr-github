// The PR screen's Files changed tab: the PR's changed files as a tree at the
// left, one file's diff at the right with its review threads between the
// lines they're on. Every move is one key. What it changes on GitHub: a
// file's viewed mark (through main's mutate), and the review (c comments
// or replies, x resolves, e edits, shift-d deletes, shift-s submits or
// discards), each through `send`, once.
//
// Everything shown is from one head commit (`files` names it). A diff is
// asked for only once `files` has answered, one at a time, for that head:
// the open file's first, then the one after it, so ] lands on rows that are
// already here. Answers are kept until the head moves; a failed one is kept
// as its error until r. When GitHub says the head moved, `files` is read
// again and the tab says so.
//
//   ┌ filter ──────────┐ ┌ M Sources/Sync/SyncEngine.swift  +7 −3 ───────┐
//   │ 9 files · 2 seen │ │ 138 138   let remote = …                       │
//   │ Package.swift    │ │ 140     - // Last write wins.                  │
//   │ Sources/Sync     │ │     142 + timeout: .seconds(20))               │
//   │   SyncEngine  1 ◻│ │   ● line 142 · jonas · 2 comments              │
//   └──────────────────┘ └────────────────────────────────────────────────┘
//
// main.js makes one per PR opened (openPR) and gives it every key on this
// tab first; see `key`. Its filter's InputState, the composer's and the
// submit dialog's TextareaStates and the lists' scroll handles are main's (made in init, as
// the runtime wants), passed as `ui`.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input, Textarea, Scrollbar, v_virtual_list } from "gpui-base";
import { createHash } from "crypto";
import { icon, tint, MONO } from "./look.js";
import { treeRows, matchesPath, statusMark } from "./filetree.js";
import { diffItems } from "./diffitems.js";
import { TREE_ROW_H, treeRow, viewedMark, diffItem } from "./filesdraw.js";
import { applyPoll, countThreads, refind, shiftedAbove, PollHealth, HOLD_MS, reviewsOf } from "./follow.js";
import { route, reviewAction, deletePrompt, latestMine, mayMoveKeyboard, NEW_COMMITS, OLDER_COMMIT } from "./reviewkeys.js";
import { withResolved, withComment, withReply, withEdit, withoutComment, withoutPending, answerChecks, viewedAfter, leaveNote, CHECK_MS } from "./sent.js";
import { DraftStore, DRAFTS_KEY, DEMO_DRAFTS_KEY, SAVE_MS, draftId, makeDraft, rowOf, rowTarget, placeDrafts, unplaced, droppedNote } from "./drafts.js";
import { SubmitDialog, CHOICES, DIALOG_NOTES } from "./dialog.js";
import { Composer, CHECK_POLL_MS, NOTES, idsOn, request, purpose, typedSince } from "./compose.js";

const TREE_W = 290;
const FILTER_H = 30;
const SUMMARY_H = 18;
const FILE_HEAD_H = 30;
const NOTE_H = 22;
const GAP = 6;

// How often the open PR is read again while the tab shows (spec: Following
// the PR).
const POLL_MS = 15000;

// `files` and `diff` can take a while on a big PR (every REST page).
const SLOW = { timeout: 120000 };

// A press that left the filter, coming again the other way (the Input's
// submit and on_key_down, a binding and on_key_down): taken, once.
const SAME_PRESS_MS = 150;

// An older herdr-github, from before these ops.
const TOO_OLD = /no op "(files|diff|threads)"/;

const said = (e) => String(e?.message ?? e);
// The last index of `xs` where `ok` holds, or -1.
const lastIndex = (xs, ok) => {
  for (let i = xs.length - 1; i >= 0; i--) if (ok(xs[i], i)) return i;
  return -1;
};
const isWeb = (url) => typeof url === "string" && /^https:\/\//.test(url);

// A file's diff on GitHub: the PR's files page, at that file.
export function fileLink(prUrl, path) {
  return `${prUrl}/files#diff-${createHash("sha256").update(path).digest("hex")}`;
}

export class FilesView {
  /**
   * @param {any} app the GitHub view (main.js)
   * @param {{ filter: any, composer: any, reviewBody: any, diffScroll: any, treeScroll: any, height: number }} ui
   */
  constructor(app, ui) {
    this.app = app;
    this.ui = ui;
    this.pr = app.cur;
    // Who it's read as (main's gen, which moves when who changes): every
    // change it sends was made under this, and once it moves the view is
    // dead (main's settle makes another).
    this.made = app.gen;
    this.state = "idle"; // idle, loading, ok, error, old
    this.error = "";
    this.data = null; // `files`'s answer: head, files, threads, more (the threads'), filesMore
    this.byPath = new Map(); // a file's threads
    this.reading = false; // the one `files` load out
    this.again = null; // asked for while one was out: { note }, once it answers
    this.diffs = new Map(); // path → `diff`'s answer, for data.head
    this.failed = new Map(); // path → why its diff didn't come, until r
    this.asking = null; // the one diff request out
    this.behind = false; // GitHub has a newer head than the one shown, until r
    this.review = null; // the viewer's pending review, from the last files or threads
    this.prInfo = null; // files' pr: id, mine, state; no id means an older herdr-github
    this.polling = false; // the one threads poll out
    this.pollAt = 0; // when the next poll is due
    this.health = new PollHealth();
    this.held = new Map(); // id → until: sent from here, not yet read back (follow.js)
    this.edited = new Map(); // comment id → { body, until }: an edit saved from here, not yet read back
    this.topKey = null; // the first item the diff list drew: the scroll's anchor
    this.filesOwed = false; // a files answer was dropped: read again once nothing is sent
    this.sending = false; // a review change is out (send): nothing else goes until it answers
    this.checks = []; // changes whose outcome wasn't known: the next poll after `after` says (sent.js)
    this.drafts = new DraftStore(localStorage, app.demo ? DEMO_DRAFTS_KEY : DRAFTS_KEY);
    this.draftsN = 0; // bumped when a draft changes: the draft marks are drawn again
    this.marksMemo = { n: -1, head: "", rows: new Set(), threads: new Set() };
    this.saveDue = false; // a save of what's typed is on the timer
    this.composer = null; // the open composer (compose.js), docked under the diff
    this.composerId = ""; // its draft's id
    this.typed = ""; // what its text box said last
    this.confirm = null; // a delete waiting for y: { thread, comment }
    this.dialog = null; // the submit dialog (dialog.js), over the tab
    this.bodyWriting = false; // its text box has the keyboard
    this.bodyTyped = ""; // what that box said last
    this.submitted = null; // the viewer's latest submitted review, from the last files or threads
    this.path = null; // the open file
    this.at = 0; // the cursor: an index into items()
    this.target = null; // where the cursor goes once the open file's items come
    this.fold = new Map(); // thread id → folded, when not as it starts
    this.foldN = 0;
    this.query = "";
    this.filtering = false; // the filter has the keyboard
    this.writing = false; // the composer's text box has it
    this.leftAt = 0; // when it last left the filter
    this.blurAt = 0; // when the filter lost focus while typing (see filterFocus)
    this.saving = new Set(); // paths whose viewed mark is being saved
    this.width = Math.max(320, app.width - 32 - TREE_W - 12);
    this.treeMemo = { data: null, query: "", rows: [], order: [] };
    this.itemsMemo = { key: [], items: [] };
    // The lists' positions are main's, shared by every PR's view: a new one
    // starts at the top.
    ui.filter.set_value("");
    ui.diffScroll.scroll_to_item(0);
    ui.treeScroll.scroll_to_item(0);
  }

  // Whether it's still the tab's view (a PR opened since, or who changing,
  // replaces it). An answer for a view that isn't touches nothing: not its
  // state, not the lists' handles (they're the new view's now), and it asks
  // nothing more. Dead as soon as who changes, before main's settle runs.
  alive() {
    return this.app.files === this && this.app.gen === this.made;
  }

  // A text box has the keyboard: the filter, or the composer. main's keyDown
  // sends every key to typingKey then, unstopped, so it types.
  get typing() {
    return this.filtering || this.writing || this.bodyWriting;
  }

  // Something on this tab waits for an answer (the submit dialog, a
  // delete's y, "Send again?"): the footer is only its keys.
  modal() {
    return Boolean(this.dialog || this.confirm) || this.composer?.phase === "again";
  }

  prKey() {
    return `${this.pr.host}/${this.pr.repo}#${this.pr.number}`.toLowerCase();
  }

  say(text, cx, err = false) {
    if (this.alive() && this.app.screen === "pr") this.app.say(text, cx, err);
  }

  prID() {
    return { host: this.pr.host, repo: this.pr.repo, number: this.pr.number };
  }

  // ── what it shows ──────────────────────────────────────────────────────

  file(path = this.path) {
    return this.data?.files.find((f) => f.path === path) ?? null;
  }

  // The tree's rows for the files the filter lets through, and those files
  // in the tree's order: the order ] [ u n p step through.
  tree() {
    const m = this.treeMemo;
    if (m.data !== this.data || m.query !== this.query) {
      const shown = (this.data?.files ?? []).filter((f) => matchesPath(f.path, this.query));
      m.rows = treeRows(shown);
      m.order = m.rows.filter((r) => r.kind === "file").map((r) => r.file);
      m.data = this.data;
      m.query = this.query;
    }
    return { rows: m.rows, order: m.order };
  }

  order() {
    return this.tree().order;
  }

  folded(t) {
    return this.fold.get(t.id) ?? t.resolved;
  }

  // The open file's items (rows and threads), or null while its diff is
  // still to come.
  items() {
    const f = this.file();
    if (!f) return [];
    const d = this.diffs.get(f.path);
    const failed = this.failed.get(f.path);
    if (!d && !failed) return null;
    // Built again only when what they're made of changes (the width by 40 px).
    const m = this.itemsMemo;
    const key = [f.path, d, failed, this.foldN, Math.round(this.width / 40), this.data];
    if (key.some((x, i) => x !== m.key[i])) {
      m.items = diffItems({ rows: d?.state === "ok" ? d.rows : [], threads: this.byPath.get(f.path) ?? [], folded: (t) => this.folded(t), width: this.width });
      m.key = key;
    }
    return m.items;
  }

  // Puts the cursor where it was sent (a thread, a file's first open one)
  // once the items are here, and keeps it on one.
  settle() {
    const items = this.items();
    if (!items) return;
    const tg = this.target;
    if (tg) {
      const open = (it) => it.kind === "thread" && !it.t.resolved;
      const i = tg === "first-open" ? items.findIndex(open)
        : tg === "last-open" ? lastIndex(items, open)
        : items.findIndex((it) => it.kind === "thread" && it.t.id === tg.thread);
      if (i >= 0) this.at = i;
      this.target = null;
      this.follow();
    }
    this.at = Math.max(0, Math.min(this.at, items.length - 1));
  }

  // Keeps the cursor's item in sight, and the open file's row in the tree.
  // Asked again when a list's items land: a request made while the list
  // wasn't drawn (its diff still coming) may not have been kept.
  follow() {
    if (this.alive()) this.ui.diffScroll.scroll_to_item(this.at);
  }

  followTree() {
    if (!this.alive()) return;
    const i = this.tree().rows.findIndex((r) => r.file?.path === this.path);
    if (i >= 0) this.ui.treeScroll.scroll_to_item(i);
  }

  // ── fetching ───────────────────────────────────────────────────────────

  // Every read this tab makes. Only one a person asked for (`user`: the tab
  // shown, r) may look for GitHub again when it fails; any other (a poll, a
  // read owed after a change, a diff) just fails (reads.js), so a dropped
  // exec can't change who and start everything over.
  read(req, opts = {}, user = false) {
    return this.app.gh(req, { ...opts, why: user ? "asked" : "auto" });
  }

  // The tab came into view: its files, the first time.
  shown(cx) {
    if (this.state === "idle") this.loadFiles(cx, "", true);
    else {
      this.pump(cx);
      this.poll(cx);
    }
  }

  // r: the files again, and the open file's diff; errors forgotten.
  reload(cx) {
    this.failed.clear();
    if (this.path) this.diffs.delete(this.path);
    if (this.state === "old" || this.state === "error") this.state = "idle";
    this.loadFiles(cx, "", true);
  }

  // One `files` at a time: it's every REST page of the PR. Asked again
  // while one is out (r, a stale answer), it's read once more when that one
  // answers, however many times it was asked. `user`: a person asked (read).
  loadFiles(cx, note = "", user = false) {
    if (!this.alive()) return;
    if (this.reading) {
      this.again = { note: note || this.again?.note || "", user: user || Boolean(this.again?.user) };
      return;
    }
    this.reading = true;
    if (!this.data) this.state = "loading";
    cx.notify();
    const gen = this.app.gate.gen;
    cx.spawn(async (cx) => {
      let res;
      try {
        res = await this.read({ op: "files", pr: this.prID() }, SLOW, user);
      } catch (e) {
        if (!this.alive()) return;
        this.reading = false;
        const again = this.again;
        this.again = null;
        if (TOO_OLD.test(said(e))) this.state = "old";
        else if (again) this.loadFiles(cx, again.note, again.user);
        else if (this.data) {
          // What was there stays, and the open diff r let go comes again.
          this.say(said(e), cx, true);
          this.pump(cx);
        } else {
          this.state = "error";
          this.error = said(e);
        }
        return cx.notify();
      }
      if (!this.alive()) return;
      this.reading = false;
      if (gen !== this.app.gate.gen && this.data) {
        // A change was sent meanwhile: this picture may be from before it.
        this.filesOwed = true;
        return cx.notify();
      }
      if (this.data?.head !== res.head) {
        this.diffs.clear();
        this.failed.clear();
        this.asking = null; // an answer for the old head is let go
      }
      // The same head again (r): what was just sent, not yet read back,
      // stays, as a poll keeps it.
      let threads = res.threads ?? [];
      let files = res.files ?? [];
      if (this.data?.head === res.head) {
        ({ threads, held: this.held, edited: this.edited } = applyPoll({ threads: this.data.threads, held: this.held, edited: this.edited }, res, Date.now()));
        files = countThreads(files, threads);
      }
      // `more` is the threads' (each poll says it again); filesMore is the
      // files read's, which only r reads again.
      const more = Boolean(res.more);
      this.data = { head: res.head, files, threads, more, filesMore: more };
      this.indexThreads();
      ({ review: this.review, submitted: this.submitted } = reviewsOf(res, this));
      this.prInfo = res.pr ?? null;
      this.behind = false;
      this.health.ok();
      this.pollAt = Date.now() + POLL_MS;
      this.state = "ok";
      if (!this.file()) {
        this.path = this.order()[0]?.path ?? this.data.files[0]?.path ?? null;
        this.at = 0;
      }
      this.followTree();
      if (note) this.say(note, cx);
      // What was asked for meanwhile goes now; its diffs wait for it (pump).
      const again = this.again;
      this.again = null;
      if (again) this.loadFiles(cx, again.note, again.user);
      this.pump(cx);
      cx.notify();
    });
  }

  // Asks for the next diff wanted, when none is out: the open file's, then
  // the one after it.
  pump(cx) {
    if (!this.alive() || this.state !== "ok" || this.reading || this.asking) return;
    const order = this.order();
    const i = order.findIndex((f) => f.path === this.path);
    const want = [this.path, i >= 0 ? order[i + 1]?.path : null].find((p) => p && !this.diffs.has(p) && !this.failed.has(p));
    if (want) this.fetchDiff(want, cx);
  }

  fetchDiff(path, cx) {
    const head = this.data.head;
    const req = { path, head };
    this.asking = req;
    cx.spawn(async (cx) => {
      let res = null;
      let err = null;
      try {
        res = await this.read({ op: "diff", pr: this.prID(), path, head }, SLOW);
      } catch (e) {
        err = e;
      }
      if (!this.alive() || this.asking !== req) return; // a new PR or head took its place
      this.asking = null;
      if (this.data?.head !== head) return this.pump(cx);
      if (err && TOO_OLD.test(said(err))) this.state = "old";
      else if (err) this.failed.set(path, said(err));
      else if (res.state === "stale") return this.stale(path, head, cx);
      else {
        this.diffs.set(path, res);
        this.placeDrafts(path, res, cx);
      }
      if (path === this.path) {
        this.settle();
        this.follow();
      }
      this.pump(cx);
      cx.notify();
    });
  }

  // GitHub has a newer head than the one shown. Nothing reloads by itself
  // (it would move what's being read): the notice says so, and r reloads.
  stale(path, head, cx) {
    this.behind = true;
    this.failed.set(path, NEW_COMMITS);
    this.pump(cx);
    cx.notify();
  }

  // ── following the PR ─────────────────────────────────────────────────

  indexThreads() {
    this.byPath = new Map();
    for (const t of this.data.threads) this.byPath.set(t.path, [...(this.byPath.get(t.path) ?? []), t]);
  }

  // Whether this herdr-github can follow the PR and take review actions.
  follows() {
    return Boolean(this.prInfo?.id);
  }

  // main's timer, every second while the popup is open: a poll when one is
  // due or owed, only while this tab is the one shown.
  tick(cx) {
    if (!this.alive() || this.app.screen !== "pr" || this.app.prTab !== "files") return;
    if (this.filesOwed && this.app.gate.clear() && !this.reading) {
      this.filesOwed = false;
      return this.loadFiles(cx);
    }
    // "Could not confirm" comes 60 s on, maybe mid-move in the diff: the box
    // is editable again, but the keyboard stays where it is.
    if (this.composer?.tick(Date.now()) === "unconfirmed") cx.notify();
    // A check no poll has answered in 60 s (failing, or new commits) is let go.
    const late = this.checks.filter((c) => Date.now() >= c.after + CHECK_MS);
    if (late.length) {
      this.checks = this.checks.filter((c) => !late.includes(c));
      this.say("Couldn't check whether the last change went through: look at the PR (r reads it again).", cx, true);
    }
    // The dialog's check runs out, or its "Now 8" ends: drawn again.
    if (this.dialog) {
      this.dialog.tick(Date.now());
      cx.notify();
    }
    if (this.app.gate.takeOwed() || Date.now() >= this.pollAt) this.poll(cx);
  }

  // Polls come every 15 s, and every 5 s while a change's outcome is being
  // checked.
  pollEvery() {
    return this.composer?.phase === "checking" || this.dialog?.phase === "checking" || this.checks.length ? CHECK_POLL_MS : POLL_MS;
  }

  // Reads the PR's threads and pending review (`threads`), one at a time.
  poll(cx) {
    if (!this.alive() || this.state !== "ok" || !this.follows() || this.polling || this.reading) return;
    const stamp = this.app.gate.startPoll();
    if (stamp === null) return; // a change is out: asked again when it ends
    this.polling = true;
    const startedAt = Date.now();
    this.pollAt = startedAt + this.pollEvery();
    const head = this.data.head;
    cx.spawn(async (cx) => {
      let res = null;
      let err = null;
      try {
        res = await this.read({ op: "threads", pr: this.prID() });
      } catch (e) {
        err = e;
      }
      if (!this.alive()) return;
      this.polling = false;
      this.pollAt = Date.now() + this.pollEvery();
      if (err) {
        if (TOO_OLD.test(said(err))) this.prInfo = null; // stops following; the rest works
        else this.health.failed(said(err));
        return cx.notify();
      }
      // Older than a change sent since it started: dropped, asked again.
      if (!this.app.gate.fresh(stamp)) return;
      this.health.ok();
      if (this.data?.head !== head) return; // r read another head meanwhile
      this.applyThreads(res);
      this.answerChecks(res, startedAt, cx);
      this.checkComposer(res, startedAt, cx);
      this.checkDialog(res, startedAt, cx);
      cx.notify();
    });
  }

  // A `threads` answer into what's shown, moving nothing being read.
  applyThreads(res) {
    ({ review: this.review, submitted: this.submitted } = reviewsOf(res, this));
    if (res.pr) this.prInfo = res.pr;
    if (res.head !== this.data.head) {
      this.behind = true;
      return;
    }
    const m = applyPoll({ threads: this.data.threads, held: this.held, edited: this.edited }, res, Date.now());
    this.held = m.held;
    this.edited = m.edited;
    this.setThreads(m.threads, m.more);
  }

  // Shows `threads` in place of the ones shown, moving nothing being read:
  // the cursor stays on its item (or the row its thread sat under), and the
  // first item in sight stays first. A poll's merge and every change sent
  // from here come through it.
  setThreads(threads, more = this.data.more) {
    const before = this.items();
    const top = before ? Math.max(0, before.findIndex((it) => it.key === this.topKey)) : 0;
    this.data = { ...this.data, threads, files: countThreads(this.data.files, threads), more };
    this.indexThreads();
    const after = this.items();
    if (!before || !after) return;
    this.at = refind(before, after, this.at);
    if (shiftedAbove(before, after, top)) this.ui.diffScroll.scroll_to_item(refind(before, after, top), "top");
  }

  // A poll that started after a change with no known outcome ended says
  // what happened to it (only for the head shown: a thread is by its id),
  // from the poll's own threads: what's held here isn't GitHub's word.
  answerChecks(res, startedAt, cx) {
    if (res.head !== this.data.head || !this.checks.length) return;
    const { said, left } = answerChecks(this.checks, res, this.held, startedAt);
    this.checks = left;
    if (said) this.say(said.text, cx, said.err);
  }

  // ── changing the review ────────────────────────────────────────────────

  // Every review change this tab makes goes through here, once: one at a
  // time, refused at once (before anything is awaited) while another is out,
  // so two deliveries of one press can't both send. `done` gets the
  // outcome (mutation.js), also when the view is no longer the tab's.
  send(req, cx, done, before = null) {
    if (this.busy()) {
      this.say("Still sending the last change: one at a time.", cx, true);
      return false;
    }
    this.sending = true;
    cx.spawn(async (cx) => {
      if (before) await before();
      const r = await this.app.mutate({ ...req, pr: this.prID() }, this.made);
      this.sending = false;
      done(r, cx);
      cx.notify();
    });
    return true;
  }

  busy() {
    return this.sending || !this.app.gate.clear();
  }

  // A review key (reviewkeys.js): done, or why not said.
  reviewKey(k, cx) {
    const ok = this.state === "ok";
    const what = reviewAction(k, {
      state: this.state, follows: this.follows(), item: ok ? this.items()?.[this.at] : null,
      behind: this.behind, head: this.data?.head, review: this.review,
      diff: ok ? this.diffs.get(this.path)?.state ?? (this.failed.has(this.path) ? "failed" : "") : "",
    });
    if ("say" in what) return this.say(what.say, cx, true);
    const pr = this.prKey();
    switch (what.act) {
      case "resolve":
        return this.resolve(what.thread, what.to, cx);
      case "comment":
        return this.openComposer(rowTarget(what.row, { pr, path: this.path, head: this.data.head }), "", cx);
      case "reply": {
        const t = what.thread;
        return this.openComposer({ kind: "reply", pr, thread: t.id, path: t.path, line: t.line, author: t.comments[0]?.author ?? "" }, "", cx);
      }
      case "edit": {
        const t = what.thread;
        const c = what.comment;
        return this.openComposer({ kind: "edit", pr, comment: c.id, thread: t.id, path: t.path, line: t.line, published: c.state !== "pending" }, c.body ?? "", cx);
      }
      case "delete":
        this.confirm = { thread: what.thread, comment: what.comment };
        return this.say(deletePrompt(what.comment), cx);
      case "submit":
        return this.openDialog(cx);
    }
  }

  // y after shift-d: deletes the comment. Gone at once once GitHub says so.
  // Its hold (just sent, not read back) goes as the delete does: a poll
  // without it then means deleted, not "not read back yet". Only GitHub's
  // no puts the hold back.
  deleteComment({ comment }, cx) {
    const until = this.held.get(comment.id);
    const sent = this.send({ op: "act", do: "delete", comment: comment.id }, cx, (r, cx) => {
      if (r.kind === "refused" && until !== undefined && this.alive()) this.held.set(comment.id, until);
      if (r.kind === "ok") {
        if (this.alive() && this.data) this.setThreads(withoutComment(this.data.threads, comment.id));
        if (r.answer && "review" in r.answer) this.review = r.answer.review;
        // An edit of it, never sent, has nothing left to edit.
        this.drafts.remove(draftId({ kind: "edit", pr: this.prKey(), comment: comment.id }));
        this.draftsN++;
        this.say(comment.state === "pending" ? "Deleted." : "Deleted. Others see it gone.", cx);
      } else if (r.kind === "refused") {
        this.say(r.error, cx, true);
      } else {
        this.checks.push({ kind: "delete", comment: comment.id, unreadUntil: until, after: Date.now() });
        this.say("No answer. Checking…", cx, true);
      }
    });
    if (!sent) return;
    this.held.delete(comment.id);
    this.edited.delete(comment.id);
    this.say("Deleting…", cx);
  }

  // A key while a delete waits for y. A held y never gets here (route).
  confirmKey(k, cx) {
    const c = this.confirm;
    this.confirm = null;
    if (k === "y") this.deleteComment(c, cx);
    else this.say("Kept.", cx);
  }

  // ── the composer ───────────────────────────────────────────────────────
  //
  // Docked under the diff, one at a time, for a target (drafts.js): a
  // line, a thread, or one of your comments. Its text box is main's (made
  // in init), shared by every PR's view; what it says is kept as the
  // target's draft as it's typed. Sending is compose.js's state machine.

  // Opens it on `target`, with that target's draft, else `prefill`. One
  // that was open closes, its draft kept. `keyboard`: it may take the
  // keyboard (a key opened it); opened by a poll, only if mayMoveKeyboard.
  openComposer(target, prefill, cx, keyboard = true) {
    const id = draftId(target);
    // Already open on it: the keyboard back into it, nothing reset.
    if (this.composer && this.composerId === id) return this.focusComposer(cx);
    if (this.composer) this.closeComposer(cx, false);
    const draft = this.drafts.get(id);
    this.composer = new Composer(target, draft, Date.now());
    this.composerId = id;
    // Set first: a change event for this set_value says nothing new.
    this.typed = draft?.body ?? prefill;
    this.ui.composer.set_value(this.typed);
    if (this.composer.editable()) {
      if (keyboard) this.focusComposer(cx);
    } else {
      // Its last send may have gone: polls now, and every 5 s.
      this.pollAt = 0;
      if (keyboard) {
        this.writing = false;
        this.app.keys.focus();
      }
    }
    cx.notify();
  }

  // The keyboard into the composer's text box: now, and again once it's
  // drawn (a box that only just appears may not take focus before then).
  focusComposer(cx) {
    const c = this.composer;
    if (!c?.editable()) return;
    // Typing from now: a key before the box's focus event is the box's,
    // never a review key (A5).
    this.writing = true;
    this.ui.composer.focus();
    cx.timer.after(30, () => {
      // Not if the keyboard went elsewhere meanwhile (the filter, the dialog).
      if (this.composer === c && c.editable() && this.alive() && this.writing && !this.filtering && !this.dialog) this.ui.composer.focus();
    });
    cx.notify();
  }

  // Closes it; its draft stays (written now, not on the timer). `refocus`:
  // the keyboard goes back to the diff.
  closeComposer(cx, refocus = true) {
    if (!this.composer) return;
    this.captureTyped(cx);
    this.composer = null;
    this.writing = false;
    this.saveDrafts(cx);
    if (refocus) this.app.keys.focus();
    cx.notify();
  }

  // What the text box says now, kept: a change event may not have come
  // for the last of it.
  captureTyped(cx) {
    if (this.composer?.editable()) this.composerChanged(this.ui.composer.value(), cx);
  }

  // The text box's events, through main.
  composerChanged(value, cx) {
    const c = this.composer;
    if (!c?.editable() || value === this.typed) return;
    this.typed = value;
    const now = Date.now();
    const d = this.drafts.get(this.composerId);
    this.keepDraft({ ...(d ?? makeDraft(c.target, value, now)), body: value, at: now }, cx);
  }

  composerFocus(on, cx) {
    this.writing = on && Boolean(this.composer?.editable());
    cx.notify();
  }

  // The textarea's submit: cmd-enter, when it says secondary (Verify 10).
  // Its repeats can't be told apart from presses: Composer.press decides.
  composerSubmit(e, cx) {
    if (e?.secondary === true) this.composerPress(cx, null);
  }

  // cmd-enter, from the textarea (held unknown: null) or a key.
  composerPress(cx, held) {
    const c = this.composer;
    if (!c) return;
    const what = c.press(Date.now(), held);
    if (what === "ask") {
      // The confirm comes as a key with its held flag, never as a repeat.
      this.writing = false;
      this.app.keys.focus();
      return cx.notify();
    }
    if (what === "send") this.sendDraft(cx);
  }

  // esc while "Send again?" is asked: back to the draft.
  keepDraftUnsent(cx) {
    this.composer?.keep();
    this.focusComposer(cx);
  }

  // Why the composer's text can't be sent now, or "" when it can. A new
  // comment goes only on the head shown, on a row there with the same text
  // (A9); else it's unplaced, and kept.
  cantSend(target, body) {
    if (!body.trim()) return "Nothing to send: it's empty.";
    if (!this.follows()) return "This needs a newer herdr-github.";
    if (target.kind === "edit") return !target.published && this.behind ? NEW_COMMITS : "";
    if (target.kind !== "comment") return "";
    if (this.behind) return NEW_COMMITS;
    if (this.review?.commit && this.review.commit !== this.data.head) return OLDER_COMMIT;
    const d = this.diffs.get(target.path);
    if (!d) return "Its file's diff is still loading.";
    if (d.state !== "ok" || rowOf(d.rows, target) < 0) return "That line changed with the new commits, so this draft can't be placed. It's kept: the submit dialog lists it.";
    return "";
  }

  // Sends what the composer says, once. Before anything is sent the draft
  // is written as `sending`, with your comment ids on its target (A2), so a
  // popup closed meanwhile finds it and checks.
  sendDraft(cx) {
    const c = this.composer;
    const body = this.ui.composer.value();
    const target = c.target.kind === "comment" ? { ...c.target, head: this.data.head } : c.target;
    const why = this.cantSend(target, body);
    if (why || this.busy()) {
      c.keep();
      this.focusComposer(cx);
      return this.say(why || "Still sending the last change: one at a time.", cx, true);
    }
    const id = this.composerId;
    const now = Date.now();
    const send = { state: "sending", since: now, ids: idsOn(target, this.data.threads), body };
    const d = this.drafts.get(id);
    // A send whose outcome was never known, before this one: kept if this
    // one is refused, so a reopened composer still checks for it.
    const prior = d?.send ? { ...d.send, state: "unknown" } : null;
    this.drafts.saveNow({ ...(d ?? makeDraft(target, body, now)), ...target, body, at: now, send });
    this.draftsN++;
    c.target = target;
    c.sending(send);
    this.writing = false;
    this.app.keys.focus();
    this.send(request(target, body, this.data.head), cx, (r, cx) => this.draftSent(id, target, send, prior, r, cx), async () => {
      await localStorage.flush().catch(() => {});
    });
    cx.notify();
  }

  // How a draft's send ended, whether or not its composer is still open:
  // the draft is what's kept.
  draftSent(id, target, send, prior, r, cx) {
    const c = this.composerId === id && this.composer?.send?.since === send.since ? this.composer : null;
    // Whether this answer may move the keyboard: not if it went to the
    // filter meanwhile (rule 5).
    const keyboard = mayMoveKeyboard(this.holder());
    this.draftsN++;
    if (r.answer && "review" in r.answer && this.alive()) this.review = r.answer.review;
    if (r.kind === "ok") {
      this.drafts.remove(id);
      if (this.alive()) this.showSent(target, r.answer);
      if (c) {
        c.outcome("ok", "", Date.now());
        this.closeComposer(cx, keyboard);
      }
      return this.say(target.kind === "edit" ? (target.published ? "Saved. Others see it at once." : "Saved.") : "Added to your pending review.", cx);
    }
    const d = this.drafts.get(id);
    if (r.kind === "refused") {
      if (d) this.drafts.saveNow({ ...d, send: prior });
      if (r.answer?.stale === true) this.behind = true;
      if (c) {
        c.outcome("refused", r.error, Date.now());
        if (keyboard) this.focusComposer(cx);
      } else this.say(r.error, cx, true);
      return;
    }
    if (d) this.drafts.saveNow({ ...d, send: { ...send, state: "unknown" } });
    if (c) c.outcome("unknown", "", Date.now());
    else this.say("No answer from GitHub about your comment. It may have been sent: open it again to check.", cx, true);
  }

  // A send's own answer, shown before a poll reads it back, and held until
  // one has (A4).
  showSent(target, answer) {
    if (!this.data || !answer?.comment) return;
    const until = Date.now() + HOLD_MS;
    let threads = this.data.threads;
    if (target.kind === "comment") {
      if (target.head !== this.data.head) return;
      threads = withComment(threads, answer, target);
      if (answer.thread?.id) this.held.set(answer.thread.id, until);
    } else if (target.kind === "reply") threads = withReply(threads, target.thread, answer.comment);
    else threads = withEdit(threads, answer.comment);
    if (target.kind !== "edit") this.held.set(answer.comment.id, until);
    else if (typeof answer.comment.body === "string") this.edited.set(answer.comment.id, { body: answer.comment.body, until });
    this.setThreads(threads);
  }

  // A poll, for the composer checking whether its send went through. The
  // poll's own threads: GitHub's word, not what's held here.
  checkComposer(res, startedAt, cx) {
    const c = this.composer;
    if (!c) return;
    if (c.poll(res.threads ?? [], startedAt) !== "sent") return;
    const keyboard = mayMoveKeyboard(this.holder());
    const id = this.composerId;
    const d = this.drafts.get(id);
    this.draftsN++;
    // Typed since that send (after "Could not confirm"): what was sent went
    // through, and the newer text stays a draft.
    if (typedSince(d, c.send)) {
      this.drafts.saveNow({ ...d, send: null });
      this.composer = null;
      this.openComposer(c.target, d.body, cx, keyboard);
      return this.say("The text you sent earlier went through. What you typed since is kept here.", cx);
    }
    this.drafts.remove(id);
    this.closeComposer(cx, keyboard);
    this.say("Sent: it's in your pending review.", cx);
  }

  // ── the submit dialog ──────────────────────────────────────────────────
  //
  // Over the tab, taking every key while it's open (dialog.js decides what
  // each does). Its text box is main's, like the composer's; what's typed
  // there is kept as the PR's "body" draft.

  bodyId() {
    return draftId({ kind: "body", pr: this.prKey() });
  }

  openDialog(cx) {
    if (this.composer) this.closeComposer(cx, false);
    this.confirm = null;
    this.dialog = new SubmitDialog({ review: this.review, mine: Boolean(this.prInfo?.mine), submitted: this.submitted });
    this.bodyTyped = this.drafts.get(this.bodyId())?.body ?? this.review?.body ?? "";
    this.ui.reviewBody.set_value(this.bodyTyped);
    this.focusBody(cx);
  }

  focusBody(cx) {
    const d = this.dialog;
    if (!d) return;
    d.focus = "body";
    this.bodyWriting = true;
    this.ui.reviewBody.focus();
    cx.timer.after(30, () => {
      if (this.dialog === d && d.focus === "body" && this.alive()) this.ui.reviewBody.focus();
    });
    cx.notify();
  }

  focusChoices(cx) {
    if (this.dialog) this.dialog.focus = "choices";
    this.bodyWriting = false;
    this.app.keys.focus();
    cx.notify();
  }

  // Closes it, its text kept as a draft.
  closeDialog(cx) {
    if (!this.dialog) return;
    this.dialogBodyChanged(this.ui.reviewBody.value(), cx);
    this.dialog = null;
    this.bodyWriting = false;
    this.saveDrafts(cx);
    this.app.keys.focus();
    cx.notify();
  }

  // esc: the discard step, or "Send again?", back to the choices; else closed.
  dialogEscape(cx) {
    const d = this.dialog;
    if (d.phase === "discard") {
      d.cancelDiscard();
      return this.say("Not discarded.", cx);
    }
    if (d.phase === "again") {
      d.keep();
      return cx.notify();
    }
    this.closeDialog(cx);
  }

  // The body box's events, through main.
  dialogBodyChanged(value, cx) {
    if (!this.dialog || value === this.bodyTyped) return;
    this.bodyTyped = value;
    this.keepDraft(makeDraft({ kind: "body", pr: this.prKey() }, value, Date.now()), cx);
  }

  dialogFocus(on, cx) {
    this.bodyWriting = on && Boolean(this.dialog);
    if (this.dialog) this.dialog.focus = on ? "body" : "choices";
    cx.notify();
  }

  dialogSubmit(e, cx) {
    if (e?.secondary === true) this.dialogPress(cx, null);
  }

  dialogPress(cx, held) {
    if (this.dialog) this.dialogStep(this.dialog.press(Date.now(), held, this.ui.reviewBody.value()), cx);
  }

  dialogKey(k, held, cx) {
    if (this.dialog) this.dialogStep(this.dialog.key(k, held, this.ui.reviewBody.value(), Date.now()), cx);
  }

  // Does what the dialog said.
  dialogStep(step, cx) {
    if (step.do === "say") this.say(step.text, cx, true);
    else if (step.do === "focus-body") this.focusBody(cx);
    else if (step.do === "focus-choices") this.focusChoices(cx);
    else if (step.do === "send") this.sendDialog(step.req, cx);
    cx.notify();
  }

  // Submits or discards, once, through send.
  sendDialog(req, cx) {
    const d = this.dialog;
    this.bodyWriting = false;
    this.app.keys.focus();
    const sent = this.send(req, cx, (r, cx) => {
      d.outcome(r.kind, r.answer, r.error ?? "", Date.now());
      if (r.answer && "review" in r.answer && this.alive()) this.review = r.answer.review;
      if (r.kind === "ok") return this.reviewDone(req.do, r.answer?.url ?? "", cx);
      if (this.dialog !== d) this.say(r.kind === "refused" ? r.error : "No answer from GitHub about your review. It may have gone through: look at the PR before sending again.", cx, true);
    });
    if (!sent) d.outcome("refused", null, "Still sending the last change: one at a time.", Date.now());
  }

  // A poll, while the dialog is open: its count follows, and a check after
  // an unknown outcome reads it.
  checkDialog(res, startedAt, cx) {
    const d = this.dialog;
    if (!d) return;
    // Left out (undefined): GitHub didn't say, and nothing follows from it.
    d.follow(res.review, res.submitted, Date.now());
    if (d.poll({ review: res.review, submitted: res.submitted }, startedAt) === "sent") {
      this.reviewDone(d.sent.kind, "", cx, d.note || "");
    }
  }

  // The review went (or a check shows it did): the dialog closes, and the
  // word stays a few seconds. A discard takes its pending comments with it.
  reviewDone(kind, url, cx, text = "") {
    if (this.dialog) {
      this.dialog = null;
      this.bodyWriting = false;
      this.app.keys.focus();
    }
    this.drafts.remove(this.bodyId());
    this.draftsN++;
    if (this.alive()) {
      this.review = null;
      if (kind === "discard" && this.data) {
        this.held.clear();
        this.edited.clear();
        this.setThreads(withoutPending(this.data.threads));
      }
    }
    const said = text || (kind === "discard" ? "Discarded your pending review." : url ? `Review sent: ${url}` : "Review sent.");
    this.say(said, cx);
    cx.timer.after(6000, (cx) => {
      if (this.alive() && this.app.flash === said) this.app.say("", cx);
    });
    cx.notify();
  }

  // ── drafts ─────────────────────────────────────────────────────────────

  // What's typed, kept at most every SAVE_MS.
  keepDraft(draft, cx) {
    this.drafts.put(draft);
    this.draftsN++;
    if (this.saveDue) return;
    this.saveDue = true;
    cx.timer.after(SAVE_MS, (cx) => {
      this.saveDue = false;
      this.saveDrafts(cx);
    });
  }

  saveDrafts(cx) {
    const { dropped } = this.drafts.flush();
    if (dropped.length) this.say(droppedNote(dropped[0]), cx);
  }

  // A diff came for the head shown: new-comment drafts typed at another
  // head on a row with the same side, line and text are on it now.
  placeDrafts(path, diff, cx) {
    if (diff.state !== "ok") return;
    const moved = placeDrafts(this.drafts.forPR(this.prKey()), path, this.data.head, diff.rows);
    if (!moved.length) return;
    for (const d of moved) this.drafts.put(d);
    this.draftsN++;
    this.saveDrafts(cx);
  }

  // What has a draft, for the marks: rows by draft id, threads by id.
  draftMarks() {
    const m = this.marksMemo;
    if (m.n !== this.draftsN || m.head !== this.data?.head) {
      const ds = this.drafts.forPR(this.prKey());
      m.rows = new Set(ds.filter((d) => d.kind === "comment" && d.head === this.data?.head).map((d) => d.id));
      m.threads = new Set(ds.filter((d) => d.kind === "reply" || d.kind === "edit").map((d) => d.thread));
      m.n = this.draftsN;
      m.head = this.data?.head ?? "";
    }
    return m;
  }

  drafted(it) {
    const m = this.draftMarks();
    if (it.kind === "row") {
      const t = rowTarget(it.row, { pr: this.prKey(), path: this.path, head: this.data.head });
      return Boolean(t) && m.rows.has(draftId(t));
    }
    return it.kind === "thread" && m.threads.has(it.t.id);
  }

  // Who changed (main's settle): what this view holds (the pending review,
  // "mine", what's held and checked) is another account's, and goes with
  // it. What was out is said not known first (sent.js leaveNote), what's
  // typed is written, and nothing here can take the keyboard when an answer
  // for it comes later. `signedOut`: nobody is signed in now, rather than
  // someone else. What to say, or "".
  leave(signedOut = false) {
    const note = leaveNote({
      sending: this.sending,
      composer: this.composer && { phase: this.composer.phase, kind: this.composer.target.kind },
      dialog: this.dialog && { phase: this.dialog.phase, kind: this.dialog.sent?.kind ?? "" },
      checks: this.checks,
      signedOut,
    });
    this.close();
    this.composer = null;
    this.dialog = null;
    this.confirm = null;
    this.checks = [];
    this.writing = this.bodyWriting = this.filtering = false;
    return note;
  }

  // The popup is closing: what's typed is written now.
  close() {
    if (this.dialog && this.ui.reviewBody.value() !== this.bodyTyped) {
      this.drafts.put(makeDraft({ kind: "body", pr: this.prKey() }, this.ui.reviewBody.value(), Date.now()));
    }
    if (this.composer?.editable()) {
      const value = this.ui.composer.value();
      const d = this.drafts.get(this.composerId);
      if (value !== this.typed) this.drafts.put({ ...(d ?? makeDraft(this.composer.target, value, Date.now())), body: value, at: Date.now() });
    }
    this.drafts.flush();
  }

  // x: resolves the thread, or unresolves it. Shown at once (its fold kept
  // as it is), put back if GitHub says no; others see it at once.
  resolve(t, to, cx) {
    const word = to ? "Resolved" : "Unresolved";
    const flip = (resolved) => {
      if (!this.alive() || this.data.threads.every((x) => x.id !== t.id)) return;
      this.setThreads(withResolved(this.data.threads, t.id, resolved));
    };
    const sent = this.send({ op: "act", do: to ? "resolve" : "unresolve", thread: t.id }, cx, (r, cx) => {
      if (r.kind === "ok") {
        flip(r.answer.resolved === true);
        this.say(`${r.answer.resolved === true ? "Resolved" : "Unresolved"}. Others see it at once.`, cx);
      } else if (r.kind === "refused") {
        flip(!to);
        this.say(r.error, cx, true);
      } else {
        // Left as asked: the next poll after this one ended shows the truth.
        this.checks.push({ kind: "resolve", thread: t.id, want: to, after: Date.now() });
        this.say("No answer. Checking…", cx, true);
      }
    });
    if (!sent) return;
    this.fold.set(t.id, this.folded(t));
    this.foldN++;
    flip(to);
    this.say(`${word}: sending. Others see it at once.`, cx);
  }

  // ── keys ───────────────────────────────────────────────────────────────

  // A key on this tab, before the PR screen's own: true when it's taken
  // here. Declined: 1 2 3, tab, shift-tab, esc, left, backspace (tabs and
  // back), o y (link()), r (reload()); m d w s a l c h, which do nothing.
  // x is taken whatever the state, so it can say why it can't act.
  key(k, cx, held = false) {
    // Only tab and shift-tab come here while the filter has the keyboard
    // (main's keyDown sends it the rest): they don't navigate.
    const to = route(this.holder(), k, held);
    if (to === "type" || to === "swallow") return true;
    if (to === "dialog") {
      this.dialogKey(k, held, cx);
      return true;
    }
    if (to === "send") {
      if (this.dialog) this.dialogPress(cx, held);
      else this.composerPress(cx, held);
      return true;
    }
    if (to === "confirm") {
      this.confirmKey(k, cx);
      return true;
    }
    if (to === "again") {
      if (k === "cmd-enter") this.composerPress(cx, held);
      else this.keepDraftUnsent(cx);
      return true;
    }
    // The second delivery of the enter that left the filter.
    if (k === "enter" && Date.now() - this.leftAt < SAME_PRESS_MS) return true;
    if (to === "review") {
      this.reviewKey(k, cx);
      return true;
    }
    if (this.state !== "ok") return false;
    switch (k) {
      case "j":
      case "down":
        this.move(1, cx);
        break;
      case "k":
      case "up":
        this.move(-1, cx);
        break;
      case "]":
        this.stepFile(1, cx);
        break;
      case "[":
        this.stepFile(-1, cx);
        break;
      case "n":
        this.stepThread(1, cx);
        break;
      case "p":
        this.stepThread(-1, cx);
        break;
      case "u":
        this.nextUnviewed(cx);
        break;
      case "v":
        this.toggleViewed(cx);
        break;
      case "enter":
        this.toggleFold(cx);
        break;
      case "/":
        this.startFilter(cx);
        break;
      default:
        return false;
    }
    return true;
  }

  // Who has the keyboard, and what's asked (reviewkeys.js's route).
  holder() {
    return {
      keyboard: this.bodyWriting ? "body" : this.writing ? "composer" : this.filtering ? "filter" : "view",
      dialog: Boolean(this.dialog),
      composer: Boolean(this.composer),
      confirm: Boolean(this.confirm),
      again: this.composer?.phase === "again",
    };
  }

  // A key while a text box has the keyboard: it types there, and only these
  // mean more. main's keyDown lets every one through to it. In the
  // composer only cmd-enter does anything (A5): an x typed is an x.
  typingKey(k, cx, held = false) {
    if (route(this.holder(), k, held) === "send") return this.dialog ? this.dialogPress(cx, held) : this.composerPress(cx, held);
    if (this.writing || this.bodyWriting) return;
    if (k === "enter") this.leaveFilter(false, cx);
    else if (k === "down" || k === "up") this.stepFile(k === "down" ? 1 : -1, cx);
  }

  // esc on this tab: true when it was this tab's. In order: the submit
  // dialog (its discard step or "Send again?" first), a delete's
  // confirm (kept), "Send again?" (back to the draft), the composer (closed,
  // its draft kept), the filter (cleared, and left). One press, whichever
  // way it comes, does only the first.
  escape(cx) {
    if (this.dialog) {
      this.dialogEscape(cx);
      return true;
    }
    if (this.confirm) {
      this.confirm = null;
      this.say("Kept.", cx);
      return true;
    }
    if (this.composer?.phase === "again") {
      this.keepDraftUnsent(cx);
      return true;
    }
    if (this.composer) {
      this.closeComposer(cx);
      return true;
    }
    if (this.filtering || this.blurredNow()) {
      this.leaveFilter(true, cx);
      return true;
    }
    return Date.now() - this.leftAt < SAME_PRESS_MS;
  }

  // The filter lost focus on its own this press: the Input letting go of an
  // esc before the key comes here. That esc is still the filter's.
  blurredNow() {
    return Date.now() - this.blurAt < SAME_PRESS_MS;
  }

  startFilter(cx) {
    this.filtering = true;
    this.ui.filter.focus();
    cx.notify();
  }

  // Leaves the filter, keeping what it says (enter) or clearing it (esc).
  leaveFilter(clear, cx) {
    if (!this.filtering && !this.blurredNow()) return;
    this.filtering = false;
    this.blurAt = 0;
    this.leftAt = Date.now();
    if (clear && this.query) {
      this.query = "";
      this.ui.filter.set_value("");
    }
    this.app.keys.focus();
    cx.notify();
  }

  // The filter's InputState, through main: what it says, and its focus.
  filterChanged(value, cx) {
    this.query = value;
    const order = this.order();
    if (order.length && !order.some((f) => f.path === this.path)) this.openFile(order[0].path, cx);
    cx.notify();
  }

  filterFocus(on, cx) {
    // leaveFilter's own blur comes when it isn't typing any more.
    if (!on && this.filtering) this.blurAt = Date.now();
    this.filtering = on;
    cx.notify();
  }

  move(d, cx) {
    const items = this.items();
    if (!items?.length) return;
    this.at = Math.max(0, Math.min(items.length - 1, this.at + d));
    this.follow();
    cx.notify();
  }

  // Shows a file: its rows at the top, or the cursor on `target` once they
  // come (see settle).
  openFile(path, cx, target = null) {
    if (path !== this.path) {
      this.path = path;
      this.at = 0;
    }
    this.target = target;
    this.ui.diffScroll.scroll_to_item(0);
    this.followTree();
    this.settle();
    this.pump(cx);
    cx.notify();
  }

  stepFile(d, cx) {
    const order = this.order();
    if (!order.length) return;
    const i = order.findIndex((f) => f.path === this.path);
    const j = i < 0 ? 0 : i + d;
    if (j < 0 || j >= order.length) return this.say(d > 0 ? "That's the last file." : "That's the first file.", cx);
    this.openFile(order[j].path, cx);
  }

  // n, p: the next or previous unresolved thread, in this file past the
  // cursor, then in the files after it, round to the first.
  stepThread(d, cx) {
    const open = (it) => it.kind === "thread" && !it.t.resolved;
    const items = this.items();
    if (items) {
      const i = d > 0 ? items.findIndex((it, i) => i > this.at && open(it)) : lastIndex(items, (it, i) => i < this.at && open(it));
      if (i >= 0) {
        this.at = i;
        this.follow();
        return cx.notify();
      }
    }
    const hasOpen = (path) => (this.byPath.get(path) ?? []).some((t) => !t.resolved);
    const order = this.order();
    const n = order.length;
    const i = order.findIndex((f) => f.path === this.path);
    // Its diff still coming: its own threads first, once it's here.
    if (!items && i >= 0 && hasOpen(this.path)) {
      this.target = d > 0 ? "first-open" : "last-open";
      return;
    }
    for (let s = 1; s <= n; s++) {
      const j = (((i < 0 ? (d > 0 ? -1 : 0) : i) + d * s) % n + n) % n;
      if (!hasOpen(order[j].path)) continue;
      const round = i >= 0 && (d > 0 ? j <= i : j >= i);
      this.openFile(order[j].path, cx, d > 0 ? "first-open" : "last-open");
      if (round) this.say(d > 0 ? "Back to the first unresolved thread." : "Round to the last unresolved thread.", cx);
      return;
    }
    this.say(this.query ? "No unresolved threads in the files shown." : "No unresolved threads.", cx);
  }

  // u: the next file not viewed (one viewed, then changed, counts), round
  // to the first.
  nextUnviewed(cx) {
    const order = this.order();
    const n = order.length;
    const i = order.findIndex((f) => f.path === this.path);
    for (let s = 1; s <= n; s++) {
      const f = order[(i + s + n) % n];
      if (f.viewed === "viewed") continue;
      if (f.path !== this.path) this.openFile(f.path, cx);
      return;
    }
    this.say(this.query ? "Every file shown is viewed." : "Every file is viewed.", cx);
  }

  // v: marks the open file viewed (or not) on GitHub, for the head shown;
  // once it's viewed, on to the next that isn't. Drawn at once, put back
  // only if GitHub says no. Sent through send(), as every change is: never
  // while another is out.
  toggleViewed(cx) {
    const f = this.file();
    if (!f) return;
    const was = f.viewed;
    const to = was === "viewed" ? "unviewed" : "viewed";
    const head = this.data.head;
    const sent = this.send({ op: "act", do: to, path: f.path, head }, cx, (r, cx) => {
      this.saving.delete(f.path);
      if (!this.alive()) return;
      const mark = viewedAfter(r.kind, was, to);
      if (f.viewed === to) f.viewed = mark;
      if (r.kind === "ok") {
        // The files read again meanwhile, for the same head: theirs too.
        const now = this.data?.head === head ? this.file(f.path) : null;
        if (now) now.viewed = to;
      } else if (r.kind === "unknown") this.say(`No answer about ${f.path}. It may be marked or not: r shows which.`, cx, true);
      else if (r.answer?.stale === true) {
        this.behind = true;
        this.say(`${NEW_COMMITS} ${f.path} wasn't marked.`, cx, true);
      } else this.say(r.error, cx, true);
    });
    if (!sent) return;
    f.viewed = to;
    this.saving.add(f.path);
    if (to === "viewed") this.nextUnviewed(cx);
    cx.notify();
  }

  // enter: folds the thread under the cursor, or unfolds it.
  toggleFold(cx) {
    const t = this.items()?.[this.at]?.t;
    if (!t) return;
    this.fold.set(t.id, !this.folded(t));
    this.foldN++;
    this.target = { thread: t.id };
    this.settle();
    cx.notify();
  }

  // What o opens and y copies: the comment (or thread) under the cursor,
  // else the open file's diff on GitHub.
  link() {
    const url = this.app.cur?.url ?? this.pr.url;
    if (!url) return "";
    const it = this.state === "ok" ? this.items()?.[this.at] : null;
    if (it?.t) {
      const c = it.c ?? it.t.comments[0];
      return isWeb(c?.url) ? c.url : fileLink(url, it.t.path);
    }
    return this.path && this.state === "ok" ? fileLink(url, this.path) : `${url}/files`;
  }

  // ── drawing ────────────────────────────────────────────────────────────

  footer(k) {
    if (this.dialog) return this.dialogFooter(k);
    if (this.confirm) {
      return [
        k(["y"], "delete", (cx) => this.confirmKey("y", cx), "f-del-y"),
        k(["esc"], "keep it", (cx) => this.escape(cx), "f-del-n"),
      ];
    }
    if (this.composer?.phase === "again") {
      return [
        k(["cmd-enter"], "send again", (cx) => this.composerPress(cx, false), "f-again"),
        k(["esc"], "keep the draft", (cx) => this.keepDraftUnsent(cx), "f-keep-draft"),
      ];
    }
    if (this.writing) {
      return [
        k(["cmd-enter"], this.composer?.target.kind === "edit" ? "save" : "add to the review", (cx) => this.composerPress(cx, false), "f-send"),
        k(["esc"], "close, keeps the draft", (cx) => this.escape(cx), "f-close"),
      ];
    }
    if (this.filtering) {
      return [
        k(["enter"], "keep filter", (cx) => this.leaveFilter(false, cx), "f-keep"),
        k(["esc"], "clear filter", (cx) => this.leaveFilter(true, cx), "f-clear"),
        k(["↑", "↓"], "file", (cx) => this.stepFile(1, cx), "f-file"),
      ];
    }
    const out = [];
    if (this.state === "ok") {
      out.push(
        k(["j", "k"], "line", (cx) => this.move(1, cx), "f-line"),
        k(["]", "["], "file", (cx) => this.stepFile(1, cx), "f-file"),
        k(["n", "p"], "thread", (cx) => this.stepThread(1, cx), "f-thread"),
        k(["u"], "unviewed", (cx) => this.nextUnviewed(cx), "f-u"),
        k(["v"], this.file()?.viewed === "viewed" ? "not viewed" : "viewed", (cx) => this.toggleViewed(cx), "f-v"),
        k(["enter"], "fold", (cx) => this.toggleFold(cx), "f-fold"),
        k(["/"], "filter", (cx) => this.startFilter(cx), "f-filter"),
      );
      out.push(...this.reviewFooter(k));
    }
    out.push(
      k(["o"], "GitHub", (cx) => this.app.open(this.link(), cx), "f-o"),
      k(["y"], "copy link", (cx) => this.app.copy(this.link(), cx), "f-y"),
    );
    if (this.state === "ok" || this.state === "error") out.push(k(["r"], "reload", (cx) => this.app.reload(cx), "f-r"));
    return out;
  }

  dialogFooter(k) {
    const d = this.dialog;
    const esc = (label) => k(["esc"], label, (cx) => this.dialogEscape(cx), "f-dlg-esc");
    if (d.phase === "discard") return [k(["enter"], "discard, once it's typed", (cx) => this.dialogKey("enter", false, cx), "f-dlg-go"), esc("cancel")];
    if (d.phase === "again") return [k(["cmd-enter"], "send again", (cx) => this.dialogPress(cx, false), "f-dlg-go"), esc("keep it unsent")];
    if (d.phase === "sending" || d.phase === "checking") return [esc("close")];
    return [
      k(["tab"], d.focus === "body" ? "the choices" : "the text", (cx) => this.dialogKey("tab", false, cx), "f-dlg-tab"),
      k(["1", "2", "3"], "choose", (cx) => this.dialogKey("down", false, cx), "f-dlg-pick"),
      k(["cmd-enter"], d.button(this.ui.reviewBody.value()), (cx) => this.dialogPress(cx, false), "f-dlg-go"),
      esc("close, keeps the text"),
    ];
  }

  // The review keys that apply to what the cursor is on.
  reviewFooter(k) {
    if (!this.follows()) return [];
    const out = [];
    out.push(k(["shift-s"], this.review ? "submit review" : "review", (cx) => this.reviewKey("shift-s", cx), "f-s"));
    if (this.composer) {
      out.push(k(["cmd-enter"], "send the composer's", (cx) => this.composerPress(cx, false), "f-send"));
      out.push(k(["esc"], "close the composer", (cx) => this.escape(cx), "f-close"));
    }
    const it = this.items()?.[this.at];
    const t = it?.t;
    if (it?.kind === "row" && rowTarget(it.row, { pr: "", path: "", head: "" })) out.push(k(["c"], "comment", (cx) => this.reviewKey("c", cx), "f-c"));
    if (!t || t.local) return out;
    if (t.canReply) out.push(k(["c"], "reply", (cx) => this.reviewKey("c", cx), "f-c"));
    if (t.resolved ? t.canUnresolve : t.canResolve) {
      out.push(k(["x"], `${t.resolved ? "unresolve" : "resolve"} (others see it)`, (cx) => this.reviewKey("x", cx), "f-x"));
    }
    const mine = latestMine(t);
    if (mine?.canEdit) out.push(k(["e"], "edit yours", (cx) => this.reviewKey("e", cx), "f-e"));
    if (mine?.canDelete) out.push(k(["shift-d"], "delete yours", (cx) => this.reviewKey("shift-d", cx), "f-d"));
    return out;
  }

  note(o, text, color) {
    return div().flex_none().h(NOTE_H).flex().items_center().text_size(12.5).text_color(color ?? o.dim).truncate().child(text);
  }

  view(o) {
    const H = this.ui.height;
    if (this.state === "old") {
      // Only this computer can run a local build (dev.json); elsewhere it
      // takes a release that has these ops.
      const remote = this.app.on && !this.app.demo;
      return v_flex().h(H).gap(8).p(14)
        .child(div().text_size(13).font_medium().text_color(o.fg).child(`${remote ? `${this.app.on}'s` : "This computer's"} herdr-github is too old for Files changed.`))
        .child(div().text_size(12.8).text_color(o.dim).child(remote
          ? "No herdr-github release has it yet. Overview and Checks work as before, and o opens the files on GitHub."
          : "A local build named in dev.json has it (see the mod's RECIPE). Overview and Checks work as before, and o opens the files on GitHub."));
    }
    if (this.state === "error") {
      return v_flex().h(H).gap(8).p(14)
        .child(div().text_size(12.8).text_color(o.fix).child(this.error))
        .child(div().text_size(12.8).text_color(o.dim).child("r tries again; o opens the files on GitHub."));
    }
    if (this.state !== "ok") return v_flex().h(H).p(14).child(div().text_size(12.8).text_color(o.dim).child("Loading its files…"));
    const tab = h_flex().h(H).min_h(0).gap(12).items_start()
      .child(this.treePane(o, H))
      .child(this.diffPane(o, H));
    if (!this.dialog) return tab;
    return div().relative().h(H).w_full()
      .child(tab)
      .child(div().id("files-dialog").absolute().inset_0().flex().items_center().justify_center().bg(tint(o.surface, 0.72))
        .child(this.safe(() => this.dialogView(o), NOTE_H, "The submit dialog couldn't be drawn")));
  }

  // The submit dialog: what the review holds, drafts not in it, its text,
  // the choices, and what cmd-enter will do; or the discard step.
  dialogView(o) {
    const d = this.dialog;
    const now = Date.now();
    const body = this.ui.reviewBody.value();
    const flash = d.flashing(now);
    const panel = v_flex().w(Math.min(620, this.app.width - 80)).gap(10).p(16).rounded(10).border_1().border_color(o.line).bg(o.surface).shadow_md()
      .child(div().text_size(14).font_semibold().text_color(o.fg).child("Your review"))
      .child(h_flex().gap(10).items_center()
        .child(div().text_size(13).text_color(o.fg).child(d.countLine()))
        .when(Boolean(flash), (el) => el.child(div().text_size(12.5).font_medium().text_color(o.work).child(flash))));
    if (d.phase === "discard") {
      return panel
        .child(div().text_size(12.8).text_color(o.fix).child(d.discardLine()))
        .child(div().h(30).px(10).flex().items_center().rounded(6).border_1().border_color(o.fix).bg(o.sunk)
          .font_family(MONO).text_size(12.5).text_color(o.fg).child(`${d.typed}▏`))
        .child(div().text_size(11.5).text_color(o.dim).child("Anything else cancels."));
    }
    const ds = this.drafts.forPR(this.prKey()).filter((x) => x.kind !== "body");
    const loose = unplaced(ds, this.data.head);
    const n = ds.length - loose.length;
    const offered = d.offered(body);
    const editable = d.phase === "choose";
    return panel
      .when(n > 0, (el) => el.child(div().text_size(12).text_color(o.work)
        .child(`${n} ${n === 1 ? "draft is" : "drafts are"} not part of the review. cmd-enter in the composer adds one.`)))
      .when(loose.length > 0, (el) => el.child(v_flex().gap(4)
        .child(div().text_size(12).text_color(o.work).child("Typed at an older commit, and not on a line of this one (click to copy, or drop):"))
        .children(loose.map((x, i) => h_flex().gap(8).items_center().text_size(11.5)
          .child(div().id(`loose-${i}`).flex_1().min_w(0).truncate().cursor_pointer().text_color(o.muted)
            .hover((st) => st.text_color(o.fg))
            .on_click((_e, cx) => {
              cx.write_to_clipboard(x.body);
              this.say("Copied the draft.", cx);
            })
            .child(`${x.path} line ${x.line}${this.diffs.get(x.path)?.state === "ok" ? "" : " (its file not read yet)"}: ${x.body.split("\n")[0]}`))
          .child(div().id(`drop-${i}`).flex_none().cursor_pointer().text_color(o.fix).hover((st) => st.underline())
            .on_click((_e, cx) => {
              this.drafts.remove(x.id);
              this.draftsN++;
              this.say("Dropped that draft.", cx);
            })
            .child("drop"))))))
      .child(div().text_size(11.5).text_color(o.dim).child("The review's text (optional)"))
      .child(editable
        ? div().rounded(6).border_1().border_color(this.bodyWriting ? o.accent : o.line).child(Textarea.new(this.ui.reviewBody).w_full().text_size(12.5).text_color(o.fg))
        : div().max_h(120).overflow_hidden().p(8).rounded(6).bg(o.sunk).text_size(12.5).text_color(o.muted).child(body || " "))
      .child(v_flex().gap(2).children(CHOICES.map((c, i) => {
        const on = d.pick === c.id;
        const ok = offered.some((x) => x.id === c.id);
        return h_flex().h(26).px(8).gap(10).items_center().rounded(6)
          .when(on && d.focus === "choices", (el) => el.bg(tint(o.accent, 0.18)))
          .when(on && d.focus !== "choices", (el) => el.bg(o.sunk))
          .child(div().flex_none().w(14).font_family(MONO).text_size(11.5).text_color(o.dim).child(i < 3 ? String(i + 1) : ""))
          .child(div().text_size(13).text_color(!ok ? o.dim : c.id === "discard" ? o.fix : on ? o.fg : o.muted)
            .when(on, (el) => el.font_medium())
            .child(ok ? c.label : `${c.label} (not offered)`));
      })))
      .child(div().text_size(13).font_semibold().text_color(d.pick === "discard" ? o.fix : o.accent).child(d.button(body)))
      .when(Boolean(d.note), (el) => el.child(div().text_size(12).text_color(d.phase === "sending" ? o.dim : d.note === DIALOG_NOTES.gone ? o.review : o.work).child(d.note)));
  }

  // The tree: the filter, how many files are viewed, and the files.
  treePane(o, H) {
    const { rows } = this.tree();
    const files = this.data.files;
    const seen = files.filter((f) => f.viewed === "viewed").length;
    // The files read can't say which of its caps it hit, so its word stands
    // until r; a poll's says only the threads'.
    const more = this.data.filesMore || this.data.more;
    const listH = H - FILTER_H - SUMMARY_H - 2 * GAP - (more ? NOTE_H * 2 + GAP : 0);
    return v_flex().w(TREE_W).flex_none().h(H).gap(GAP)
      .child(h_flex().id("files-filter").flex_none().h(FILTER_H).px(10).gap(8).items_center().rounded(8).border_1()
        .border_color(this.filtering ? o.accent : o.line).bg(o.sunk)
        .on_click((_e, cx) => !this.dialog && this.startFilter(cx))
        .child(icon("search", o.dim, 13))
        .child(Input.new(this.ui.filter).flex_1().h_full().text_size(12.5).text_color(o.fg)))
      .child(h_flex().flex_none().h(SUMMARY_H).gap(8).items_center().text_size(11.5).text_color(o.dim)
        .child(div().flex_1().min_w(0).truncate().child(this.reading ? "Reading its files again…" : `${files.length} files · ${seen} viewed`))
        .child(div().flex_none().font_family(MONO).child(`at ${this.data.head.slice(0, 7)}`)))
      .child(rows.length
        ? div().relative().flex_none().h(listH)
          .child(v_virtual_list("gh-tree", rows.length, TREE_ROW_H, (i) => rows[i].key,
            (range) => rows.slice(range.start, range.end).map((r) => this.safe(() => treeRow(o, r, r.file?.path === this.path), TREE_ROW_H, r.name)))
            .track_scroll(this.ui.treeScroll).size_full()
            .on_item_click((key, cx) => {
              if (this.dialog) return; // under the dialog: not this click's
              const r = rows.find((x) => x.key === key);
              if (r?.file) this.openFile(r.file.path, cx);
            }))
          .child(Scrollbar.vertical("gh-tree").absolute().inset_0())
        : div().flex_none().h(listH).text_size(12.5).text_color(o.dim).child(files.length ? "No file matches." : "No files changed."))
      .when(more, (el) => el.child(div().flex_none().h(NOTE_H * 2).text_size(11.5).text_color(o.work)
        .child("Not every file, thread or comment came, so counts are at least these: GitHub has the rest.")));
  }

  // The open file: its header at once, its rows and threads when they come.
  diffPane(o, H) {
    const f = this.file();
    if (!f) return v_flex().flex_1().min_w(0).h(H).child(this.note(o, "No file."));
    const items = this.items();
    this.settle();
    const d = this.diffs.get(f.path);
    const notes = [];
    const failed = this.failed.get(f.path);
    if (this.behind && failed !== NEW_COMMITS) notes.push(this.note(o, NEW_COMMITS, o.work));
    if (this.health.error) notes.push(this.note(o, `Couldn't follow the PR: ${this.health.error}`));
    if (!items) notes.push(this.note(o, "Loading its diff…"));
    else if (failed) notes.push(this.note(o, `${failed}${/r tries again/.test(failed) ? "" : " r tries again."}`, o.fix));
    else if (d.state === "binary") notes.push(this.note(o, "A binary file: no text diff."));
    else if (d.state === "large") notes.push(this.note(o, "Too large to show here: o opens it on GitHub."));
    else if (d.state === "empty") notes.push(this.note(o, f.status === "renamed" ? "Renamed, no lines changed." : "No lines changed."));
    const listH = H - FILE_HEAD_H - GAP - notes.length * (NOTE_H + GAP);
    // With the composer open the list takes what it leaves: its text box
    // grows with what's typed (3 to 10 rows), so its height isn't known here.
    const composing = Boolean(this.composer);
    return v_flex().flex_1().min_w(0).h(H).gap(GAP)
      .child(this.fileHead(o, f))
      .children(notes)
      .when(Boolean(items?.length), (el) => el.child(
        div().relative().w_full()
          .when(composing, (el) => el.flex_1().min_h(0))
          .when(!composing, (el) => el.flex_none().h(listH))
          .on_size_change((size, cx) => {
            if (Math.abs(size.width - this.width) > 20) {
              this.width = size.width;
              cx.notify();
            }
          })
          .child(v_virtual_list("gh-diff", items.length, items.map((it) => it.h), (i) => items[i].key,
            (range) => {
              this.topKey = items[range.start]?.key ?? null; // the scroll's anchor for a merge
              return items.slice(range.start, range.end).map((it, n) => this.safe(() => diffItem(o, it, range.start + n === this.at, this.drafted(it)), it.h, it.row?.text ?? it.text ?? ""));
            })
            .track_scroll(this.ui.diffScroll).size_full()
            .on_item_click((key, cx) => {
              if (this.dialog) return; // under the dialog: not this click's
              const i = items.findIndex((x) => x.key === key);
              if (i < 0) return;
              if (i === this.at && items[i].t) return this.toggleFold(cx);
              this.at = i;
              cx.notify();
            }))
          .child(Scrollbar.vertical("gh-diff").absolute().inset_0())))
      .when(composing && !items?.length, (el) => el.child(div().flex_1().min_h(0)))
      .when(composing, (el) => el.child(this.safe(() => this.composerView(o), NOTE_H, "The composer couldn't be drawn")));
  }

  // The composer, docked under the diff: what it's for, the text box (or,
  // while it can't be typed in, what it holds), how it stands, its keys.
  composerView(o) {
    const c = this.composer;
    const tone = c.phase === "editing" && !c.unconfirmed ? o.fix : o.work;
    return v_flex().flex_none().w_full().gap(6).p(10).rounded(8).border_1().border_color(this.writing ? o.accent : o.line).bg(o.raised)
      .child(div().text_size(12).font_medium().text_color(o.fg).truncate().child(purpose(c.target)))
      .when(c.target.kind === "comment" && Boolean(c.target.text), (el) => el.child(
        div().font_family(MONO).text_size(11.5).text_color(o.dim).truncate().child(c.target.text)))
      .child(c.editable()
        ? Textarea.new(this.ui.composer).w_full().text_size(12.5).text_color(o.fg)
        : div().w_full().max_h(200).overflow_hidden().p(8).rounded(6).bg(o.sunk).text_size(12.5).text_color(o.muted).child(this.ui.composer.value() || " "))
      .when(Boolean(c.note), (el) => el.child(div().text_size(12).text_color(c.phase === "sending" ? o.dim : tone).child(c.note)))
      .child(div().text_size(11.5).text_color(o.dim).child(this.composerKeys(c)));
  }

  composerKeys(c) {
    if (c.phase === "again") return "cmd-enter sends again · esc keeps the draft";
    if (c.phase === "sending" || c.phase === "checking") return "esc closes it; the draft is kept";
    const verb = c.target.kind === "edit" ? "saves" : "adds it to your pending review";
    return `cmd-enter ${verb} · esc closes, keeping the draft${this.writing ? "" : " · click the box (or c on its line) to type"}`;
  }

  // The open file's header: status, path (and where it came from), size,
  // threads, viewed.
  fileHead(o, f) {
    const mark = statusMark(f.status);
    const threads = this.byPath.get(f.path) ?? [];
    const open = threads.filter((t) => !t.resolved).length;
    const viewed = f.viewed === "viewed" ? ["viewed", o.review] : f.viewed === "dismissed" ? ["changed since viewed", o.work] : ["not viewed", o.dim];
    return h_flex().flex_none().h(FILE_HEAD_H).px(10).gap(8).items_center().rounded(8).bg(o.raised)
      .child(div().flex_none().font_family(MONO).text_size(11.5).font_semibold().text_color(o[mark.tone]).child(mark.letter))
      .child(div().flex_1().min_w(0).truncate().font_family(MONO).text_size(12).text_color(o.fg).child(f.from ? `${f.from} → ${f.path}` : f.path))
      .child(div().flex_none().font_family(MONO).text_size(11.5).text_color(o.review).child(`+${f.additions}`))
      .child(div().flex_none().font_family(MONO).text_size(11.5).text_color(o.fix).child(`−${f.deletions}`))
      .when(threads.length > 0, (el) => el.child(div().flex_none().text_size(11.5).text_color(open ? o.work : o.dim)
        .child(open ? `${open} open ${open === 1 ? "thread" : "threads"}` : `${threads.length} resolved`)))
      .child(h_flex().flex_none().gap(5).items_center().text_size(11.5).text_color(viewed[1])
        .child(viewedMark(o, f)).child(div().child(this.saving.has(f.path) ? "saving…" : viewed[0])));
  }

  // One list item, its own height whatever it holds. A drawing that throws
  // costs that item its looks, not the tab.
  safe(draw, h, text) {
    try {
      return draw();
    } catch (e) {
      return div().h(h).overflow_hidden().text_size(11.5).child(`${text} (${said(e)})`);
    }
  }
}
