// The composer: writing a comment, a reply or an edit, and sending it once.
// No imports, so node can run its rules; the view (files.js) does what it
// says, and keeps the draft (drafts.js).
//
//            cmd-enter                ok
//   editing ──────────► sending ─────────────────────────────────► done
//     ▲   ▲                │ refused: editable, GitHub's words
//     │   └────────────────┤
//     │                    │ unknown
//     │                    ▼          a poll after the send ended
//     │                 checking ─── has a new comment of yours, ──► done
//     │                    │          same target, same text
//     │                    │ 60 s (from the binary's deadline, when reopened)
//     │                    ▼
//     │   unconfirmed editing ── cmd-enter ──► again ── cmd-enter ──► sending
//     └────────────────────────────────── esc ◄─┘
//
// A draft found in the `sending` or `unknown` state (the popup closed or the
// app quit mid-send) opens in `checking`. The send it records may still be
// on its way (the binary's deadline is BINARY_MS), so its 60 s of checking
// start from there.

export const CHECK_MS = 60000;
export const CHECK_POLL_MS = 5000;
export const BINARY_MS = 20000;
// Two deliveries of one press (the textarea's submit and the key itself)
// come closer together than this.
export const SAME_PRESS_MS = 150;
// The textarea's submit has no held flag: a submit this soon after the last
// press is taken for its repeat.
export const REPEAT_MS = 1000;

const norm = (s) => String(s ?? "").replace(/\r\n/g, "\n").trim();

/** Whether two bodies are the same, as GitHub keeps them (Verify 8). */
export const sameBody = (a, b) => norm(a) === norm(b);

/**
 * The comments on a draft's target: its thread's (a reply), or every
 * thread's on its path, side and line (a new comment).
 * @param {import("./drafts.js").Target} target
 * @param {any[]} threads
 */
export function commentsOn(target, threads) {
  const on = target.kind === "reply" ? threads.filter((t) => t.id === target.thread)
    : target.kind === "comment" ? threads.filter((t) => t.subject !== "file" && t.path === target.path && t.side === target.side && t.line === target.line)
    : [];
  return on.flatMap((t) => t.comments);
}

/** The viewer's comment ids on the target, kept with a send (A2). */
export function idsOn(target, threads) {
  return commentsOn(target, threads).filter((c) => c.mine).map((c) => c.id);
}

/**
 * Whether threads show a send went through: a comment of the viewer's on
 * the target that wasn't there before it, with the text sent; for an edit,
 * the comment with the text sent.
 * @param {import("./drafts.js").Target} target
 * @param {import("./drafts.js").SendState} send
 * @param {any[]} threads
 */
export function found(target, send, threads) {
  if (target.kind === "edit") return threads.some((t) => t.comments.some((c) => c.id === target.comment && sameBody(c.body, send.body)));
  const before = new Set(send.ids);
  return commentsOn(target, threads).some((c) => c.mine && !before.has(c.id) && sameBody(c.body, send.body));
}

/**
 * Whether a draft holds text typed after the send that was just found (a
 * send after "Could not confirm" is checked with the draft still open to
 * typing): then that text is kept as the draft, and only the send is let go.
 * @param {import("./drafts.js").Draft | null} draft
 * @param {import("./drafts.js").SendState} send
 */
export function typedSince(draft, send) {
  return Boolean(draft) && draft.body.trim() !== "" && !sameBody(draft.body, send.body);
}

/**
 * The request that sends a draft's text. A new comment goes on `head`, the
 * head the diff is loaded at now (A9).
 * @param {import("./drafts.js").Target} target
 * @param {string} body
 * @param {string} head
 */
export function request(target, body, head) {
  if (target.kind === "comment") return { op: "act", do: "comment", head, path: target.path, line: target.line, side: target.side === "left" ? "LEFT" : "RIGHT", body };
  if (target.kind === "reply") return { op: "act", do: "reply", thread: target.thread, body };
  return { op: "act", do: "edit", comment: target.comment, body };
}

const at = (t) => (t.line > 0 ? `${t.path} line ${t.line}` : t.path);

/**
 * The one line above the composer: what it's for.
 * @param {import("./drafts.js").Target} t
 */
export function purpose(t) {
  if (t.kind === "comment") return `Comment on ${at(t)} (${t.side === "left" ? "old" : "new"} side), pending`;
  if (t.kind === "reply") return `Reply to ${t.author || "the thread"} on ${at(t)}, pending`;
  return t.published ? `Edit your published comment on ${at(t)}. Changes show at once.` : `Edit your pending comment on ${at(t)}`;
}

