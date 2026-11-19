// What a key does on the Files tab once review actions are in: who has the
// keyboard first, then what the cursor is on. No imports, so node can run
// its rules.
//
//   key ──► typing? (the filter) ─────────────────► the text box's
//           held, and not a move? ────────────────► nothing
//           review key (x) ──► allowed here? ─────► do it, or say why not
//           anything else ────────────────────────► the view's moves

// The keys a held key repeats. Anything else held does nothing: a repeat
// comes faster than anyone sees what it did (v, enter, r, o, x).
export const MOVES = new Set(["j", "k", "down", "up", "]", "[", "n", "p"]);

// The keys that act on the PR's review. They're decided here before the
// view checks its own state, so each can say why it can't act.
export const REVIEW_KEYS = new Set(["x"]);

export const OLD_BINARY = "This needs a newer herdr-github.";

/**
 * Where a key goes.
 * @param {{ keyboard: "view" | "filter" }} h who has the keyboard
 * @param {string} k
 * @param {boolean} held a repeat
 * @returns {"type" | "swallow" | "review" | "view"}
 */
export function route(h, k, held) {
  if (h.keyboard !== "view") return "type";
  if (held && !MOVES.has(k)) return "swallow";
  if (REVIEW_KEYS.has(k)) return "review";
  return "view";
}

/**
 * What a review key does where the cursor is, or why it can't.
 * @param {string} k
 * @param {{ state: string, follows: boolean, item: any }} c
 *   state: the view's (ok, loading, old, error); follows: the binary can
 *   take review actions; item: the cursor's item (diffitems.js), if any.
 * @returns {{ act: "resolve", thread: any, to: boolean } | { say: string }}
 */
export function reviewAction(k, c) {
  if (c.state === "old") return { say: OLD_BINARY };
  if (c.state !== "ok") return { say: "Still loading the PR's files." };
  if (!c.follows) return { say: OLD_BINARY };
  const t = c.item?.t ?? null;
  if (k === "x") {
    if (!t) return { say: "x resolves a thread: put the cursor on one." };
    if (t.local) return { say: "That comment's thread is still being read back from GitHub." };
    if (t.resolved && !t.canUnresolve) return { say: "You can't unresolve this thread." };
    if (!t.resolved && !t.canResolve) {
      const pendingOnly = t.comments.length > 0 && t.comments.every((x) => x.state === "pending");
      return { say: pendingOnly ? "A thread with only pending comments can't be resolved until your review is sent." : "You can't resolve this thread." };
    }
    return { act: "resolve", thread: t, to: !t.resolved };
  }
  return { say: "" };
}
