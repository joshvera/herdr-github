// A read from herdr-github where gh is signed in, and when a failed one may
// look for GitHub again. No imports, so node can run its rule.
//
// Looking again (main's findGitHub) asks status on each machine in turn, and
// what it finds can be another who: a different machine counts as a
// different account (cache.js sameWho), and then the lists, the cache and an
// open PR's Files tab all start over. A dropped exec on a remote machine is
// not worth that. So while a PR is open, only a read a person asked for
// there (opening it, r, the Files tab shown) may look again; an automatic
// one (a poll, a read owed after a change or after who changed, a diff
// fetched ahead, the lists' own) just fails, and the next one tries again.
//
//   no machine chosen ── auto ──► fails             (no search)
//          │            person ─► look, then ask
//   ask ── fails ─────── auto ──► fails             (no search)
//                        person ─► look, ask once more (not for an answer
//                                  GitHub or the machine gave: `settled`)
//
// Whether it's automatic is decided when it would look, not when it was
// asked: a list refresh or a warm started on the list may fail after enter
// opened a PR, and it's that PR the search would yank.

export const NOT_YET = "Not connected to GitHub yet";

/**
 * Why a read is made:
 *   "asked": a person, on the PR screen (opening it, r, the Files tab shown);
 *   "list": the lists' own (their timer, start, r or a repo picked there,
 *     warming): as ever on the list, automatic while a PR is showing;
 *   "auto": nobody (a poll, a diff, what's read again after a change or
 *     after who changed).
 * @typedef {"asked" | "list" | "auto"} Why
 */

/**
 * Whether a read made for `why` may look for GitHub now.
 * @param {Why} why
 * @param {boolean} prShowing the PR screen is what's shown
 */
export function mayLook(why, prShowing) {
  if (why === "asked") return true;
  if (why === "list") return !prShowing;
  return false;
}

/**
 * @template T
 * @param {{ ask: () => Promise<T>, find: () => Promise<unknown>, chosen: () => boolean,
 *   settled: (e: unknown) => boolean, look: () => boolean }} r
 *   ask: the request, on the machine chosen when it's called; find: look
 *   for GitHub; chosen: a machine is; settled: an error asking elsewhere
 *   wouldn't change; look: whether this read may look now (mayLook).
 * @returns {Promise<T>}
 */
export async function askSignedIn({ ask, find, chosen, settled, look }) {
  if (!chosen()) {
    if (!look()) throw new Error(NOT_YET);
    await find();
  }
  try {
    return await ask();
  } catch (e) {
    if (settled(e) || !look()) throw e;
    await find();
    return ask();
  }
}
