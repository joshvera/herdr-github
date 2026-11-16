// The PR screen's Files changed tab: the PR's changed files as a tree at the
// left, one file's diff at the right with its review threads between the
// lines they're on. Every move is one key. It reads; the one thing it changes
// on GitHub is a file's viewed mark.
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
// tab first; see `key`. Its filter's InputState and the lists' scroll
// handles are main's (made in init, as the runtime wants), passed as `ui`.

import { div } from "gpui-kit";
import { v_flex, h_flex, Input, TextView, Scrollbar, v_virtual_list } from "gpui-base";
import { createHash } from "crypto";
import { tint, ago, icon, chip, MONO } from "./look.js";
import { treeRows, matchesPath, statusMark } from "./filetree.js";
import { diffItems, threadWhere } from "./diffitems.js";

const TREE_W = 290;
const TREE_ROW_H = 24;
const FILTER_H = 30;
const SUMMARY_H = 18;
const FILE_HEAD_H = 30;
const NOTE_H = 22;
const GAP = 6;
// A thread's box starts this far in from the rows' left edge.
const INDENT = 24;

// `files` and `diff` can take a while on a big PR (every REST page).
const SLOW = { timeout: 120000 };

// The keys a held key repeats. Anything else held does nothing: a repeat
// comes faster than anyone sees what it did (v, enter, r, o).
const MOVES = new Set(["j", "k", "down", "up", "]", "[", "n", "p"]);

// A press that left the filter, coming again the other way (the Input's
// submit and on_key_down, a binding and on_key_down): taken, once.
const SAME_PRESS_MS = 150;

// An older herdr-github, from before these ops.
const TOO_OLD = /no op "(files|diff)"/;

const said = (e) => String(e?.message ?? e);
// The last index of `xs` where `ok` holds, or -1.
const lastIndex = (xs, ok) => {
  for (let i = xs.length - 1; i >= 0; i--) if (ok(xs[i], i)) return i;
  return -1;
};
// herdr-github's answer that the PR's head moved past the one named (main's AppError).
const isStale = (e) => e instanceof Error && "stale" in e && e.stale === true;
const isWeb = (url) => typeof url === "string" && /^https:\/\//.test(url);

// A file's diff on GitHub: the PR's files page, at that file.
export function fileLink(prUrl, path) {
  return `${prUrl}/files#diff-${createHash("sha256").update(path).digest("hex")}`;
}

export class FilesView {
  /**
   * @param {any} app the GitHub view (main.js)
   * @param {{ filter: any, diffScroll: any, treeScroll: any, height: number }} ui
   */
  constructor(app, ui) {
    this.app = app;
    this.ui = ui;
    this.pr = app.cur;
    this.state = "idle"; // idle, loading, ok, error, old
    this.error = "";
    this.data = null; // `files`'s answer: head, files, threads, more
    this.byPath = new Map(); // a file's threads
    this.gen = 0; // which `files` load is the latest
    this.reading = false; // a `files` load is out
    this.diffs = new Map(); // path → `diff`'s answer, for data.head
    this.failed = new Map(); // path → why its diff didn't come, until r
    this.asking = null; // the one diff request out
    this.staleHead = null; // the head a stale diff already reloaded for
    this.path = null; // the open file
    this.at = 0; // the cursor: an index into items()
    this.target = null; // where the cursor goes once the open file's items come
    this.fold = new Map(); // thread id → folded, when not as it starts
    this.foldN = 0;
    this.query = "";
    this.typing = false; // the filter has the keyboard
    this.leftAt = 0;
    this.saving = new Set(); // paths whose viewed mark is being saved
    this.width = Math.max(320, app.width - 32 - TREE_W - 12);
    this.treeMemo = { data: null, query: "", rows: [], order: [] };
    this.itemsMemo = { key: [], items: [] };
    ui.filter.set_value("");
  }

