// What a key does on the Files tab once review actions are in: who has the
// keyboard first, then what's asked (a confirm), then what the cursor is
// on. No imports, so node can run its rules.
//
//   key ──► the submit dialog open? ────────► the dialog's, every one (tab,
//           │                                1 2 3 too); in its body box
//           │                                only tab and cmd-enter
//           a text box has the keyboard? ──► the filter's, or the
//           │                                composer's (cmd-enter sends,
//           │                                tab does nothing, the rest types)
//           held, and not a move? ──────────► nothing
//           a delete to confirm? ───────────► y deletes, anything else keeps
//           "Send again?" asked? ───────────► cmd-enter sends, anything else keeps
//           cmd-enter, the composer open ───► send
//           review key (c x e shift-d shift-s) ► allowed here? do it, or say why
//           anything else ──────────────────► the view's moves
//
// Typing comes first (spec A5): an x typed in the composer is an x, never a
// resolve; a held key never sends, deletes or confirms.

// The keys a held key repeats. Anything else held does nothing: a repeat
// comes faster than anyone sees what it did (v, enter, r, o, x, y).
export const MOVES = new Set(["j", "k", "down", "up", "]", "[", "n", "p"]);

// The keys that act on the PR's review. They're decided here before the
// view checks its own state, so each can say why it can't act.
export const REVIEW_KEYS = new Set(["c", "x", "e", "shift-d", "shift-s"]);

const TABS = new Set(["tab", "shift-tab"]);

export const OLD_BINARY = "This needs a newer herdr-github.";
export const NEW_COMMITS = "New commits pushed. r reloads.";
export const OLDER_COMMIT = "Your pending review was started on an older commit. Submit or discard it to comment on the new one.";

/**
 * @typedef {{ keyboard: "view" | "filter" | "composer" | "body", dialog?: boolean, composer?: boolean, confirm?: boolean, again?: boolean }} Holder
 *   keyboard: who has it ("body": the submit dialog's text box); dialog:
 *   the submit dialog is open; composer: one is open (focused or not);
 *   confirm: a delete waits for y; again: "Send again?" is asked.
 */

/**
 * Where a key goes.
 * @param {Holder} h
 * @param {string} k
 * @param {boolean} held a repeat
 * @returns {"dialog" | "type" | "send" | "swallow" | "confirm" | "again" | "review" | "view"}
 */
export function route(h, k, held) {
  if (h.dialog) {
    if (h.keyboard !== "body") return "dialog";
    return k === "cmd-enter" ? "send" : TABS.has(k) ? "dialog" : "type";
  }
  if (h.keyboard === "composer") return k === "cmd-enter" ? "send" : TABS.has(k) ? "swallow" : "type";
  if (h.keyboard !== "view") return "type";
  if (held && !MOVES.has(k)) return "swallow";
  if (h.confirm) return "confirm";
  if (h.again) return "again";
  if (h.composer && k === "cmd-enter") return "send";
  if (REVIEW_KEYS.has(k)) return "review";
  return "view";
}

/**
 * The viewer's latest comment in a thread: what e and shift-d act on.
 * @param {{ comments: any[] }} t
 */
export function latestMine(t) {
  for (let i = t.comments.length - 1; i >= 0; i--) if (t.comments[i].mine) return t.comments[i];
  return null;
}

/**
 * @typedef {{ act: "resolve", thread: any, to: boolean }
 *   | { act: "comment", row: any }
 *   | { act: "reply", thread: any }
 *   | { act: "edit", thread: any, comment: any }
 *   | { act: "delete", thread: any, comment: any }
 *   | { act: "submit" }
 *   | { say: string }} Action
 */

/**
 * What a review key does where the cursor is, or why it can't.
 * @param {string} k
 * @param {{ state: string, follows: boolean, item: any, behind?: boolean, head?: string,
 *   review?: { commit: string } | null, diff?: string }} c
 *   state: the view's (ok, loading, old, error); follows: the binary can
 *   take review actions; item: the cursor's item (diffitems.js), if any;
 *   behind: GitHub has a newer head than the one shown; diff: the open
 *   file's diff state.
 * @returns {Action}
 */
export function reviewAction(k, c) {
  if (c.state === "old") return { say: OLD_BINARY };
  if (c.state !== "ok") return { say: "Still loading the PR's files." };
  if (!c.follows) return { say: OLD_BINARY };
  const it = c.item ?? null;
  const t = it?.t ?? null;
  if (k === "shift-s") return { act: "submit" };
  if (t?.local) return { say: "That comment's thread is still being read back from GitHub." };
  if (k === "x") {
    if (!t) return { say: "x resolves a thread: put the cursor on one." };
    if (t.resolved && !t.canUnresolve) return { say: "You can't unresolve this thread." };
    if (!t.resolved && !t.canResolve) {
      const pendingOnly = t.comments.length > 0 && t.comments.every((x) => x.state === "pending");
      return { say: pendingOnly ? "A thread with only pending comments can't be resolved until your review is sent." : "You can't resolve this thread." };
    }
    return { act: "resolve", thread: t, to: !t.resolved };
  }
  if (k === "c") {
    if (t) return t.canReply ? { act: "reply", thread: t } : { say: "You can't reply in this thread." };
    if (it?.kind !== "row") return { say: c.diff && c.diff !== "ok" ? "This file has no diff lines to comment on." : "c comments on a line: put the cursor on one." };
    const kind = it.row.kind;
    if (kind !== "add" && kind !== "del" && kind !== "ctx") return { say: kind === "hunk" ? "c comments on a line, not on a hunk's header." : "c comments on a line of the diff." };
    if (c.behind) return { say: NEW_COMMITS };
    if (c.review && c.review.commit && c.review.commit !== c.head) return { say: OLDER_COMMIT };
    return { act: "comment", row: it.row };
  }
  if (k === "e" || k === "shift-d") {
    const verb = k === "e" ? "edit" : "delete";
    if (!t) return { say: `${k} ${k === "e" ? "edits" : "deletes"} your latest comment in a thread: put the cursor on one.` };
    const m = latestMine(t);
    if (!m) return { say: "You have no comment in this thread." };
    if (!(k === "e" ? m.canEdit : m.canDelete)) return { say: `GitHub doesn't let you ${verb} that comment.` };
    if (k === "e" && m.state === "pending" && c.behind) return { say: NEW_COMMITS };
    return k === "e" ? { act: "edit", thread: t, comment: m } : { act: "delete", thread: t, comment: m };
  }
  return { say: "" };
}

/**
 * The delete confirm's prompt, in the footer.
 * @param {{ state: string }} comment
 */
export function deletePrompt(comment) {
  return comment.state === "pending"
    ? "Delete your pending comment? y deletes, any other key keeps it."
    : "Delete your published comment? Others will see it gone. y deletes, any other key keeps it.";
}

/**
 * Whether an outcome that came by itself (a send's answer, a poll) may move
 * the keyboard: only from the tab's own keys or the composer. Typing in the
 * filter, the dialog, or a delete waiting for y keep it (rule 5); the
 * outcome then changes only what's shown.
 * @param {{ keyboard: string, dialog: boolean, confirm: boolean }} h holder(), when the outcome came
 */
export function mayMoveKeyboard(h) {
  return !h.dialog && !h.confirm && (h.keyboard === "view" || h.keyboard === "composer");
}