export const NOTES = {
  sending: "Sending…",
  unknown: "No answer from GitHub. It may have been sent. Checking…",
  reopened: "This may have been sent. Checking…",
  notYet: "Not found yet. Still checking.",
  unconfirmed: "Could not confirm. Sending again may post it twice.",
  again: "Send again? cmd-enter again sends, esc keeps the draft.",
};

export class Composer {
  /**
   * @param {import("./drafts.js").Target} target
   * @param {import("./drafts.js").Draft | null} draft its draft, if it has one
   * @param {number} now
   */
  constructor(target, draft, now) {
    this.target = target;
    /** @type {"editing" | "again" | "sending" | "checking" | "done"} */
    this.phase = "editing";
    this.note = "";
    this.unconfirmed = false; // a send's outcome is still unknown: sending again asks first
    this.lastPress = -Infinity;
    /** @type {import("./drafts.js").SendState | null} */
    this.send = null;
    /** @type {{ from: number, after: number, until: number } | null} */
    this.check = null;
    if (draft?.send) {
      this.send = draft.send;
      // Polls from now on can find it; it's "not found yet" only once the
      // binary's deadline has passed.
      this.checking(now, Math.max(now, draft.send.since + BINARY_MS), NOTES.reopened);
    }
  }

  checking(from, after, note) {
    this.phase = "checking";
    this.note = note;
    this.check = { from, after, until: after + CHECK_MS };
  }

  /** Whether the text box takes typing. */
  editable() {
    return this.phase === "editing";
  }

  /**
   * cmd-enter, from the textarea's submit (held unknown: null) or a key
   * (held known). "send": send it now (then call sending); "ask": the
   * second-confirm prompt is up; null: nothing (a repeat, a second
   * delivery of one press, or not now).
   * @param {number} now
   * @param {boolean | null} held
   * @returns {"send" | "ask" | null}
   */
  press(now, held) {
    const gap = now - this.lastPress;
    this.lastPress = now;
    if (held === true || gap < SAME_PRESS_MS || (held === null && gap < REPEAT_MS)) return null;
    if (this.phase === "again") return "send";
    if (this.phase !== "editing") return null;
    if (this.unconfirmed) {
      this.phase = "again";
      this.note = NOTES.again;
      return "ask";
    }
    return "send";
  }

  /** esc while asking "Send again?": back to the draft, still unconfirmed. */
  keep() {
    if (this.phase !== "again") return;
    this.phase = "editing";
    this.note = NOTES.unconfirmed;
  }

  /** The send went out, with what it recorded (the draft has it too). */
  sending(send) {
    this.phase = "sending";
    this.note = NOTES.sending;
    this.send = send;
  }

  /**
   * How the send ended (mutation.js's outcome kinds). A refusal of a send
   * made after "Could not confirm" says nothing of the earlier one, so the
   * next send still asks first.
   * @param {"ok" | "refused" | "unknown"} kind
   * @param {string} error GitHub's words, when refused
   * @param {number} now
   */
  outcome(kind, error, now) {
    if (kind === "ok") {
      this.unconfirmed = false;
      this.phase = "done";
      this.note = "";
    } else if (kind === "refused") {
      this.phase = "editing";
      this.note = error;
      this.send = null;
    } else {
      this.checking(now, now, NOTES.unknown);
    }
  }

  /**
   * A poll's threads, and when that poll started. "sent": found, it went
   * through; "waiting": still checking; null: not checking, or the poll is
   * older than the send's end.
   * @param {any[]} threads
   * @param {number} startedAt
   * @returns {"sent" | "waiting" | null}
   */
  poll(threads, startedAt) {
    if (this.phase !== "checking" || !this.check || startedAt < this.check.from) return null;
    if (found(this.target, this.send, threads)) {
      this.phase = "done";
      this.note = "";
      return "sent";
    }
    if (startedAt >= this.check.after) this.note = NOTES.notYet;
    return "waiting";
  }

  /**
   * The check's clock. "unconfirmed": 60 s passed without finding it
   * (polls that failed find nothing either); the box is editable again,
   * and sending asks first.
   * @param {number} now
   * @returns {"unconfirmed" | null}
   */
  tick(now) {
    if (this.phase !== "checking" || !this.check || now < this.check.until) return null;
    this.phase = "editing";
    this.unconfirmed = true;
    this.note = NOTES.unconfirmed;
    this.check = null;
    return "unconfirmed";
  }
}
