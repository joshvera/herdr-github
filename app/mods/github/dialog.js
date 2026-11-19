// The submit dialog: send your review as Comment, Approve or Request
// changes, or discard it, after a second, explicit step that says what will
// happen and to how many comments. No imports, so node can run its rules;
// the view (files.js) draws it and sends what it says.
//
//   choose ── cmd-enter on a choice ─────────────────► sending ── ok ──► done
//     │  ▲                                              │ refused: stays, with
//     │  │                                              │ GitHub's words (and the
//     │  └──────────────────────────────────────────────┤ new count if it changed)
//     │  discard picked: type "discard", enter ──► sending
//     │                                                 │ unknown
//     │                                                 ▼
//     │                      checking ── a poll after the send ended shows
//     │                         │        it went through ──────────────► done
//     │                         │ 60 s without finding it
//     │                         ▼
//     └──── unconfirmed choose ── cmd-enter ──► again ── cmd-enter ──► sending
//
// The count sent is the count shown at the press; a poll may change it
// while the dialog is open (the one thing a poll may change here), and says
// so ("Now 8"). Did it go through, after an unknown outcome:
//   - with a pending review: that review is no longer pending (A6);
//   - without one: a submitted review of the viewer's that wasn't the
//     latest before the send, and submitted no earlier than the send began
//     (give or take SKEW_MS: GitHub's clock isn't this one).

export const CHOICES = [
  { id: "comment", label: "Comment", word: "comment" },
  { id: "approve", label: "Approve", word: "approve" },
  { id: "request_changes", label: "Request changes", word: "request changes" },
  { id: "discard", label: "Discard review", word: "discard" },
];

export const CHECK_MS = 60000;
export const FLASH_MS = 4000;
export const SKEW_MS = 60000;
// As the composer's (compose.js): one press arriving twice, and a submit
// from the body box (no held flag) this soon after the last press.
export const SAME_PRESS_MS = 150;
export const REPEAT_MS = 1000;

