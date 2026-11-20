// Sending a change to GitHub, once. No imports, so node can run its rules.
//
// A mutation that might have gone through must never go again on its own:
// the mod's ordinary request path (main's gh) asks a second machine when the
// first fails, which for a comment is a second comment. So a mutation has its
// own path, and every way it can end is one of three outcomes:
//
//   who ──────── status fails, who changed ──────────► refused  (nothing ran)
//      │
//   prepare() ── throws ──────────────────────────────► refused  (nothing ran)
//      │
//   run(bin) ─── rejects, times out ─────────────────► unknown  (it may have run)
//      │
//   stdout ───── not JSON ───────────────────────────► unknown
//      │         {error, unknown: true} ─────────────► unknown
//      │         {error} ────────────────────────────► refused  (GitHub said no)
//      └──────── anything else ──────────────────────► ok
//
// Refused and unknown keep the whole answer, so what came with the error (the
// pending review left behind, the review's new count) isn't lost.

/**
 * @typedef {{ kind: "ok", answer: any }
 *   | { kind: "refused", error: string, answer: any }
 *   | { kind: "unknown", error: string, answer: any }} Outcome
 */

// The binary's own deadline for a mutation op is 20 s; the mod waits longer,
// so the binary always gets to answer first.
export const MUTATION_TIMEOUT = 45000;

const said = (e) => String(e?.message ?? e);

/**
 * Who a change goes as (main's status search, seen from here). `made` is
 * `gen()` when the change's request was built from what was on screen.
 * @typedef {{ finding: () => Promise<unknown> | null, live: () => boolean,
 *   find: () => Promise<unknown>, gen: () => number, made: number }} Who
 */

/**
 * Runs one mutation, once.
 * @param {{ who?: Who, prepare: () => Promise<string>, run: (bin: string) => Promise<{ stdout: string }> }} steps
 *   who: settled first (settleWho; none in the demo); prepare: finds the
 *   binary (nothing is sent yet); run: execs it with the request.
 * @returns {Promise<Outcome>}
 */
export async function sendOnce({ who, prepare, run }) {
  let bin;
  try {
    if (who) await settleWho(who);
    bin = await prepare();
  } catch (e) {
    return { kind: "refused", error: `Nothing was sent: ${said(e)}`, answer: null };
  }
  let out;
  try {
    out = await run(bin);
  } catch (e) {
    // exec rejects alike for a timeout, a lost machine and a program that
    // never started: none of them says whether GitHub got it.
    return { kind: "unknown", error: `No answer from herdr-github: ${said(e)}`, answer: null };
  }
  return classify(out?.stdout);
}

/**
 * Before a change goes: who it goes as is the one status said this opening,
 * not the cache's, and still the one it was made under. A status search
 * already out is waited for (it may be about to say someone else); with no
 * who said yet, status is asked now. `gen` moves whenever who changes (main's
 * forget), so a change made before that is from another account's screen
 * (its pending review, its "mine") and goes nowhere. Throws why not.
 * @param {Who} who
 */
export async function settleWho({ finding, live, find, gen, made }) {
  // Until none is out: one that ends may have started another.
  for (let out = finding(), last = null; out && out !== last; last = out, out = finding()) await out;
  if (!live()) await find();
  if (gen() !== made) throw new Error("the GitHub account changed since this was made");
}

/**
 * What herdr-github's output means for a mutation.
 * @param {string | undefined} stdout
 * @returns {Outcome}
 */
export function classify(stdout) {
  let answer;
  try {
    answer = JSON.parse(stdout ?? "");
  } catch {
    return { kind: "unknown", error: "herdr-github's answer wasn't readable", answer: null };
  }
  if (answer === null || typeof answer !== "object") {
    return { kind: "unknown", error: "herdr-github's answer wasn't readable", answer: null };
  }
  if (answer.error) {
    const error = String(answer.error);
    return answer.unknown === true ? { kind: "unknown", error, answer } : { kind: "refused", error, answer };
  }
  return { kind: "ok", answer };
}

// Polls against local changes (spec A3). A poll that started before a
// mutation ended can hold a picture older than the change: drawing it would
// take back a comment just added or flip a resolve back. So:
//
//   - no poll starts while a mutation is out;
//   - the generation moves when a mutation starts and again when it ends;
//   - an answer whose request saw another generation is dropped, and asked
//     for again once nothing is out.
export class MutationGate {
  constructor() {
    this.gen = 0;
    this.out = 0; // mutations in flight
    this.owed = false; // a poll was skipped or dropped: ask one when clear
  }

  /** A mutation starts. */
  begin() {
    this.out++;
    this.gen++;
  }

  /** A mutation ended (any outcome). True when a poll is owed now. */
  end() {
    this.out = Math.max(0, this.out - 1);
    this.gen++;
    // Whatever was on screen before the change is older than it.
    this.owed = true;
    return this.clear();
  }

  /** Nothing in flight. */
  clear() {
    return this.out === 0;
  }

  /** A poll wants to start: its stamp, or null when it must wait (and is then owed). */
  startPoll() {
    if (!this.clear()) {
      this.owed = true;
      return null;
    }
    this.owed = false;
    return this.gen;
  }

  /** A poll's answer came: true to use it. A stale one is owed again. */
  fresh(stamp) {
    if (stamp === this.gen) return true;
    this.owed = true;
    return false;
  }

  /** True once, when an owed poll can go now. */
  takeOwed() {
    if (!this.owed || !this.clear()) return false;
    this.owed = false;
    return true;
  }
}