  // Whether it's still the tab's view (a PR opened since replaces it).
  alive() {
    return this.app.files === this;
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

  follow() {
    this.ui.diffScroll.scroll_to_item(this.at);
  }

  // ── fetching ───────────────────────────────────────────────────────────

  // The tab came into view: its files, the first time.
  shown(cx) {
    if (this.state === "idle") this.loadFiles(cx);
    else this.pump(cx);
  }

  // r: the files again, and the open file's diff; errors forgotten.
  reload(cx) {
    this.failed.clear();
    if (this.path) this.diffs.delete(this.path);
    this.staleHead = null;
    if (this.state === "old" || this.state === "error") this.state = "idle";
    this.loadFiles(cx);
  }

  loadFiles(cx, note = "") {
    const gen = ++this.gen;
    this.reading = true;
    if (!this.data) this.state = "loading";
    cx.notify();
    cx.spawn(async (cx) => {
      let res;
      try {
        res = await this.app.gh({ op: "files", pr: this.prID() }, SLOW);
      } catch (e) {
        if (gen !== this.gen) return;
        this.reading = false;
        if (TOO_OLD.test(said(e))) this.state = "old";
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
      if (gen !== this.gen) return;
      this.reading = false;
      if (this.data?.head !== res.head) {
        this.diffs.clear();
        this.failed.clear();
        this.asking = null; // an answer for the old head is let go
      }
      this.data = { head: res.head, files: res.files ?? [], threads: res.threads ?? [], more: Boolean(res.more) };
      this.byPath = new Map();
      for (const t of this.data.threads) this.byPath.set(t.path, [...(this.byPath.get(t.path) ?? []), t]);
      this.state = "ok";
      if (!this.file()) {
        this.path = this.order()[0]?.path ?? this.data.files[0]?.path ?? null;
        this.at = 0;
      }
      if (note) this.say(note, cx);
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
        res = await this.app.gh({ op: "diff", pr: this.prID(), path, head }, SLOW);
      } catch (e) {
        err = e;
      }
      if (this.asking !== req) return; // a new head took its place
      this.asking = null;
      if (this.data?.head !== head) return this.pump(cx);
      if (err && TOO_OLD.test(said(err))) this.state = "old";
      else if (err) this.failed.set(path, said(err));
      else if (res.state === "stale") return this.stale(path, head, cx);
      else this.diffs.set(path, res);
      if (path === this.path) this.settle();
      this.pump(cx);
      cx.notify();
    });
  }

  // GitHub answered a diff for a newer head than `files` said: read the
  // files again. A second time for the same head means its two answers
  // disagree (REST can lag GraphQL); that waits for r rather than go round.
  stale(path, head, cx) {
    if (this.staleHead === head) {
      this.failed.set(path, "GitHub answered this file for another commit than its list of files. r tries again.");
      this.pump(cx);
      return cx.notify();
    }
    this.staleHead = head;
    this.loadFiles(cx, "The PR has new commits: its files are read again.");
  }

  // ── keys ───────────────────────────────────────────────────────────────

  // A key on this tab, before the PR screen's own: true when it's taken
  // here. Declined: 1 2 3, tab, shift-tab, esc, left, backspace (tabs and
  // back), o y (link()), r (reload()); m d w s a l c x h, which do nothing.
  key(k, cx, held = false) {
    // Only tab and shift-tab come here while the filter has the keyboard
    // (main's keyDown sends it the rest): they don't navigate.
    if (this.typing) return true;
    if (held && !MOVES.has(k)) return true;
    // The second delivery of the enter that left the filter.
    if (k === "enter" && Date.now() - this.leftAt < SAME_PRESS_MS) return true;
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

  // A key while the filter has the keyboard: it types into the filter, and
  // only these mean more. main's keyDown lets every one through to it.
  typingKey(k, cx) {
    if (k === "enter") this.leaveFilter(false, cx);
    else if (k === "down" || k === "up") this.stepFile(k === "down" ? 1 : -1, cx);
  }

  // esc on this tab: true when it was the filter's (esc clears it, and
  // leaves it). One press, whichever way it comes, leaves only the filter.
  escape(cx) {
    if (this.typing) {
      this.leaveFilter(true, cx);
      return true;
    }
    return Date.now() - this.leftAt < SAME_PRESS_MS;
  }

  startFilter(cx) {
    this.typing = true;
    this.ui.filter.focus();
    cx.notify();
  }

  // Leaves the filter, keeping what it says (enter) or clearing it (esc).
  leaveFilter(clear, cx) {
    if (!this.typing) return;
    this.typing = false;
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
    this.typing = on;
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
    const i = this.tree().rows.findIndex((r) => r.file?.path === path);
    if (i >= 0) this.ui.treeScroll.scroll_to_item(i);
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
  // once it's viewed, on to the next that isn't. Drawn at once, put back if
  // GitHub says no.
  toggleViewed(cx) {
    const f = this.file();
    if (!f) return;
    if (this.saving.has(f.path)) return this.say(`Still saving ${f.path}…`, cx);
    const was = f.viewed;
    const to = was === "viewed" ? "unviewed" : "viewed";
    const head = this.data.head;
    f.viewed = to;
    this.saving.add(f.path);
    cx.spawn(async (cx) => {
      try {
        await this.app.gh({ op: "act", do: to, pr: this.prID(), path: f.path, head });
        // The files read again meanwhile, for the same head: theirs too.
        const now = this.data?.head === head ? this.file(f.path) : null;
        if (now) now.viewed = to;
      } catch (e) {
        if (f.viewed === to) f.viewed = was;
        if (isStale(e)) this.loadFiles(cx, `The PR has new commits, so ${f.path} wasn't marked: its files are read again.`);
        else this.say(said(e), cx, true);
      }
      this.saving.delete(f.path);
      cx.notify();
    });
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
    if (this.typing) {
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
    }
    out.push(
      k(["o"], "GitHub", (cx) => this.app.open(this.link(), cx), "f-o"),
      k(["y"], "copy link", (cx) => this.app.copy(this.link(), cx), "f-y"),
    );
    if (this.state === "ok" || this.state === "error") out.push(k(["r"], "reload", (cx) => this.app.reload(cx), "f-r"));
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
    return h_flex().h(H).min_h(0).gap(12).items_start()
      .child(this.treePane(o, H))
      .child(this.diffPane(o, H));
  }

  // The tree: the filter, how many files are viewed, and the files.
  treePane(o, H) {
    const { rows } = this.tree();
    const files = this.data.files;
    const seen = files.filter((f) => f.viewed === "viewed").length;
    const more = this.data.more;
    const listH = H - FILTER_H - SUMMARY_H - 2 * GAP - (more ? NOTE_H * 2 + GAP : 0);
    return v_flex().w(TREE_W).flex_none().h(H).gap(GAP)
      .child(h_flex().id("files-filter").flex_none().h(FILTER_H).px(10).gap(8).items_center().rounded(8).border_1()
        .border_color(this.typing ? o.accent : o.line).bg(o.sunk)
        .on_click((_e, cx) => this.startFilter(cx))
        .child(icon("search", o.dim, 13))
        .child(Input.new(this.ui.filter).flex_1().h_full().text_size(12.5).text_color(o.fg)))
      .child(h_flex().flex_none().h(SUMMARY_H).gap(8).items_center().text_size(11.5).text_color(o.dim)
        .child(div().flex_1().min_w(0).truncate().child(this.reading ? "Reading its files again…" : `${files.length} files · ${seen} viewed`))
        .child(div().flex_none().font_family(MONO).child(`at ${this.data.head.slice(0, 7)}`)))
      .child(rows.length
        ? div().relative().flex_none().h(listH)
          .child(v_virtual_list("gh-tree", rows.length, TREE_ROW_H, (i) => rows[i].key,
            (range) => rows.slice(range.start, range.end).map((r) => this.safe(() => this.treeRow(o, r), TREE_ROW_H, r.name)))
            .track_scroll(this.ui.treeScroll).size_full()
            .on_item_click((key, cx) => {
              const r = rows.find((x) => x.key === key);
              if (r?.file) this.openFile(r.file.path, cx);
            }))
          .child(Scrollbar.vertical("gh-tree").absolute().inset_0())
        : div().flex_none().h(listH).text_size(12.5).text_color(o.dim).child(files.length ? "No file matches." : "No files changed."))
      .when(more, (el) => el.child(div().flex_none().h(NOTE_H * 2).text_size(11.5).text_color(o.work)
        .child("Not every file, thread or comment came: counts are at least these. o opens the PR on GitHub.")));
  }

  // A row of the tree: a folder, or a file with its status, open threads
  // and viewed mark. Drawn inside the list: no handlers.
  treeRow(o, r) {
    const pad = 6 + r.depth * 12;
    if (r.kind === "dir") {
      return h_flex().h(TREE_ROW_H).pl(pad).pr(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(o.dim).child(`${r.name}/`));
    }
    const f = r.file;
    const on = f.path === this.path;
    const mark = statusMark(f.status);
    return h_flex().h(TREE_ROW_H).pl(pad).pr(6).gap(6).items_center().rounded(5)
      .when(on, (el) => el.bg(tint(o.accent, 0.16)))
      .child(div().flex_none().w(12).font_family(MONO).text_size(11).text_color(o[mark.tone]).child(mark.letter))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(on ? o.fg : o.muted).child(r.name))
      .when(f.open > 0, (el) => el.child(h_flex().flex_none().gap(3).items_center().text_size(11).text_color(o.work)
        .child(icon("need", o.work, 11)).child(div().child(String(f.open)))))
      .child(this.viewedMark(o, f));
  }

  viewedMark(o, f) {
    if (f.viewed === "viewed") return icon("check", o.review, 12);
    if (f.viewed === "dismissed") return icon("idle", o.work, 12);
    return div().flex_none().w(10).h(10).mx(1).rounded(2).border_1().border_color(o.dim);
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
    if (!items) notes.push(this.note(o, "Loading its diff…"));
    else if (failed) notes.push(this.note(o, `${failed}${/r tries again/.test(failed) ? "" : " r tries again."}`, o.fix));
    else if (d.state === "binary") notes.push(this.note(o, "A binary file: no text diff."));
    else if (d.state === "large") notes.push(this.note(o, "Too large to show here: o opens it on GitHub."));
    else if (d.state === "empty") notes.push(this.note(o, f.status === "renamed" ? "Renamed, no lines changed." : "No lines changed."));
    const listH = H - FILE_HEAD_H - GAP - notes.length * (NOTE_H + GAP);
    return v_flex().flex_1().min_w(0).h(H).gap(GAP)
      .child(this.fileHead(o, f))
      .children(notes)
      .when(Boolean(items?.length), (el) => el.child(
        div().relative().flex_none().h(listH).w_full()
          .on_size_change((size, cx) => {
            if (Math.abs(size.width - this.width) > 20) {
              this.width = size.width;
              cx.notify();
            }
          })
          .child(v_virtual_list("gh-diff", items.length, items.map((it) => it.h), (i) => items[i].key,
            (range) => items.slice(range.start, range.end).map((it, n) => this.safe(() => this.item(o, it, range.start + n === this.at), it.h, it.row?.text ?? "")))
            .track_scroll(this.ui.diffScroll).size_full()
            .on_item_click((key, cx) => {
              const i = items.findIndex((x) => x.key === key);
              if (i < 0) return;
              if (i === this.at && items[i].t) return this.toggleFold(cx);
              this.at = i;
              cx.notify();
            }))
          .child(Scrollbar.vertical("gh-diff").absolute().inset_0())));
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
        .child(this.viewedMark(o, f)).child(div().child(this.saving.has(f.path) ? "saving…" : viewed[0])));
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

  // One item of the diff: a row or a piece of a thread, with the cursor's
  // bar at its left. Drawn inside the list: no handlers.
  item(o, it, on) {
    const bar = div().flex_none().w(3).h_full().when(on, (el) => el.bg(o.accent));
    const body = it.kind === "row" ? this.row(o, it.row, on)
      : it.kind === "thread" ? this.threadHead(o, it, on)
      : it.kind === "hunk" ? this.hunk(o, it)
      : this.comment(o, it, on);
    return h_flex().h(it.h).w_full().overflow_hidden().items_stretch().child(bar).child(body);
  }

  row(o, r, on) {
    const num = (n) => div().flex_none().w(36).text_right().text_color(o.dim).child(n ? String(n) : "");
    const base = h_flex().flex_1().min_w(0).h_full().items_center().gap(8).pr(8).font_family(MONO).text_size(11.5)
      .when(on, (el) => el.bg(tint(o.accent, 0.2)));
    if (r.kind === "hunk") return base.when(!on, (el) => el.bg(o.sunk)).child(div().flex_1().min_w(0).truncate().pl(8).text_color(o.dim).child(r.text));
    if (r.kind === "note") return base.child(div().flex_1().min_w(0).truncate().pl(92).italic().text_color(o.dim).child(r.text));
    const sign = r.kind === "add" ? ["+", o.review, tint(o.review, 0.12)] : r.kind === "del" ? ["-", o.fix, tint(o.fix, 0.12)] : [" ", o.dim, null];
    return base.when(!on && Boolean(sign[2]), (el) => el.bg(sign[2]))
      .child(num(r.old)).child(num(r.new))
      .child(div().flex_none().w(10).text_color(sign[1]).child(sign[0]))
      .child(div().flex_1().min_w(0).truncate().text_color(o.fg).child(r.text || " "));
  }

  // A thread's first line: where it is, its state, who, how many; folded,
  // the start of its first comment too.
  threadHead(o, it, on) {
    const t = it.t;
    const first = t.comments[0];
    const n = t.comments.length;
    const pending = t.comments.some((c) => c.state === "pending");
    return h_flex().flex_1().min_w(0).ml(INDENT).mr(12).mt(4).px(10).gap(8).items_center()
      .bg(on ? tint(o.accent, 0.16) : o.raised).border_1().border_color(on ? o.accent : o.line)
      .when(it.last, (el) => el.rounded(8).mb(0))
      .when(!it.last, (el) => el.rounded_t(8).border_b_0())
      .child(icon(t.resolved ? "check" : "need", t.resolved ? o.review : o.work, 12))
      .child(div().flex_none().font_family(MONO).text_size(11.5).text_color(o.muted).child(threadWhere(t) || "thread"))
      .when(t.outdated, (el) => el.child(chip(o, `out-${t.id}`, ["outdated"], { color: o.work })))
      .when(t.resolved, (el) => el.child(div().flex_none().text_size(11.5).text_color(o.review).child("resolved")))
      .when(pending, (el) => el.child(chip(o, `pend-${t.id}`, ["pending, not sent"], { color: o.accent })))
      .child(div().flex_none().text_size(12).font_medium().text_color(o.fg).child(first?.author ?? ""))
      .child(div().flex_none().text_size(11.5).text_color(o.dim).child(n === 1 ? "1 comment" : `${n} comments`))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(o.dim)
        .child(it.folded ? (first?.body ?? "").split("\n").find((l) => l.trim()) ?? "" : ""))
      .when(on, (el) => el.child(div().flex_none().text_size(11).text_color(o.dim).child(it.folded ? "enter unfolds" : "enter folds")));
  }

  // What an outdated thread was about: the end of its hunk.
  hunk(o, it) {
    return v_flex().flex_1().min_w(0).ml(INDENT).mr(12).px(10).py(5).bg(o.sunk).border_l_1().border_r_1().border_color(o.line)
      .when(it.last, (el) => el.border_b_1().rounded_b(8).mb(6))
      .font_family(MONO).text_size(11)
      .children(it.lines.map((l) => h_flex().h(18).gap(6).items_center()
        .when(l.kind !== "ctx", (el) => el.bg(tint(l.kind === "add" ? o.review : o.fix, 0.12)))
        .child(div().flex_none().w(10).text_color(l.kind === "add" ? o.review : l.kind === "del" ? o.fix : o.dim).child(l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "))
        .child(div().flex_1().min_w(0).truncate().text_color(o.muted).child(l.text))));
  }

  // A piece of a comment: its author and age first, then its Markdown.
  comment(o, it, on) {
    const c = it.c;
    return v_flex().flex_1().min_w(0).ml(INDENT).mr(12).px(12).pt(it.first ? 6 : 0).pb(8).gap(4).overflow_hidden()
      .bg(on ? tint(o.accent, 0.08) : o.raised).border_l_1().border_r_1().border_color(o.line)
      .when(it.last, (el) => el.border_b_1().rounded_b(8).mb(6))
      .when(it.first, (el) => el.child(h_flex().flex_none().h(18).gap(8).items_center()
        .child(div().text_size(12).font_semibold().text_color(o.fg).child(c.author || "someone"))
        .child(div().text_size(11.5).text_color(o.dim).child(ago(c.created)))
        .when(c.state === "pending", (el) => el.child(chip(o, `cp-${c.id}`, ["pending, not sent"], { color: o.accent })))))
      .when(Boolean(it.text), (el) => el.child(TextView.markdown(`md-${it.key}`, it.text).text_size(12.5).text_color(o.muted)));
  }
}
