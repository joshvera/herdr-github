// A read from herdr-github where gh is signed in, and when a failed one may
// look for GitHub again. No imports, so node can run its rule.
//
// Looking again (main's findGitHub) asks status on each machine in turn, and
// what it finds can be another who: a different machine counts as a
// different account (cache.js sameWho), and then the lists, the cache and an
// open PR's Files tab all start over. A dropped exec on a remote machine is
// not worth that. So only a read a person asked for (a key, a click, the
// popup opening) may look again; an automatic one (a poll, a read owed after
// a change, a diff fetched ahead) just fails, and the next one tries again.
//
//   no machine chosen ── auto ──► fails             (no search)
//          │            person ─► look, then ask
//   ask ── fails ─────── auto ──► fails             (no search)
//                        person ─► look, ask once more (not for an answer
//                                  GitHub or the machine gave: `settled`)

export const NOT_YET = "Not connected to GitHub yet";

/**
 * @template T
 * @param {{ ask: () => Promise<T>, find: () => Promise<unknown>, chosen: () => boolean,
 *   settled: (e: unknown) => boolean, auto: boolean }} r
 *   ask: the request, on the machine chosen when it's called; find: look
 *   for GitHub; chosen: a machine is; settled: an error asking elsewhere
 *   wouldn't change; auto: nobody asked for this read.
 * @returns {Promise<T>}
 */
export async function askSignedIn({ ask, find, chosen, settled, auto }) {
  if (!chosen()) {
    if (auto) throw new Error(NOT_YET);
    await find();
  }
  try {
    return await ask();
  } catch (e) {
    if (auto || settled(e)) throw e;
    await find();
    return ask();
  }
}
