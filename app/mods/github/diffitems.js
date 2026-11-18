// One file's diff as the Files tab lists it: its rows, and its review threads
// between them, each item with the height it's drawn at. No imports, so it
// can be run on its own.
//
// The diff is a virtual list, which places items by heights it's told up
// front; only it can bring the cursor's item into sight. A row is one line.
// A thread is a header line, then (unless folded) each comment in pieces of
// at most a screenful, so j and k read a long comment a piece at a time and
// a wrong guess at a piece's height stays small. Markdown can't be measured
// before it's drawn, so its height is guessed from the width, generously:
// too tall leaves a gap, too short would cut a line off.
//
//   threads with no row to sit on (a file's, an outdated one, no diff)
//   hunk  @@ -138,6 +138,10 @@
//   row   140      - // Last write wins.
//   row        142 + timeout: .seconds(20))
//   thread  ● line 142 · jonas · 2 comments        (after the row it names)
//   comment jonas · 2h ago / the body, as Markdown
//   comment sam · 1h ago / …
//   row        143 + let merged = …

export const ROW_H = 20;
export const THREAD_H = 30;
const HUNK_LINE_H = 18;
const AUTHOR_H = 22;
const LINE_H = 20;
const CODE_H = 18;
const PARA_GAP = 8;
const PAD = 14;
// A comment is cut into pieces no taller than this (a block never splits).
const PIECE_MAX = 220;
// An average character at the comments' size, a little wide on purpose.
const CHAR_W = 7;
// What a comment's text loses of the list's width: the cursor's bar, the
// thread's indent and margin, its padding.
export const THREAD_INSET = 72;

// Where a thread is: "line 142", "lines 12-14", "file", "was line 31".
export function threadWhere(t) {
  const old = t.side === "left" ? " (old)" : "";
  if (t.subject === "file") return "file";
  if (t.line > 0) return t.startLine > 0 && t.startLine !== t.line ? `lines ${t.startLine}-${t.line}${old}` : `line ${t.line}${old}`;
  if (t.originalLine > 0) return `was line ${t.originalLine}`;
  return "";
}

// Each thread after the row it names (`left` is a row's `old` line, `right`
// its `new`), and those that name none (a file's, no line, no such row).
export function placeThreads(rows, threads) {
  const at = new Map();
  rows.forEach((r, i) => {
    if (r.old > 0) at.set(`left:${r.old}`, i);
    if (r.new > 0) at.set(`right:${r.new}`, i);
  });
  const after = new Map();
  const loose = [];
  for (const t of threads) {
    const i = t.subject === "line" && t.line > 0 ? at.get(`${t.side}:${t.line}`) : undefined;
    if (i === undefined) loose.push(t);
    else after.set(i, [...(after.get(i) ?? []), t]);
  }
  return { after, loose };
}

const FENCE = /^\s*(```|~~~)/;

// How tall a block of Markdown draws at `width`, roughly and never short.
export function textHeight(text, width) {
  let h = 0;
  let fence = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      fence = !fence;
      h += PARA_GAP;
      continue;
    }
    if (fence) {
      h += CODE_H * Math.max(1, Math.ceil((line.length * CHAR_W) / Math.max(80, width - 16)));
      continue;
    }
    if (!line.trim()) {
      h += PARA_GAP;
      continue;
    }
    const indent = /^\s*([-*+]|\d+[.)]|>)\s/.test(line) ? 24 : 0;
    // A link draws its words, not its address.
    const shown = line.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const n = Math.max(1, Math.ceil((shown.length * CHAR_W) / Math.max(80, width - indent)));
    h += n * (/^#{1,6}\s/.test(line) ? LINE_H * 1.4 : LINE_H);
  }
  return h;
}

// A comment's body in pieces of whole blocks (paragraphs, lists, code), each
// at most PIECE_MAX tall unless one block alone is taller.
export function pieces(body, width) {
  const blocks = [];
  let cur = [];
  let fence = false;
  for (const line of body.split("\n")) {
    if (FENCE.test(line)) fence = !fence;
    if (!fence && !line.trim()) {
      if (cur.length) blocks.push(cur.join("\n"));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  if (cur.length) blocks.push(cur.join("\n"));
  const out = [];
  let acc = [];
  let h = 0;
  for (const b of blocks) {
    const bh = textHeight(b, width);
    if (acc.length && h + bh > PIECE_MAX) {
      out.push({ text: acc.join("\n\n"), h });
      acc = [];
      h = 0;
    }
    acc.push(b);
    h += (acc.length > 1 ? PARA_GAP : 0) + bh;
  }
  if (acc.length || !out.length) out.push({ text: acc.join("\n\n"), h });
  return out;
}

// Text draws a tab as nothing: each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t\n]*\t/g, (s) => s.slice(0, -1).padEnd(s.length - 1 - ((s.length - 1) % 4) + 4));

// What an outdated thread was about: the end of its hunk (as GitHub shows).
export function hunkTail(hunk) {
  return hunk.split("\n").filter((l) => !l.startsWith("@@")).slice(-4).map((l) => ({
    kind: l[0] === "+" ? "add" : l[0] === "-" ? "del" : "ctx",
    text: untab(l.slice(1)) || " ",
  }));
}

// The list's items for one file: `rows` (the diff's, or [] when it has
// none), `threads` (the file's), `folded(t)`, and the list's width.
// Every item has a unique `key`, its height `h`, and `t` when it's part of
// a thread.
export function diffItems({ rows, threads, folded, width }) {
  const textW = Math.max(160, width - THREAD_INSET);
  const items = [];
  const keys = new Set();
  const push = (it) => {
    let key = it.key;
    for (let n = 2; keys.has(key); n++) key = `${it.key}#${n}`;
    keys.add(key);
    items.push({ ...it, key });
  };
  const thread = (t, loose) => {
    const fold = folded(t);
    const hunk = loose && t.hunk ? hunkTail(t.hunk) : [];
    push({ kind: "thread", key: `t:${t.id}`, h: THREAD_H, t, folded: fold, last: fold || (!hunk.length && !t.comments.length) });
    if (fold) return;
    if (hunk.length) push({ kind: "hunk", key: `h:${t.id}`, h: hunk.length * HUNK_LINE_H + 10 + (t.comments.length ? 0 : 6), t, lines: hunk, last: !t.comments.length });
    t.comments.forEach((c, ci) => {
      const ps = pieces(c.body ?? "", textW);
      ps.forEach((p, pi) => {
        const first = pi === 0;
        const last = ci === t.comments.length - 1 && pi === ps.length - 1;
        const h = Math.ceil((first ? AUTHOR_H : 0) + p.h * 1.15 + PAD + (last ? 6 : 0));
        push({ kind: "comment", key: `c:${c.id}:${pi}`, h, t, c, text: p.text, first, last });
      });
    });
  };
  const { after, loose } = placeThreads(rows, threads);
  for (const t of loose) thread(t, true);
  rows.forEach((row, i) => {
    push({ kind: "row", key: `r${i}`, h: ROW_H, row });
    for (const t of after.get(i) ?? []) thread(t, false);
  });
  return items;
}
