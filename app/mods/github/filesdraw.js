// How the Files changed tab draws what its lists hold: a row of the tree,
// and the diff's items (a row, a thread's first line, an outdated thread's
// hunk, a piece of a comment). All of it is drawn inside a virtual list's
// renderer, so nothing here takes a handler (no on_click, no
// on_link_click): clicks reach the list's on_item_click.

import { div } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { tint, ago, icon, chip, MONO } from "./look.js";
import { statusMark } from "./filetree.js";
import { threadWhere } from "./diffitems.js";

export const TREE_ROW_H = 24;
// A thread's box starts this far in from the rows' left edge.
const INDENT = 24;

// A row of the tree: a folder, or a file with its status, open threads
// and viewed mark. Drawn inside the list: no handlers.
export function treeRow(o, r, on) {
  const pad = 6 + r.depth * 12;
  if (r.kind === "dir") {
    return h_flex().h(TREE_ROW_H).pl(pad).pr(6).items_center()
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(o.dim).child(`${r.name}/`));
  }
  const f = r.file;
  const mark = statusMark(f.status);
  return h_flex().h(TREE_ROW_H).pl(pad).pr(6).gap(6).items_center().rounded(5)
    .when(on, (el) => el.bg(tint(o.accent, 0.16)))
    .child(div().flex_none().w(12).font_family(MONO).text_size(11).text_color(o[mark.tone]).child(mark.letter))
    .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(on ? o.fg : o.muted).child(r.name))
    .when(f.open > 0, (el) => el.child(h_flex().flex_none().gap(3).items_center().text_size(11).text_color(o.work)
      .child(icon("need", o.work, 11)).child(div().child(String(f.open)))))
    .child(viewedMark(o, f));
}

// A file's viewed mark: a check; viewed, then changed; or an empty box.
export function viewedMark(o, f) {
  if (f.viewed === "viewed") return icon("check", o.review, 12);
  if (f.viewed === "dismissed") return icon("idle", o.work, 12);
  return div().flex_none().w(10).h(10).mx(1).rounded(2).border_1().border_color(o.dim);
}

// One item of the diff: a row or a piece of a thread, with the cursor's
// bar at its left; `drafted`, a draft of yours waits on it. Drawn inside
// the list: no handlers.
export function diffItem(o, it, on, drafted = false) {
  const bar = div().flex_none().w(3).h_full().when(on, (el) => el.bg(o.accent));
  const body = it.kind === "row" ? row(o, it.row, on, drafted)
    : it.kind === "thread" ? threadHead(o, it, on, drafted)
    : it.kind === "hunk" ? hunk(o, it)
    : comment(o, it, on);
  return h_flex().h(it.h).w_full().overflow_hidden().items_stretch().child(bar).child(body);
}

// The "draft" mark: a draft of yours, not sent, on this line or thread.
const draftMark = (o) => div().flex_none().px(5).rounded(4).bg(tint(o.work, 0.14)).text_size(10.5).text_color(o.work).child("draft");

function row(o, r, on, drafted) {
  const num = (n) => div().flex_none().w(36).text_right().text_color(o.dim).child(n ? String(n) : "");
  const base = h_flex().flex_1().min_w(0).h_full().items_center().gap(8).pr(8).font_family(MONO).text_size(11.5)
    .when(on, (el) => el.bg(tint(o.accent, 0.2)));
  if (r.kind === "hunk") return base.when(!on, (el) => el.bg(o.sunk)).child(div().flex_1().min_w(0).truncate().pl(8).text_color(o.dim).child(r.text));
  if (r.kind === "note") return base.child(div().flex_1().min_w(0).truncate().pl(92).italic().text_color(o.dim).child(r.text));
  const sign = r.kind === "add" ? ["+", o.review, tint(o.review, 0.12)] : r.kind === "del" ? ["-", o.fix, tint(o.fix, 0.12)] : [" ", o.dim, null];
  return base.when(!on && Boolean(sign[2]), (el) => el.bg(sign[2]))
    .child(num(r.old)).child(num(r.new))
    .child(div().flex_none().w(10).text_color(sign[1]).child(sign[0]))
    .child(div().flex_1().min_w(0).truncate().text_color(o.fg).child(r.text || " "))
    .when(drafted, (el) => el.child(draftMark(o)));
}

// A thread's first line: where it is, its state, who, how many; folded,
// the start of its first comment too.
function threadHead(o, it, on, drafted) {
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
    .when(drafted, (el) => el.child(draftMark(o)))
    .child(div().flex_none().text_size(12).font_medium().text_color(o.fg).child(first?.author ?? ""))
    .child(div().flex_none().text_size(11.5).text_color(o.dim).child(n === 1 ? "1 comment" : `${n} comments`))
    .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(o.dim)
      .child(it.folded ? (first?.body ?? "").split("\n").find((l) => l.trim()) ?? "" : ""))
    .when(on, (el) => el.child(div().flex_none().text_size(11).text_color(o.dim).child(it.folded ? "enter unfolds" : "enter folds")));
}

// What an outdated thread was about: the end of its hunk.
function hunk(o, it) {
  return v_flex().flex_1().min_w(0).ml(INDENT).mr(12).px(10).py(5).bg(o.sunk).border_l_1().border_r_1().border_color(o.line)
    .when(it.last, (el) => el.border_b_1().rounded_b(8).mb(6))
    .font_family(MONO).text_size(11)
    .children(it.lines.map((l) => h_flex().h(18).gap(6).items_center()
      .when(l.kind !== "ctx", (el) => el.bg(tint(l.kind === "add" ? o.review : o.fix, 0.12)))
      .child(div().flex_none().w(10).text_color(l.kind === "add" ? o.review : l.kind === "del" ? o.fix : o.dim).child(l.kind === "add" ? "+" : l.kind === "del" ? "-" : " "))
      .child(div().flex_1().min_w(0).truncate().text_color(o.muted).child(l.text))));
}

// A piece of a comment: its author and age first, then its Markdown.
function comment(o, it, on) {
  const c = it.c;
  return v_flex().flex_1().min_w(0).ml(INDENT).mr(12).px(12).pt(it.first ? 6 : 0).pb(8).gap(4).overflow_hidden()
    .bg(on ? tint(o.accent, 0.08) : o.raised).border_l_1().border_r_1().border_color(o.line)
    .when(it.last, (el) => el.border_b_1().rounded_b(8).mb(6))
    .when(it.first, (el) => el.child(h_flex().flex_none().h(18).gap(8).items_center()
      .child(div().text_size(12).font_semibold().text_color(o.fg).child(c.author || "someone"))
      .child(div().text_size(11.5).text_color(o.dim).child(ago(c.created)))
      .when(c.state === "pending", (el) => el.child(chip(o, `cp-${c.id}`, ["pending, not sent"], { color: o.accent })))))
    .when(Boolean(it.text), (el) => el.child(markdown(o, it)));
}

// A comment's Markdown, as the PR screen draws its description; its plain
// text when Markdown can't be drawn here.
function markdown(o, it) {
  try {
    return TextView.markdown(`md-${it.key}`, it.text).text_size(12.5).text_color(o.muted);
  } catch {
    return div().text_size(12.5).text_color(o.muted).child(it.text);
  }
}
