// What a key does on a pull request's screen, by the tab shown. No imports,
// so the rules can be run on their own.
//
//   key ──► Files tab? ──► its view first (files.key) ──► declined ──┐
//                                                                     ▼
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

// The keys that change the PR or open a menu, and those kept for replying,
// resolving and handing to an agent: on the Files tab they do nothing, and
// aren't passed on.
const NOT_ON_FILES = new Set(["m", "d", "w", "s", "a", "l", "c", "x", "h"]);
const CHECK_KEYS = new Set(["up", "down", "j", "k", "enter"]);

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
// "ignore" (taken, does nothing), or null (not this screen's).
export function prRoute(k, tab, menuOpen) {
  if (menuOpen && tab === "overview") return k === "tab" || k === "shift-tab" ? "tab" : "menu";
  if (tabFor(k, tab)) return "tab";
  if (/^[1-9]$/.test(k)) return "ignore";
  if (k === "left" || k === "backspace") return "back";
  if (k === "o") return "link";
  if (k === "y") return "copy";
  if (k === "r") return "reload";
  if (tab === "overview") return "action";
  if (tab === "checks") return CHECK_KEYS.has(k) ? "checks" : null;
  if (tab === "files") return NOT_ON_FILES.has(k) ? "ignore" : null;
  return null;
}