export const DIALOG_NOTES = {
  unknown: "No answer from GitHub. It may have gone through. Checking…",
  notYet: "Not found yet. Still checking.",
  unconfirmed: "Could not confirm. Sending again may send it twice.",
  again: "Send again? cmd-enter again sends, esc keeps it unsent.",
  gone: "Your pending review is no longer pending.",
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * @typedef {{ id: string, comments: number } | null} Review
 * @typedef {{ id: string, at: number } | null} Submitted
 * @typedef {{ do: "none" } | { do: "say", text: string } | { do: "focus-body" } | { do: "focus-choices" }
 *   | { do: "send", req: Record<string, unknown> }} Step
 */

const NONE = { do: "none" };

export class SubmitDialog {
  /**
   * @param {{ review: Review, mine: boolean, submitted: Submitted }} at
   *   the pending review shown, whether the PR is the viewer's, and the
   *   viewer's latest submitted review as last read
   */
  constructor({ review, mine, submitted }) {
    this.reviewId = review?.id ?? "";
    this.count = review?.comments ?? 0;
    this.mine = mine;
    /** @type {"body" | "choices"} */
    this.focus = "body";
    this.pick = "comment";
    /** @type {"choose" | "discard" | "again" | "sending" | "checking" | "done"} */
    this.phase = "choose";
    this.typed = ""; // "discard", as it's typed
    this.note = "";
    this.flash = "";
    this.flashUntil = 0;
    this.lastSubmitted = submitted?.id ?? "";
    this.unconfirmed = false;
    this.lastPress = -Infinity;
    /** @type {{ kind: "submit" | "discard", reviewId: string, count: number, at: number } | null} */
    this.sent = null;
    /** @type {{ from: number, until: number } | null} */
    this.check = null;
  }

  /** The choices offered, for the body as typed now. */
  offered(body) {
    return CHOICES.filter((c) => {
      if (c.id === "discard") return Boolean(this.reviewId);
      if (c.id === "comment") return body.trim() !== "" || this.count > 0;
      return !this.mine;
    });
  }

  /** "Your review: 7 pending comments", or "No pending comments". */
  countLine() {
    return this.count > 0 ? `Your review: ${plural(this.count, "pending comment")}` : "No pending comments";
  }

  /** What cmd-enter will do, as the button reads. */
  button(body) {
    if (this.pick === "discard") return "Discard review";
    const c = CHOICES.find((x) => x.id === this.pick);
    const offered = this.offered(body).some((x) => x.id === this.pick);
    return `Submit: ${c.word}, ${this.count > 0 ? plural(this.count, "comment") : "no comments"}${offered ? "" : " (not offered)"}`;
  }

  /** The discard step's words. */
  discardLine() {
    return `Discard your pending review and its ${plural(this.count, "comment")}? This cannot be undone. Type discard and press enter.`;
  }

  /**
   * A poll's review (and the viewer's latest submitted one), while the
   * dialog is open: the count follows it, and says so when it changes.
   * @param {Review} review
   * @param {Submitted} submitted
   * @param {number} now
   */
  follow(review, submitted, now) {
    if (this.phase === "sending" || this.phase === "checking" || this.phase === "done") return;
    if (submitted !== undefined) this.lastSubmitted = submitted?.id ?? "";
    const id = review?.id ?? "";
    const n = review?.comments ?? 0;
    if (id === this.reviewId && n === this.count) return;
    this.flash = !id ? "Your pending review is gone." : id !== this.reviewId && this.reviewId ? `Your pending review changed: now ${plural(n, "comment")}.` : `Now ${n}`;
    this.flashUntil = now + FLASH_MS;
    this.reviewId = id;
    this.count = n;
    if (this.pick === "discard" && !id) {
      this.pick = "comment";
      if (this.phase === "discard") this.cancelDiscard();
    }
  }

  /** The flash, while it lasts. */
  flashing(now) {
    return now < this.flashUntil ? this.flash : "";
  }

  cancelDiscard() {
    this.phase = "choose";
    this.typed = "";
  }

  /** esc at "Send again?": back to the choices, still unconfirmed. */
  keep() {
    if (this.phase !== "again") return;
    this.phase = "choose";
    this.note = DIALOG_NOTES.unconfirmed;
  }

  /**
   * A key while the dialog is open and its body box hasn't the keyboard
   * (tab comes here either way). It takes every key: none reaches the tab.
   * @param {string} k
   * @param {boolean} held
   * @param {string} body
   * @param {number} now
   * @returns {Step}
   */
  key(k, held, body, now) {
    if (held) return NONE;
    if (this.phase === "discard") return this.discardKey(k, now);
    if (this.phase === "again") return k === "cmd-enter" ? this.press(now, false, body) : NONE;
    if (this.phase !== "choose") return NONE;
    if (k === "tab" || k === "shift-tab") {
      this.focus = this.focus === "body" ? "choices" : "body";
      return { do: this.focus === "body" ? "focus-body" : "focus-choices" };
    }
    const offered = this.offered(body);
    if (/^[1-3]$/.test(k)) {
      const c = CHOICES[Number(k) - 1];
      if (!offered.some((x) => x.id === c.id)) return { do: "say", text: this.whyNot(c.id) };
      this.pick = c.id;
      return NONE;
    }
    if (k === "up" || k === "down" || k === "j" || k === "k") {
      const i = offered.findIndex((x) => x.id === this.pick);
      const d = k === "down" || k === "j" ? 1 : -1;
      const j = i < 0 ? 0 : Math.max(0, Math.min(offered.length - 1, i + d));
      if (offered[j]) this.pick = offered[j].id;
      return NONE;
    }
    if (k === "cmd-enter") return this.press(now, false, body);
    if (k === "enter") return this.pick === "discard" ? this.press(now, false, body) : { do: "say", text: "cmd-enter submits." };
    return NONE;
  }

  // The discard step: "discard" typed, then enter. Anything else cancels.
  discardKey(k, now) {
    if (k === "enter") {
      if (this.typed === "discard") return this.go("discard", "", now);
      this.cancelDiscard();
      return { do: "say", text: "Not discarded." };
    }
    if (k === "backspace") {
      this.typed = this.typed.slice(0, -1);
      return NONE;
    }
    if (/^[a-z]$/.test(k) && "discard".startsWith(this.typed + k)) {
      this.typed += k;
      return NONE;
    }
    this.cancelDiscard();
    return { do: "say", text: "Not discarded." };
  }

  whyNot(id) {
    if (id === "comment") return "A comment review needs some text or a pending comment.";
    if (id === "discard") return "There's no pending review to discard.";
    return "You can't approve or request changes on your own PR.";
  }

  /**
   * cmd-enter: from a key (held known) or the body box's submit (held:
   * null). Submits the choice picked, or starts the discard step.
   * @param {number} now
   * @param {boolean | null} held
   * @param {string} body
   * @returns {Step}
   */
  press(now, held, body) {
    const gap = now - this.lastPress;
    this.lastPress = now;
    if (held === true || gap < SAME_PRESS_MS || (held === null && gap < REPEAT_MS)) return NONE;
    if (this.phase === "again") return this.go("submit", body, now);
    if (this.phase !== "choose") return NONE;
    if (!this.offered(body).some((x) => x.id === this.pick)) return { do: "say", text: this.whyNot(this.pick) };
    if (this.pick === "discard") {
      this.phase = "discard";
      this.typed = "";
      this.focus = "choices";
      return { do: "focus-choices" };
    }
    if (this.unconfirmed) {
      this.phase = "again";
      this.note = DIALOG_NOTES.again;
      this.focus = "choices";
      return { do: "focus-choices" };
    }
    return this.go("submit", body, now);
  }

  // Sends: the review shown, and the count shown at this moment.
  go(kind, body, now) {
    this.sent = { kind, reviewId: this.reviewId, count: this.count, at: now };
    this.phase = "sending";
    this.note = kind === "discard" ? "Discarding…" : "Sending…";
    this.focus = "choices";
    const req = kind === "discard"
      ? { op: "act", do: "discard", reviewId: this.reviewId, count: this.count }
      : { op: "act", do: "submit", reviewId: this.reviewId, count: this.count, event: this.pick, body };
    return { do: "send", req };
  }

  /**
   * How the send ended. A refusal leaves "Could not confirm" standing: it
   * says nothing of the earlier send.
   * @param {"ok" | "refused" | "unknown"} kind
   * @param {any} answer
   * @param {string} error
   * @param {number} now
   */
  outcome(kind, answer, error, now) {
    if (kind === "ok") {
      this.unconfirmed = false;
      this.phase = "done";
      this.note = "";
      return;
    }
    if (kind === "refused") {
      this.phase = "choose";
      this.note = error;
      // The review changed since it was shown: the new count, and cmd-enter
      // again to send for it.
      if (answer?.changed === true && "review" in answer) this.follow(answer.review, undefined, now);
      return;
    }
    this.phase = "checking";
    this.note = DIALOG_NOTES.unknown;
    this.check = { from: now, until: now + CHECK_MS };
  }

  /**
   * A poll, while checking: "sent" when it shows the send went through,
   * "waiting", or null (not checking, or the poll began before the send
   * ended).
   * @param {{ review: Review, submitted?: Submitted }} answer
   * @param {number} startedAt
   * @returns {"sent" | "waiting" | null}
   */
  poll(answer, startedAt) {
    if (this.phase !== "checking" || !this.check || startedAt < this.check.from) return null;
    const s = this.sent;
    if (s.reviewId) {
      if (!answer.review || answer.review.id !== s.reviewId) {
        this.phase = "done";
        this.note = DIALOG_NOTES.gone;
        return "sent";
      }
    } else {
      const sub = answer.submitted;
      if (sub && sub.id !== this.lastSubmitted && sub.at >= s.at - SKEW_MS) {
        this.phase = "done";
        this.note = "";
        return "sent";
      }
    }
    this.note = DIALOG_NOTES.notYet;
    return "waiting";
  }

  /**
   * The check's clock: after 60 s without finding it, "Could not
   * confirm", and the choice is the user's (never a resend by itself;
   * sending again asks first).
   * @param {number} now
   * @returns {"unconfirmed" | null}
   */
  tick(now) {
    if (this.phase !== "checking" || !this.check || now < this.check.until) return null;
    this.phase = "choose";
    this.unconfirmed = true;
    this.note = DIALOG_NOTES.unconfirmed;
    this.check = null;
    return "unconfirmed";
  }
}
