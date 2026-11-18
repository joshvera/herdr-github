// What a key does on a pull request's screen, by the tab shown. No imports,
// so the rules can be run on their own.
//
//   key ──► Files tab? ──► its view first (files.key) ──► declined ──┐
//                                                                     ▼
//          held? ──► only moves (↑ ↓ j k) and tabs; a menu sees to its own
//          menu open on Overview? ──► the menu (tab, shift-tab still switch)
//          1 2 3, tab, shift-tab ──► tabs        left, backspace ──► back
//          o y r ──► the shown tab's link, reload
//          Overview ──► the PR's actions (w s m d a l)
//          Checks   ──► ↑ ↓ j k, enter
//          Files    ──► nothing: the PR's actions never reach it

// The PR screen's tabs, in order; 1 2 3 are their keys.
export const PR_TABS = [
  { id: "overview", label: "Overview" },
  { id: "checks", label: "Checks" },
  { id: "files", label: "Files changed" },
];

// Overview's keys: what changes the PR or opens a menu (main's prAction).
const ACTIONS = new Set(["w", "s", "m", "d", "a", "l"]);
// Those, and the keys kept for replying, resolving and handing to an agent:
// on the Files tab they do nothing, and aren't passed on.
const NOT_ON_FILES = new Set([...ACTIONS, "c", "x", "h"]);
const CHECK_KEYS = new Set(["up", "down", "j", "k", "enter"]);
// Where a held key never goes, past its press: these change the PR, open
// or copy a link, reload or leave, and a repeat comes before the first has
// shown what it did (a held d toggled draft on every repeat, reading a
// draft state still stale). Moves still repeat: ↑ ↓ j k on Checks.
const ONCE = new Set(["back", "link", "copy", "reload", "action", "checks"]);
const MOVES = new Set(["up", "down", "j", "k"]);

// The tab `k` goes to from `tab`, or null when it's no tab key.
export function tabFor(k, tab) {
  const i = PR_TABS.findIndex((t) => t.id === tab);
  if (/^[1-9]$/.test(k)) return PR_TABS[Number(k) - 1]?.id ?? null;
  if (k === "tab") return PR_TABS[(i + 1) % PR_TABS.length].id;
  if (k === "shift-tab") return PR_TABS[(i + PR_TABS.length - 1) % PR_TABS.length].id;
  return null;
}

// Where a key goes once the Files view (when shown) has declined it:
// "menu", "tab", "back", "link", "copy", "reload", "action", "checks",
// "ignore" (taken, does nothing), or null (not this screen's). `held`: a
// repeat.
export function prRoute(k, tab, menuOpen, held = false) {
  const to = route(k, tab, menuOpen);
  return held && ONCE.has(to) && !MOVES.has(k) ? "ignore" : to;
}

function route(k, tab, menuOpen) {
  if (menuOpen && tab === "overview") return k === "tab" || k === "shift-tab" ? "tab" : "menu";
  if (tabFor(k, tab)) return "tab";
  if (/^[1-9]$/.test(k)) return "ignore";
  if (k === "left" || k === "backspace") return "back";
  if (k === "o") return "link";
  if (k === "y") return "copy";
  if (k === "r") return "reload";
  if (tab === "overview") return ACTIONS.has(k) ? "action" : null;
  if (tab === "checks") return CHECK_KEYS.has(k) ? "checks" : null;
  if (tab === "files") return NOT_ON_FILES.has(k) ? "ignore" : null;
  return null;
}
