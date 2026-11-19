// What a change sent from the Files tab does to the threads shown, before a
// poll reads it back. No imports, so node can run its rules.
//
// Every function here returns new threads and leaves the old ones alone: the
// view's items are rebuilt when its data changes identity (files.js), and an
// edit in place would draw nothing new.
//
//   x ─────────► withResolved   (at once; put back if GitHub says no)
//   c (ok) ─────► withComment    (the answer's thread, or one made up from
//                                 its comment when GitHub sent none: A7)
//   c reply (ok)► withReply
//   e (ok) ─────► withEdit
//   shift-d (ok)► withoutComment
//   discard (ok)► withoutPending

const swap = (threads, id, fn) => threads.map((t) => (t.id === id ? fn(t) : t));

/**
 * The thread `id` resolved or not, and what the viewer may do to it next.
 * @param {any[]} threads
 * @param {string} id
 * @param {boolean} resolved
 */
export function withResolved(threads, id, resolved) {
  return swap(threads, id, (t) => ({ ...t, resolved, canResolve: !resolved, canUnresolve: resolved }));
}

/**
 * A new thread from a `comment` answer. GitHub answers no thread when the
 * comment started the pending review (A7): then a stand-in holds the
 * comment where it was asked for, under the comment's own id, so the poll
 * that brings the real thread (which has that comment) lets it go.
 * @param {any[]} threads
 * @param {{ thread?: any, comment: any }} answer
 * @param {{ path: string, side: string, line: number }} at
 */
export function withComment(threads, answer, at) {
  const t = answer.thread ?? {
    id: answer.comment.id, path: at.path, subject: "line", line: at.line, side: at.side,
    startLine: 0, startSide: "", originalLine: at.line, hunk: "", resolved: false, outdated: false,
    comments: [answer.comment], canReply: false, canResolve: false, canUnresolve: false, local: true,
  };
  return [...threads.filter((x) => x.id !== t.id), t];
}

/** A reply added to its thread (once, however often it's merged). */
export function withReply(threads, threadId, comment) {
  return swap(threads, threadId, (t) => (t.comments.some((c) => c.id === comment.id) ? t : { ...t, comments: [...t.comments, comment] }));
}

/** A comment's new body, from an `edit` answer. */
export function withEdit(threads, comment) {
  return threads.map((t) => (t.comments.some((c) => c.id === comment.id)
    ? { ...t, comments: t.comments.map((c) => (c.id === comment.id ? { ...c, ...comment } : c)) }
    : t));
}

/** A comment gone, and its thread with it when it was the last. */
export function withoutComment(threads, commentId) {
  return threads
    .map((t) => (t.comments.some((c) => c.id === commentId) ? { ...t, comments: t.comments.filter((c) => c.id !== commentId) } : t))
    .filter((t) => t.comments.length > 0);
}

/** The pending review discarded: its comments gone, and threads left empty. */
export function withoutPending(threads) {
  return threads
    .map((t) => (t.comments.some((c) => c.state === "pending") ? { ...t, comments: t.comments.filter((c) => c.state !== "pending") } : t))
    .filter((t) => t.comments.length > 0);
}

// After an unknown outcome of x or shift-d, the next poll that started
// after the change ended says what happened (spec: "No answer. Checking…").
//
//   { kind: "resolve", thread, want }  the thread's resolved state now
//   { kind: "delete", comment }        whether the comment is still there

/**
 * What a poll's threads say about a change whose outcome wasn't known.
 * @param {{ kind: "resolve", thread: string, want: boolean } | { kind: "delete", comment: string }} check
 * @param {any[]} threads
 * @returns {{ text: string, err: boolean }}
 */
export function checked(check, threads) {
  if (check.kind === "resolve") {
    const t = threads.find((x) => x.id === check.thread);
    if (!t) return { text: "That thread is gone from the PR.", err: true };
    if (t.resolved === check.want) return { text: `It went through: ${check.want ? "resolved" : "unresolved"}.`, err: false };
    return { text: `It didn't go through: still ${t.resolved ? "resolved" : "unresolved"}. x tries again.`, err: true };
  }
  const there = threads.some((t) => t.comments.some((c) => c.id === check.comment));
  return there ? { text: "It didn't go through: the comment is still there. shift-d tries again.", err: true } : { text: "It went through: deleted.", err: false };
}
