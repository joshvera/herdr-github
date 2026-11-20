// Drafts: what's typed in the composer and not yet sent to GitHub, kept in
// the mod's localStorage so closing the composer, the popup or the app
// never loses it. No imports (the storage is handed in), so node can run its
// rules.
//
// One key holds a map, draft id → draft. A draft is one per target:
//
//   comment  (PR, path, side, line, the line's text)   the head it was
//            typed at is kept, not part of the id: after new commits it's
//            offered again only on a row with the same path, side, line
//            AND text, never by line number alone (spec A9)
//   reply    (PR, thread)
//   edit     (PR, comment)
//   body     (PR)       the submit dialog's text
//
// Writes are read-modify-write of the ids this store changed, so two views
// (one per PR opened) never write each other's drafts back stale. Typing
// is saved at most every SAVE_MS (the view's timer calls flush); a send's
// state is saved at once (saveNow).

export const MAX_DRAFTS = 50;
export const SAVE_MS = 500;
export const DRAFTS_KEY = "drafts";
// The demo's drafts are its own: made-up PRs never mix with real ones.
export const DEMO_DRAFTS_KEY = "drafts-demo";

/**
 * @typedef {{ kind: "comment" | "reply" | "edit" | "body", pr: string,
 *   path?: string, side?: "left" | "right", line?: number, text?: string, head?: string,
 *   thread?: string, comment?: string, author?: string, published?: boolean }} Target
 * @typedef {{ state: "sending" | "unknown", since: number, ids: string[], body: string }} SendState
 *   ids: the viewer's comments on the target before the send (A2); body: what was sent
 * @typedef {Target & { id: string, body: string, at: number, send: SendState | null }} Draft
 */

/**
 * A target's draft id.
 * @param {Target} t
 */
export function draftId(t) {
  if (t.kind === "comment") return JSON.stringify(["comment", t.pr, t.path, t.side, t.line, t.text]);
  if (t.kind === "reply") return JSON.stringify(["reply", t.pr, t.thread]);
  if (t.kind === "edit") return JSON.stringify(["edit", t.pr, t.comment]);
  return JSON.stringify(["body", t.pr]);
}

/**
 * A draft for `target`.
 * @param {Target} target
 * @param {string} body
 * @param {number} now
 * @returns {Draft}
 */
export function makeDraft(target, body, now) {
  return { ...target, id: draftId(target), body, at: now, send: null };
}

// A draft worth keeping: something typed, or a send whose outcome isn't
// known (its state is the record of what may have gone).
const worth = (d) => Boolean(d) && (d.send !== null || d.body.trim() !== "");

const isMap = (m) => m !== null && typeof m === "object" && !Array.isArray(m);

export class DraftStore {
  /**
   * @param {{ getItem(k: string): string | null, setItem(k: string, v: string): void }} storage
   * @param {string} key
   */
  constructor(storage, key) {
    this.storage = storage;
    this.key = key;
    /** @type {Map<string, Draft | null>} changes not yet written: null removes */
    this.pending = new Map();
  }

  /** @returns {Record<string, Draft>} */
  read() {
    try {
      const m = JSON.parse(this.storage.getItem(this.key) ?? "{}");
      return isMap(m) ? m : {};
    } catch {
      return {};
    }
  }

  /** Every draft, with what isn't written yet. */
  all() {
    const m = this.read();
    for (const [id, d] of this.pending) {
      if (d) m[id] = d;
      else delete m[id];
    }
    return m;
  }

  /** @returns {Draft | null} */
  get(id) {
    if (this.pending.has(id)) return this.pending.get(id);
    return this.read()[id] ?? null;
  }

  /** A PR's drafts. @returns {Draft[]} */
  forPR(pr) {
    return Object.values(this.all()).filter((d) => d.pr === pr);
  }

  /** Kept, written by the next flush. An empty one is removed. */
  put(draft) {
    this.pending.set(draft.id, worth(draft) ? draft : null);
  }

  /** Kept and written now (a send's state, before the send). */
  saveNow(draft) {
    this.put(draft);
    return this.flush();
  }

  /** Removed now (it was sent). */
  remove(id) {
    this.pending.set(id, null);
    return this.flush();
  }

  dirty() {
    return this.pending.size > 0;
  }

  /**
   * Writes what changed. Past MAX_DRAFTS the oldest goes (one with no send
   * outcome to check first), and is handed back so the view can say so.
   * @returns {{ dropped: Draft[] }}
   */
  flush() {
    if (!this.pending.size) return { dropped: [] };
    const m = this.all();
    this.pending.clear();
    const dropped = [];
    for (let n = Object.keys(m).length; n > MAX_DRAFTS; n--) {
      const ds = Object.values(m).sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      const old = ds.find((d) => !d.send) ?? ds[0];
      dropped.push(old);
      delete m[old.id];
    }
    this.storage.setItem(this.key, JSON.stringify(m));
    return { dropped };
  }
}

/**
 * What the view says when the cap dropped a draft.
 * @param {Draft} d
 */
export function droppedNote(d) {
  return `Dropped your oldest draft (on ${d.path || "the review's text"})`;
}

/**
 * The diff row a new-comment draft is on: same side, line AND text. -1 when
 * there's none (the line moved or changed with new commits).
 * @param {{ kind: string, old: number, new: number, text: string }[]} rows
 * @param {{ side?: string, line?: number, text?: string }} t
 */
export function rowOf(rows, t) {
  return rows.findIndex((r) => (r.kind === "add" || r.kind === "del" || r.kind === "ctx")
    && (t.side === "left" ? r.kind !== "add" && r.old === t.line : r.kind !== "del" && r.new === t.line)
    && r.text === t.text);
}

/**
 * What `c` on a diff row comments on: its side (a deleted line is the old
 * side, the rest the new), line on that side, and text. Null for a hunk
 * header or a note.
 * @param {{ kind: string, old: number, new: number, text: string }} row
 * @param {{ pr: string, path: string, head: string }} at
 * @returns {Target | null}
 */
export function rowTarget(row, at) {
  if (row.kind !== "add" && row.kind !== "del" && row.kind !== "ctx") return null;
  const left = row.kind === "del";
  return { kind: "comment", pr: at.pr, path: at.path, side: left ? "left" : "right", line: left ? row.old : row.new, text: row.text, head: at.head };
}

/**
 * New-comment drafts typed at another head that sit on the same row (same
 * side, line and text) of `path`'s diff at `head`: those are at that head
 * now. The rest stay where they were, unplaced.
 * @param {Draft[]} drafts the PR's
 * @param {string} path
 * @param {string} head
 * @param {any[]} rows that path's diff rows at head
 * @returns {Draft[]} the drafts moved to head
 */
export function placeDrafts(drafts, path, head, rows) {
  return drafts
    .filter((d) => d.kind === "comment" && d.path === path && d.head !== head && rowOf(rows, d) >= 0)
    .map((d) => ({ ...d, head }));
}

/**
 * New-comment drafts that aren't on the head shown: they can't be sent
 * until they're placed again, and the submit dialog lists them.
 * @param {Draft[]} drafts the PR's
 * @param {string} head
 */
export function unplaced(drafts, head) {
  return drafts.filter((d) => d.kind === "comment" && d.head !== head);
}
