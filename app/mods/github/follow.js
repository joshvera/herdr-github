// Following an open PR: a `threads` answer merged into what the Files tab
// shows, without moving anything the person is looking at. No imports, so
// node can run its rules.
//
//   answer for the same head ──► threads by id: new ones in, changed ones in
//                                place, missing ones out (kept when `more`,
//                                or while held: just sent, not yet read back)
//   answer for another head ──► nothing positional; only the review chip
//
// The cursor and the scroll position are item keys (diffitems.js): `r<i>`
// for the diff's i-th row, `t:<id>` a thread's header, `c:<id>:<n>` a piece
// of a comment, `h:<id>` an outdated thread's hunk. Rows don't change within
// one head, so a row's key finds the same row after any merge.

// How long a thread or comment merged from a send's own answer is kept when
// a poll doesn't have it yet (spec A4).
export const HOLD_MS = 60000;

const commentIds = (t) => (t.comments ?? []).map((c) => c.id);

/**
 * Merges a `threads` answer (same head) into the threads shown.
 * @param {any[]} prev the threads shown now
 * @param {{ threads?: any[], more?: boolean }} answer
 * @param {Map<string, number>} held id (thread or comment) → until when it's kept
 * @param {number} now
 * @returns {{ threads: any[], held: Map<string, number> }}
 */
export function mergeThreads(prev, answer, held, now) {
  const incoming = answer.threads ?? [];
  const seen = new Set();
  for (const t of incoming) {
    seen.add(t.id);
    for (const id of commentIds(t)) seen.add(id);
  }
  // What a poll has shown, or what has waited long enough, is let go.
  const keep = new Map([...held].filter(([id, until]) => !seen.has(id) && until > now));
  const before = new Map(prev.map((t) => [t.id, t]));
  const threads = incoming.map((t) => {
    const old = before.get(t.id);
    const waiting = (old?.comments ?? []).filter((c) => keep.has(c.id));
    return waiting.length ? { ...t, comments: [...t.comments, ...waiting] } : t;
  });
  const kept = prev.filter((t) => !seen.has(t.id)).flatMap((t) => {
    if (answer.more) return [t];
    if (!keep.has(t.id)) return [];
    // A thread just sent: only its comments still held (one deleted since
    // isn't drawn back), or nothing when none is.
    const comments = t.comments.filter((c) => keep.has(c.id));
    if (!comments.length) return [];
    return comments.length === t.comments.length ? [t] : [{ ...t, comments }];
  });
  return { threads: byPath([...threads, ...kept]), held: keep };
}

// Threads in path order, each path's in the order they came: the order
// `files` gives them, which the tree and n/p step through.
function byPath(threads) {
  return threads
    .map((t, i) => ({ t, i }))
    .sort((a, b) => (a.t.path < b.t.path ? -1 : a.t.path > b.t.path ? 1 : a.i - b.i))
    .map((x) => x.t);
}

/**
 * Each file's thread counts from the threads shown (the binary tallies them
 * only for `files`).
 * @param {any[]} files
 * @param {any[]} threads
 */
export function countThreads(files, threads) {
  const n = new Map();
  for (const t of threads) {
    const c = n.get(t.path) ?? { threads: 0, open: 0 };
    c.threads++;
    if (!t.resolved) c.open++;
    n.set(t.path, c);
  }
  return files.map((f) => {
    const c = n.get(f.path) ?? { threads: 0, open: 0 };
    return c.threads === f.threads && c.open === f.open ? f : { ...f, ...c };
  });
}

/**
 * Where an item of the old list is in the new one: the same key, else the
 * diff row the thread sat under (the nearest row above it in the old list),
 * else the first item.
 * @param {{ key: string }[]} oldItems
 * @param {{ key: string }[]} newItems
 * @param {number} at index into oldItems
 */
export function refind(oldItems, newItems, at) {
  const index = new Map(newItems.map((it, i) => [it.key, i]));
  const from = Math.min(at, oldItems.length - 1);
  if (from < 0) return 0;
  const same = index.get(oldItems[from].key);
  if (same !== undefined) return same;
  // Gone: the row it sat under, never a neighbouring thread's comment.
  for (let i = from - 1; i >= 0; i--) {
    if (!oldItems[i].key.startsWith("r")) continue;
    const j = index.get(oldItems[i].key);
    if (j !== undefined) return j;
  }
  return 0;
}

/**
 * Whether anything before `at` (old) changed key or height: only then does a
 * merge move what's on screen, and the scroll is put back.
 */
export function shiftedAbove(oldItems, newItems, at) {
  if (at <= 0) return false;
  const j = refind(oldItems, newItems, at);
  if (j !== at) return true;
  for (let i = 0; i < at; i++) {
    if (oldItems[i].key !== newItems[i]?.key || oldItems[i].h !== newItems[i]?.h) return true;
  }
  return false;
}

/**
 * The review chip's words, or "" when there's no pending review.
 * @param {{ comments: number } | null} review
 * @param {boolean} more
 */
export function reviewChip(review, more) {
  if (!review) return "";
  const n = review.comments;
  return `Review pending: ${n} comment${n === 1 ? "" : "s"}${more ? " (or more)" : ""}`;
}

/**
 * Failed polls: nothing shown until three in a row; then one line until a
 * poll succeeds.
 */
export class PollHealth {
  constructor() {
    this.fails = 0;
    this.error = "";
  }
  ok() {
    this.fails = 0;
    this.error = "";
  }
  failed(error) {
    this.fails++;
    if (this.fails >= 3) this.error = error;
  }
}

/**
 * The pending review and the viewer's latest submitted review a `files` or
 * `threads` answer says. Either left out (a partial answer: GitHub didn't
 * say) keeps what was known; only null says there's none. Read as none, an
 * unanswered review would be "gone", and so "submitted".
 * @param {{ review?: any, submitted?: any }} res
 * @param {{ review: any, submitted: any }} prev
 */
export function reviewsOf(res, prev) {
  return {
    review: "review" in res ? res.review ?? null : prev.review,
    submitted: "submitted" in res ? res.submitted ?? null : prev.submitted,
  };
}

/**
 * A `threads` answer (or a `files` one for the same head, after r) merged
 * into what's shown: threads by mergeThreads, an edit just saved shown with
 * its new text until a poll has it or HOLD_MS pass (as A4 holds a comment),
 * and `more` as this answer says it (it isn't sticky: once every thread is
 * there, it's false).
 * @param {{ threads: any[], held: Map<string, number>, edited: Map<string, { body: string, until: number }>, more?: boolean }} shown
 * @param {{ threads?: any[], more?: boolean }} answer
 * @param {number} now
 * @returns {{ threads: any[], held: Map<string, number>, edited: Map<string, { body: string, until: number }>, more: boolean }}
 */
export function applyPoll(shown, answer, now) {
  const { threads, held } = mergeThreads(shown.threads, answer, shown.held, now);
  const edited = new Map([...shown.edited].filter(([, e]) => e.until > now));
  const shownEdits = threads.map((t) => {
    if (!t.comments.some((c) => edited.has(c.id))) return t;
    return {
      ...t,
      comments: t.comments.map((c) => {
        const e = edited.get(c.id);
        if (!e) return c;
        if (c.body === e.body) {
          edited.delete(c.id); // read back: GitHub's word from here
          return c;
        }
        return { ...c, body: e.body };
      }),
    };
  });
  return { threads: shownEdits, held, edited, more: Boolean(answer.more) };
}
