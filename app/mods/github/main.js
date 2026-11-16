// Your pull requests in a popup: yours, the ones waiting on your review, and
// this repo's, grouped by whose move it is. Open one for whether it can
// merge and why not, its checks, reviews and the conversation; merge it (or
// auto-merge, or through its merge queue), toggle draft, and one key to a
// worktree for it in a space of its own, with an agent started on it.
//
// The work is herdr-github's (`app`), the TUI plugin's own code, run on the
// machine where gh is signed in. The mod fetches the herdr-github release it
// needs onto each machine it asks, the first time (on this computer, a local
// build in its place when dev.json names one).

import { View, div } from "gpui-kit";
import * as fs from "fs/promises";
import { v_flex, h_flex, InputState, Input, TextView, Scrollbar, v_virtual_list, VirtualListScrollHandle, ScrollHandle } from "gpui-base";
import { agents, panes, machines, spaces, run, exec, theme, appHome, props, closeOverlay, openOverlay, nextCommand, knownAgents } from "herdr";
import { demoAgents, DEMO_REPO } from "./demo.js";
import { tones, tint, countPill, groupOf, toneColor, prLook, checkLook, ago, icon, chip, words, key, cap, MONO } from "./look.js";
import { PR_TABS, tabFor, prRoute } from "./prkeys.js";

// The herdr-github this mod is part of (its release; the repo's tests hold it
// to herdr-plugin.toml's version).
export const GITHUB_VERSION = "0.11.0";

// Puts that release on a machine, once: into a folder of its own version, so
// it never touches a herdr-github installed for the TUI. The archive for the
// machine's system is checked against the release's checksums before it's
// used. Prints the binary's path.
const PROVISION = String.raw`
v=$1
dest="$HOME/.local/share/herdr-github/app/$v"
bin="$dest/herdr-github"
[ -x "$bin" ] && { printf '%s' "$bin"; exit 0; }
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo "no herdr-github for $(uname -s)" >&2; exit 1 ;; esac
case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "no herdr-github for $(uname -m)" >&2; exit 1 ;; esac
name="herdr-github_$v""_$os""_$arch.tar.gz"
url="https://github.com/mrolafsson/herdr-github/releases/download/v$v"
tmp=$(mktemp -d) || exit 1
trap 'rm -rf "$tmp"' EXIT
curl -fsSL "$url/$name" -o "$tmp/$name" && curl -fsSL "$url/checksums.txt" -o "$tmp/sums" || { echo "couldn't download herdr-github $v" >&2; exit 1; }
want=$(grep " $name\$" "$tmp/sums" | cut -d' ' -f1)
if command -v sha256sum >/dev/null 2>&1; then have=$(sha256sum "$tmp/$name" | cut -d' ' -f1); else have=$(shasum -a 256 "$tmp/$name" | cut -d' ' -f1); fi
[ -n "$want" ] && [ "$want" = "$have" ] || { echo "herdr-github $v didn't match its checksum" >&2; exit 1; }
tar -xzf "$tmp/$name" -C "$tmp" herdr-github || exit 1
mkdir -p "$dest" && mv "$tmp/herdr-github" "$bin.new" && chmod 755 "$bin.new" && mv "$bin.new" "$bin" || exit 1
printf '%s' "$bin"
`;

// A herdr-github built on this computer, to run in place of the release:
// `mods/github/dev.json` in the app's home, `{"bin": "/absolute/path"}`. Only
// for requests on this computer; other machines fetch the release as ever.
// Kept out of the repo (.gitignore), so it's never shipped.
const DEV = `${appHome()}/mods/github/dev.json`;

// A dev.json that's there but wrong: said as it is, never worked around by
// asking another machine instead.
class DevError extends Error {}

async function devBinary() {
  const text = await fs.readFile(DEV, "utf8").catch(() => null);
  if (text === null) return null;
  let bin;
  try {
    bin = JSON.parse(text)?.bin;
  } catch {
    throw new DevError(`${DEV} isn't JSON`);
  }
  if (typeof bin !== "string" || !bin.startsWith("/")) throw new DevError(`${DEV} needs {"bin": "/absolute/path"}`);
  const r = await exec("test", ["-x", bin]);
  if (r.code !== 0) throw new DevError(`${DEV} names ${bin}, which isn't an executable file`);
  return bin;
}

function provision(machine) {
  return exec("sh", ["-c", PROVISION, "sh", GITHUB_VERSION], { on: machine }).then((r) => {
    if (r.code !== 0 || !r.stdout.trim()) throw new Error(r.stderr.trim().split("\n").pop() || `herdr-github: exit ${r.code}`);
    return r.stdout.trim();
  });
}

const binaries = new Map();
function binary(machine) {
  const k = machine ?? "";
  if (!binaries.has(k)) {
    const p = (machine == null ? devBinary() : Promise.resolve(null)).then((dev) => dev ?? provision(machine));
    p.catch(() => binaries.delete(k));
    binaries.set(k, p);
  }
  return binaries.get(k);
}

// What herdr-github answered with an error: why, and what it means.
class AppError extends Error {
  constructor(res) {
    super(res.error);
    this.signedOut = res.signedOut ?? null;
    this.noCheckout = res.noCheckout ?? null;
    // The PR's head moved past the one the request named: read it again.
    this.stale = Boolean(res.stale);
  }
}

// A request that ran out of time: the machine answered, slowly. Shown as it
// is; asking another machine wouldn't make it faster.
class TimedOut extends Error {}

// exec's own limit when none is given.
const EXEC_TIMEOUT = 30000;

// One request to herdr-github on a machine (null: this one). `opts` go to
// exec (a longer `timeout`, in ms).
/** @param {{ timeout?: number }} [opts] */
async function ask(req, machine, opts = {}) {
  const bin = await binary(machine);
  const limit = opts.timeout ?? EXEC_TIMEOUT;
  const started = Date.now();
  let r;
  try {
    r = await exec("sh", ["-c", 'exec "$0" app "$1"', bin, JSON.stringify(req)], { ...opts, on: machine });
  } catch (e) {
    // exec rejects the same way for a timeout and an unreachable machine;
    // only the time it took tells them apart.
    if (Date.now() - started >= limit - 250) throw new TimedOut(`herdr-github didn't answer within ${Math.round(limit / 1000)}s`);
    throw e;
  }
  let res;
  try {
    res = JSON.parse(r.stdout);
  } catch {
    throw new Error(r.stderr.trim().split("\n").pop() || `herdr-github: exit ${r.code}`);
  }
  if (res?.error) throw new AppError(res);
  return res;
}

// A request that can take longer than a command may (a worktree's fetch, a
// clone): run as a job there, and asked after until it's done.
async function job(req, machine, limitMs = 10 * 60000) {
  const { job: id } = await ask({ ...req, bg: true }, machine);
  const until = Date.now() + limitMs;
  while (Date.now() < until) {
    await exec("sleep", ["1"]).catch(() => {});
    const res = await ask({ op: "job", job: id }, machine);
    if (res.done) {
      if (res.result?.error) throw new AppError(res.result);
      return res.result;
    }
  }
  throw new Error("it's taking too long; it carries on in the background");
}

const TABS = [
  { id: "mine", label: "Mine", icon: "person" },
  { id: "review", label: "Review requested", short: "Review", icon: "need" },
  { id: "repo", label: "This repo", icon: "pr" },
];

// A ticket's key in a branch or title ("sam/hal-212-merge", "HAL-212: …"), as
// Recap finds one: its Linear issue, a link to the Linear mod.
const TICKET = /(?:^|[^a-z0-9])([a-z][a-z0-9]{1,9})-([1-9][0-9]{0,5})(?=[^a-z0-9]|$)/gi;
const NOT_TICKETS = new Set(("phase step part pr v version release issue fix bug test try attempt wave stage sprint " +
  "week day round batch task milestone iteration option plan draft rev").split(" "));
function ticketKey(...texts) {
  for (const s of texts) {
    for (const m of (s ?? "").matchAll(TICKET)) {
      if (!NOT_TICKETS.has(m[1].toLowerCase())) return `${m[1].toUpperCase()}-${m[2]}`;
    }
  }
  return null;
}

// GitHub's and Linear's magic words in a PR's description ("Fixes HAL-212"):
// the issue it closes, when its branch and title don't say.
const MAGIC = /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|part of|refs?)\s+([A-Za-z][A-Za-z0-9]{1,9}-[1-9][0-9]{0,5})\b/i;
const issueOf = (pr, body) => ticketKey(pr?.head, pr?.title) ?? (MAGIC.exec(body ?? "")?.[1]?.toUpperCase() || null);

// The list's heights: a heading's, a pull request's card (and a gap), a
// repo's row, and the most it takes before it scrolls.
const HEADING_H = 30;
const CARD_H = 74;
const REPO_H = 36;
const LIST_H = 560;

// The PR screen's: its tabs' height (each as tall), Overview's side's width.
const PR_BODY_H = 440;
const SIDE_W = 280;

// Checks, in the order they're counted and listed: what needs you first.
const CHECK_ORDER = ["fail", "pending", "pass", "skip"];

// Where the lists are kept between openings.
const CACHE = `${appHome()}/github-cache.json`;

const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);
const prID = (pr) => ({ host: pr.host, repo: pr.repo, number: pr.number });

// A GitHub remote's repo: git@host:owner/name, https://host/owner/name, ssh://.
function parseRemote(url) {
  const m = url.match(/^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^:/]+)[:/]([^/]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? { host: m[1].toLowerCase(), owner: m[2], name: m[3] } : null;
}

// Where a space is now: its first terminal's live folder, else where it was made.
function place(s) {
  const tabs = new Set((s.tabs ?? []).map((t) => t.id));
  return panes().find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

// The Files changed tab until its view (files.js) is built: its count, and a
// word that it's coming. That view takes this one's place (openPR makes one
// per PR) with the same methods:
//   key(k, cx)   every key on the tab first; true when it took it
//   escape(cx)   esc on the tab first; true when it took it (its filter)
//   shown(cx)    the tab came into view: load what it shows
//   reload(cx)   github.reload while it's shown
//   link()       what o opens and y copies
//   view(o)      the tab's body
//   footer(k)    its keys for the footer, before tabs and esc
class ComingFiles {
  constructor(gh) {
    this.gh = gh;
  }
  key(_k, _cx) {
    return false;
  }
  escape(_cx) {
    return false;
  }
  shown(_cx) {}
  reload(_cx) {}
  link() {
    return this.gh.cur?.url ? `${this.gh.cur.url}/files` : "";
  }
  view(o) {
    const d = this.gh.detail;
    return v_flex().flex_1().min_h(0).gap(8).p(14)
      .child(h_flex().gap(8).items_center()
        .child(div().text_size(15).font_semibold().text_color(o.fg).child("Files changed"))
        .child(countPill(o, d ? String(d.files) : "", true)))
      .child(div().text_size(12.8).text_color(o.dim).child("Its files and their diffs will show here in a coming version. Until then, o opens them on GitHub."));
  }
  footer(k) {
    return [
      k(["o"], "GitHub", (cx) => this.gh.open(this.link(), cx), "f-o"),
      k(["y"], "copy link", (cx) => this.gh.copy(this.link(), cx), "f-y"),
    ];
  }
}

export default class GitHub extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.demo = Boolean(p.demo);
    this.screen = "list";
    this.tab = localStorage.getItem("tab") ?? "mine";
    this.lists = {};
    this.filter = "";
    this.at = 0;
    this.cur = null; // the PR open, as listed
    this.detail = null;
    this.prTab = "overview"; // the PR screen's tab (PR_TABS)
    this.menu = null;
    this.parked = null; // a menu that came while Overview wasn't shown
    this.checkAt = 0; // the chosen check, on the Checks tab
    this.checkScroll = ScrollHandle.new();
    this.files = null; // the Files changed tab's view, one per PR opened
    this.flash = "";
    this.err = "";
    this.busy = "";
    this.repo = null;
    this.picking = false; // the repo tab's list of repos
    this.repos = null;
    this.sessions = {};
    this.trees = JSON.parse(localStorage.getItem("trees") ?? "{}");
    this.login = "";
    this.on = localStorage.getItem("on"); // the machine gh is signed in on ("" here)
    this.width = 900;
    this.from = p.back ?? null; // the mod it was opened from, to go back to
    // Where esc goes back to, when another mod opened it on a PR: that mod,
    // on what it showed (Linear, on the issue).
    this.backTo = p.backTo ?? null;
    // With herdr-linear's mod installed, a PR's Linear issue opens there.
    this.linear = false;
    cx.spawn(async (cx) => {
      this.linear = (await fs.readFile(`${appHome()}/mods/linear/main.js`, "utf8").catch(() => null)) !== null;
      cx.notify();
    });

    this.keys = cx.focus_handle();
    // The list's scroll position, so the chosen row is kept in sight.
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Type to filter…  ← → to change tabs" });
    this.input.on("change", (_e, cx) => {
      this.filter = this.input.value();
      this.at = 0;
      cx.notify();
    });
    this.input.on("submit", (_e, cx) => this.enter(cx));
    this.input.on("blur", (_e, cx) => {
      cx.timer.after(40, () => {
        if (this.screen === "list" && !this.closing) this.input.focus();
      });
    });
    this.input.focus();
    cx.timer.after(400, () => this.screen === "list" && this.input.focus());

    cx.spawn(async (cx) => {
      await this.readCache(cx);
      if (p.pr) this.openPR({ ...p.pr, key: `${p.pr.host}/${p.pr.repo}#${p.pr.number}`.toLowerCase(), title: `#${p.pr.number}`, labels: [] }, cx, true);
      await this.start(cx);
      cx.notify();
    });
    cx.timer.every(60000, (cx) => this.screen === "list" && !this.busy && this.loadAll(cx));

    // Key bindings and `herdr-app do`: github.escape, github.tab,
    // github.backtab, github.demo, github.next, github.prev, github.reload.
    // keys.json binds tab and shift-tab here: the app keeps them otherwise.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "escape") this.escape(cx);
        else if (c === "tab" || c === "backtab") this.press(c === "tab" ? "tab" : "shift-tab", cx);
        else if (c === "demo") {
          this.demo = !this.demo;
          this.lists = {};
          this.screen = "list";
          this.repo = null;
          this.trees = this.demo ? {} : JSON.parse(localStorage.getItem("trees") ?? "{}");
          await this.start(cx);
        } else if (c === "next" || c === "prev") this.step(c === "next" ? 1 : -1, cx);
        else if (c === "reload") this.reload(cx);
        cx.notify();
      }
    });
  }

  // ── where things run ───────────────────────────────────────────────────

  // The machine gh is signed in on: the one that answered last, else this
  // one, else each connected one in turn.
  async findGitHub() {
    const order = [this.on, "", ...machines().filter((m) => m.name && m.layout !== "unavailable").map((m) => m.name)];
    const tried = new Set();
    let last;
    for (const m of order) {
      if (m == null || tried.has(m)) continue;
      tried.add(m);
      try {
        const s = await ask({ op: "status" }, m || null);
        const signed = s.hosts.find((h) => h.login);
        if (!signed) {
          last = new Error(s.hosts.map((h) => h.error).join("; ") || "gh isn't signed in");
          continue;
        }
        this.on = m;
        this.login = signed.login;
        localStorage.setItem("on", m);
        return m || null;
      } catch (e) {
        if (e instanceof DevError) throw e;
        last = e;
      }
    }
    this.on = null;
    throw last ?? new Error("no machine answered");
  }

  // One request where gh is signed in; `opts` go to exec (see ask).
  /** @param {{ timeout?: number }} [opts] */
  async gh(req, opts = {}) {
    if (this.demo) return ask({ ...req, demo: true }, null, opts);
    if (this.on == null || !this.login) await this.findGitHub();
    try {
      return await ask(req, this.on || null, opts);
    } catch (e) {
      if (e instanceof AppError || e instanceof TimedOut || e instanceof DevError) throw e;
      // The machine went away, or herdr-github couldn't be fetched there: look again.
      await this.findGitHub();
      return ask(req, this.on || null, opts);
    }
  }

  async start(cx) {
    this.err = "";
    try {
      if (!this.demo) await this.findGitHub();
      else this.login = "sam";
    } catch (e) {
      this.err = `Not signed in to GitHub on any machine: ${e?.message ?? e}. Run gh auth login on one.`;
      return cx.notify();
    }
    await this.findRepo();
    this.loadAll(cx);
  }

  // The repo tab's repo: the shown space's, from its remotes.
  async findRepo() {
    if (this.demo) return (this.repo = this.repo ?? DEMO_REPO);
    const s = spaces().find((s) => s.active);
    const folder = s && place(s);
    if (!folder) return;
    const r = await exec("git", ["-C", folder, "remote", "-v"], { on: s.machine }).catch(() => null);
    if (!r || r.code !== 0) return;
    const remotes = new Map(r.stdout.split("\n").map((l) => l.split(/\s+/)).filter((p) => p.length >= 2).map(([name, url]) => [name, url]));
    for (const name of ["upstream", "origin", ...remotes.keys()]) {
      const repo = remotes.has(name) && parseRemote(remotes.get(name));
      if (repo) return (this.repo = repo);
    }
  }

  repoSpec() {
    return this.repo ? `${this.repo.host}/${this.repo.owner}/${this.repo.name}` : "";
  }

  // ── lists ──────────────────────────────────────────────────────────────

  loadAll(cx) {
    for (const t of TABS) this.load(t.id, cx);
  }

  // The lists as they were last time, shown at once on opening while fresh
  // ones are asked for: a file in the app's folder (a shared value would
  // redraw every mod each time it's set). Never the demo's.
  async readCache(cx) {
    if (this.demo) return;
    this.cache = JSON.parse((await fs.readFile(CACHE, "utf8").catch(() => null)) ?? "{}");
    this.login ||= this.cache.login ?? "";
    for (const t of ["mine", "review"]) this.seed(t, this.cache.lists?.[t]);
    cx.notify();
  }

  seed(tab, kept) {
    const l = this.lists[tab];
    if (!kept || this.demo || (l?.loaded && !l.cached)) return;
    this.lists[tab] = { ...l, prs: kept.prs ?? [], next: kept.next ?? "", loaded: true, cached: true, loading: l?.loading };
  }

  keep(tab, l) {
    if (this.demo) return;
    const c = (this.cache ??= {});
    c.login = this.login;
    c.lists ??= {};
    if (tab === "repo") (c.repos ??= {})[this.repoSpec()] = { prs: l.prs, next: l.next };
    else c.lists[tab] = { prs: l.prs, next: l.next };
    fs.writeFile(CACHE, JSON.stringify(c)).catch(() => {});
  }

  load(tab, cx, more = false) {
    if (tab === "repo" && !more && !this.lists.repo?.loaded) this.seed("repo", this.cache?.repos?.[this.repoSpec()]);
    const l = (this.lists[tab] ??= { prs: [], next: "", loaded: false });
    if (l.loading || (more && !l.next)) return;
    if (tab === "repo" && !this.repo) {
      l.loaded = true;
      return;
    }
    l.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const res = await this.gh({ op: "list", tab, repo: this.repoSpec(), cursor: more ? l.next : "" });
        l.prs = more ? [...l.prs, ...res.prs] : res.prs;
        l.next = res.next;
        l.warning = res.warning ?? "";
        l.error = "";
        l.cached = false;
        if (!more) this.keep(tab, l);
      } catch (e) {
        l.error = e?.signedOut ? `Not signed in to ${e.signedOut === true ? "GitHub" : e.signedOut}: run gh auth login` : String(e?.message ?? e);
      }
      l.loading = false;
      l.loaded = true;
      cx.notify();
    });
  }

  reload(cx) {
    if (this.screen === "pr") {
      if (this.prTab === "files") this.files?.reload(cx);
      return this.loadDetail(cx);
    }
    this.loadAll(cx);
  }

  step(d, cx) {
    const i = TABS.findIndex((t) => t.id === this.tab);
    this.tab = TABS[(i + d + TABS.length) % TABS.length].id;
    localStorage.setItem("tab", this.tab);
    this.at = 0;
    this.picking = false;
    cx.notify();
  }

  matches(pr) {
    const hay = [`#${pr.number}`, pr.title, pr.repo, pr.author, pr.head, ...pr.labels.map((l) => l.name), ...this.agentsOf(pr).map((a) => a.name)]
      .join(" ").toLowerCase();
    return this.filter.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
  }

  pickingRepo() {
    return this.tab === "repo" && (this.picking || !this.repo);
  }

  shownList() {
    if (this.pickingRepo()) return [];
    return (this.lists[this.tab]?.prs ?? []).filter((pr) => this.matches(pr));
  }

  enter(cx) {
    if (this.pickingRepo()) return this.pickRepo(this.shownRepos()[this.at], cx);
    const pr = this.shown?.[this.at];
    if (pr) this.openPR(pr, cx);
  }

  // ── the repo tab's repos ───────────────────────────────────────────────

  showRepos(cx) {
    this.picking = true;
    this.at = 0;
    if (!this.repos) {
      this.repos = { list: [], loading: true };
      cx.spawn(async (cx) => {
        try {
          this.repos.list = (await this.gh({ op: "repos" })).repos;
        } catch (e) {
          this.repos.error = String(e?.message ?? e);
        }
        this.repos.loading = false;
        cx.notify();
      });
    }
    cx.notify();
  }

  shownRepos() {
    const f = this.filter.toLowerCase();
    return (this.repos?.list ?? []).filter((r) => !f || r.repo.toLowerCase().includes(f));
  }

  pickRepo(r, cx) {
    if (!r) return;
    const [owner, name] = r.repo.split("/");
    this.repo = { host: r.host, owner, name };
    this.picking = false;
    this.at = 0;
    this.input.set_value("");
    this.filter = "";
    this.lists.repo = null;
    this.load("repo", cx);
  }

  // ── a pull request's screen ────────────────────────────────────────────

  openPR(pr, cx, direct = false) {
    this.screen = "pr";
    this.cur = pr;
    this.detail = null;
    this.prTab = "overview";
    this.menu = this.parked = null;
    this.checkAt = 0;
    this.files = new ComingFiles(this);
    this.err = this.flash = "";
    this.direct = direct;
    this.loadDetail(cx);
    this.loadSessions(cx);
    cx.timer.after(30, () => this.keys.focus());
    cx.notify();
  }

  loadDetail(cx) {
    const pr = this.cur;
    cx.spawn(async (cx) => {
      try {
        const d = await this.gh({ op: "detail", pr: prID(pr) });
        if (this.cur?.key !== pr.key) return;
        this.detail = d;
        this.cur = { ...pr, ...d };
        this.replaceRow(d);
      } catch (e) {
        if (this.cur?.key === pr.key) this.err = String(e?.message ?? e);
      }
      cx.notify();
    });
  }

  // A fresher copy of a PR in every list it's in.
  replaceRow(d) {
    for (const l of Object.values(this.lists)) {
      const i = l?.prs.findIndex((p) => p.key === d.key) ?? -1;
      if (i >= 0) l.prs[i] = { ...l.prs[i], ...d };
    }
  }

  back(cx) {
    if (this.direct && this.backTo) {
      this.dismiss();
      return openOverlay({ mod: this.backTo.mod, kind: "dialog", width: 0.8, height: 0.8, props: this.backTo.props ?? {} });
    }
    if (this.direct && this.from === "recap") {
      this.dismiss();
      if (this.demo) return openOverlay({ mod: "recap", kind: "dialog", width: 0.8, height: 0.8, props: { demo: true } });
      return run("mod.open", { name: "recap" });
    }
    this.direct = false;
    const key = this.cur?.key;
    this.screen = "list";
    this.menu = this.parked = null;
    this.err = this.flash = "";
    const i = this.shownList().findIndex((p) => p.key === key);
    if (i >= 0) this.at = i;
    cx.timer.after(30, () => this.input.focus());
    cx.notify();
  }

  // A key that can come both ways, bound in keys.json (a command) and to
  // on_key_down: once per press, so one escape never closes a menu and
  // leaves the screen too. Presses closer together than this are one.
  once(k) {
    const now = Date.now();
    if (this.pressed?.k === k && now - this.pressed.at < 80) return false;
    this.pressed = { k, at: now };
    return true;
  }

  escape(cx) {
    if (!this.once("escape")) return;
    if (this.menu) {
      this.menu = null;
      return cx.notify();
    }
    // The Files tab first (its filter, when it has one), then back.
    if (this.screen === "pr" && this.prTab === "files" && this.files?.escape(cx)) return cx.notify();
    if (this.screen === "pr") return this.back(cx);
    if (this.picking && this.repo) {
      this.picking = false;
      return cx.notify();
    }
    this.dismiss();
  }

  dismiss() {
    this.closing = true;
    closeOverlay(props().overlay);
  }

  open(url, cx) {
    if (!url) return;
    if (this.demo) return this.say(`Demo: would open ${url}`, cx);
    cx.open_url(url);
  }

  copy(url, cx) {
    if (!url) return;
    cx.write_to_clipboard(url);
    this.say(`Copied ${url}`, cx);
  }

  // A menu, on Overview: shown at once there; one that comes while another
  // tab is shown (after a merge, a worktree's question) waits for Overview.
  showMenu(m, cx) {
    if (this.screen === "pr" && this.prTab !== "overview") {
      this.parked = m;
      this.say(`${m.title} Press 1 to answer.`, cx);
      return;
    }
    this.menu = m;
    cx.notify();
  }

  // Shows a tab of the PR screen. Any menu closes (one parked shows on
  // Overview); the Files tab is told, to load what it shows.
  setPrTab(id, cx) {
    if (!PR_TABS.some((t) => t.id === id)) return;
    this.menu = null;
    this.prTab = id;
    if (id === "overview" && this.parked) {
      this.menu = this.parked;
      this.parked = null;
      this.flash = "";
    }
    if (id === "files") this.files?.shown(cx);
    cx.notify();
  }

  say(text, cx, isErr = false) {
    this.flash = isErr ? "" : text;
    this.err = isErr ? text : "";
    cx.notify();
  }

  // Changes the PR on GitHub, then reads it (and its lists) again.
  act(what, label, cx, after) {
    const pr = this.cur;
    this.busy = label;
    this.menu = null;
    cx.notify();
    cx.spawn(async (cx) => {
      let ok = false;
      try {
        const res = await this.gh({ op: "act", ...what, pr: prID(pr) });
        this.say(res.note ?? "Done", cx);
        ok = true;
      } catch (e) {
        this.say(String(e?.message ?? e), cx, true);
      }
      this.busy = "";
      if (ok && after) after(cx);
      this.loadDetail(cx);
      this.loadAll(cx);
      cx.notify();
    });
  }

  toggleDraft(cx) {
    const d = this.detail;
    if (!d) return this.say("Still loading…", cx);
    if (d.state !== "OPEN") return this.say(`#${d.number} is already ${d.state.toLowerCase()}.`, cx, true);
    this.act({ do: d.draft ? "ready" : "draft" }, d.draft ? "Marking it ready for review…" : "Making it a draft…", cx);
  }

  // The merge menu: herdr-github's choices; a confirmation for those that ask.
  mergeMenu(cx) {
    const d = this.detail;
    if (!d) return this.say("Still loading…", cx);
    if (d.mergeWhy) return this.say(d.mergeWhy.replace("mark it ready for review", "press d to mark it ready for review"), cx, true);
    const items = d.merge.map((c) => ({
      label: c.label,
      run: (cx) => {
        const go = (cx) => this.act({ do: c.do, method: c.method }, `${c.label}…`, cx, c.do === "merge" ? (cx) => this.cleanupMenu(cx) : null);
        if (!c.confirm) return go(cx);
        this.showMenu({ title: c.confirm, items: [{ label: c.yes, run: go }, { label: "Cancel", run: () => {} }], at: 1, confirm: true }, cx);
      },
    }));
    items.push({ label: "Cancel", run: () => {} });
    this.showMenu({ title: d.mergeTitle, items, at: 0 }, cx);
  }

  // After a merge: delete its branch on GitHub, remove its worktree.
  cleanupMenu(cx) {
    const d = this.detail;
    const pr = this.cur;
    const tree = this.treeOf(pr);
    const canDelete = d?.cleanup?.deleteBranch;
    if (!d || (!canDelete && !tree)) return;
    const clean = (branch, wt) => (cx) => {
      this.busy = "Cleaning up…";
      cx.notify();
      cx.spawn(async (cx) => {
        const done = [];
        const failed = [];
        if (branch) {
          try {
            await this.gh({ op: "act", do: "delete-branch", pr: prID(pr) });
            done.push("branch deleted");
          } catch (e) {
            failed.push(`branch not deleted: ${e?.message ?? e}`);
          }
        }
        if (wt) {
          try {
            if (!this.demo) {
              // Terminals first: a shell sitting in the folder keeps it busy.
              const s = this.spaceAt(tree.path, tree.machine);
              if (s) run("space.close", { id: s.id, confirmed: true });
              await ask({ op: "unworktree", path: tree.path }, tree.machine);
            }
            delete this.trees[pr.key];
            if (!this.demo) localStorage.setItem("trees", JSON.stringify(this.trees));
            done.push("worktree removed");
          } catch (e) {
            failed.push(`worktree kept: ${e?.message ?? e}`);
          }
        }
        this.busy = "";
        this.say([...done, ...failed].join("; "), cx, failed.length > 0);
      });
    };
    const items = [];
    if (canDelete && tree) items.push({ label: "Delete the branch and remove the worktree", run: clean(true, true) });
    if (canDelete) items.push({ label: `Delete the branch ${d.head} on GitHub`, run: clean(true, false) });
    if (tree) items.push({ label: "Remove the worktree (and close its space)", run: clean(false, true) });
    items.push({ label: "Leave everything", run: () => {} });
    this.showMenu({ title: `Merged #${d.number}. Clean up?`, items, at: 0 }, cx);
  }

  // ── worktrees ──────────────────────────────────────────────────────────

  // The worktree a PR is known to have: one made from here, or a space on
  // its branch in a worktree.
  treeOf(pr) {
    if (!pr) return null;
    const known = this.trees[pr.key];
    if (known) return known;
    if (this.demo) return null;
    for (const s of spaces()) {
      if (pr.branch && s.branch === pr.branch && /\/\.herdr\/worktrees\//.test(s.folder ?? "")) return { path: s.folder, machine: s.machine ?? null };
    }
    return null;
  }

  spaceAt(path, machine) {
    const inside = (p) => p === path || p?.startsWith(path + "/");
    return spaces().find((s) => (s.machine ?? null) === (machine ?? null) && inside(place(s)));
  }

  // The machines to look for a checkout on, the shown space's first, each
  // with the folders of its spaces.
  checkoutMachines() {
    const all = spaces();
    const active = all.find((s) => s.active);
    const order = [active?.machine ?? null, ...all.map((s) => s.machine ?? null), this.on || null];
    const out = [];
    for (const m of order) {
      if (out.some((o) => o.machine === m)) continue;
      out.push({ machine: m, dirs: [...new Set(all.filter((s) => (s.machine ?? null) === m).flatMap((s) => [place(s), s.folder]).filter(Boolean))] });
    }
    return out;
  }

  // Opens the PR's worktree in a space, made if there's none; start: with an
  // agent in it, asked to look at the PR (only a new one: an existing one's
  // agent may be busy).
  worktree(cx, start, clone = null) {
    const pr = this.cur;
    if (!pr) return;
    this.busy = clone ? `Cloning ${pr.repo}…` : start ? "Starting…" : "Opening its worktree…";
    this.menu = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (this.demo) {
          const res = await this.gh({ op: "worktree", pr: prID(pr) });
          this.trees[pr.key] = { path: res.path, machine: "build-1" };
          this.busy = "";
          return this.say(`${res.note}${start ? ", then start an agent on it" : ""}`, cx);
        }
        let res = null;
        let where = null;
        let missing = null;
        for (const c of clone ? [clone] : this.checkoutMachines()) {
          try {
            res = await job({ op: "worktree", pr: prID(pr), dirs: c.dirs, clone: Boolean(clone) }, c.machine);
            where = c;
            break;
          } catch (e) {
            if (!e?.noCheckout) throw e;
            missing ??= { ...e.noCheckout, machine: c.machine, dirs: c.dirs };
          }
        }
        this.busy = "";
        if (!res) {
          return this.showMenu({
            title: `No checkout of ${missing.repo} on any machine with spaces.`,
            items: [
              { label: `Clone it into ${missing.dest}${missing.machine ? ` on ${missing.machine}` : ""}`, run: (cx) => this.worktree(cx, start, missing) },
              { label: "Cancel", run: () => {} },
            ],
            at: 0,
          }, cx);
        }
        this.trees[pr.key] = { path: res.path, machine: where.machine };
        localStorage.setItem("trees", JSON.stringify(this.trees));
        const s = this.spaceAt(res.path, where.machine);
        if (s) {
          run("space.select", { id: s.id });
          if (start) return this.say(`#${pr.number}'s worktree already had a space, so no prompt was sent: its agent may be busy.`, cx);
          return this.dismiss();
        }
        const spec = { folder: res.path };
        if (where.machine) spec.machine = where.machine;
        if (start) {
          const known = await knownAgents({ on: where.machine }).catch(() => []);
          const agent = known.find((a) => a.installed && a.key === "claude") ?? known.find((a) => a.installed);
          if (!agent) return this.say("Worktree made, but no agent is installed there to start.", cx, true);
          spec.argv = agent.run;
          if (res.created) spec.task = res.prompt;
        }
        run("space.new", spec);
        this.dismiss();
      } catch (e) {
        this.busy = "";
        this.say(String(e?.message ?? e), cx, true);
      }
    });
  }

  // ── its agents ─────────────────────────────────────────────────────────

  // What Claude's transcripts say about PRs, on each machine with agents.
  loadSessions(cx) {
    if (this.demo || (this.sessionsAt && Date.now() - this.sessionsAt < 30000)) return;
    this.sessionsAt = Date.now();
    const ms = new Set([null, ...agents().map((a) => machineOf(a.address))]);
    for (const m of ms) {
      cx.spawn(async (cx) => {
        try {
          const res = await ask({ op: "sessions" }, m);
          for (const [k, list] of Object.entries(res.prs)) {
            this.sessions[k] = [...(this.sessions[k] ?? []).filter((s) => s.machine !== m), ...list.map((s) => ({ ...s, machine: m }))];
          }
          cx.notify();
        } catch {}
      });
    }
  }

  // A PR's agents: the Claude sessions that opened or worked on it (in a
  // pane, or to resume), and those in a pane on its branch.
  agentsOf(pr) {
    if (this.demo) return demoAgents(pr.key, Date.now());
    const out = [];
    const ps = new Map(panes().map((p) => [p.pane, p]));
    const live = agents();
    for (const s of this.sessions[pr.key] ?? []) {
      const a = live.find((a) => machineOf(a.address) === s.machine && ps.get(a.pane)?.cwd === s.cwd);
      if (a && out.some((o) => o.address === a.address)) continue;
      if (a) out.push({ name: a.title || a.tab_name, status: a.status, machine: s.machine, part: s.part, address: a.address });
      else out.push({ name: s.title || `Claude session ${s.session.slice(0, 8)}`, status: null, machine: s.machine, part: s.part, resume: s });
    }
    for (const a of live) {
      if (out.some((o) => o.address === a.address)) continue;
      const p = ps.get(a.pane);
      if (pr.branch && p?.branch === pr.branch) out.push({ name: a.title || a.tab_name, status: a.status, machine: machineOf(a.address), part: "on its branch", address: a.address });
    }
    return out;
  }

  goToAgent(a, cx) {
    if (this.demo) return this.say(`Demo: would go to ${a.name}`, cx);
    this.dismiss();
    if (a.address) return run("agent.focus", { terminal: a.address });
    // A session with no pane: resumed where it ran.
    const spec = { folder: a.resume.cwd, argv: ["claude", "--resume", a.resume.session] };
    if (a.machine) spec.machine = a.machine;
    run("space.new", spec);
  }

  // Its Linear issue, on its screen in the Linear mod; esc there comes back
  // to this PR.
  openIssue(key, cx) {
    if (!key) return;
    if (!this.linear) return this.say(`${key}: herdr-linear's mod opens it here, when it's installed.`, cx);
    const pr = this.cur;
    this.dismiss();
    openOverlay({ mod: "linear", kind: "dialog", width: 0.8, height: 0.8, props: {
      issue: { key }, back: "github", demo: this.demo || undefined,
      backTo: { mod: "github", label: `#${pr.number}`, props: { pr: { host: pr.host, repo: pr.repo, number: pr.number }, demo: this.demo || undefined, backTo: this.backTo ?? undefined, back: this.from ?? undefined } },
    } });
  }

  agentsKey(cx) {
    const list = this.agentsOf(this.cur);
    if (!list.length) return this.say("No agents on it yet: w opens its worktree, s starts one there.", cx);
    if (list.length === 1) return this.goToAgent(list[0], cx);
    this.showMenu({
      title: `#${this.cur.number}'s agents`,
      items: [...list.map((a) => ({ label: `${a.name} · ${a.part}${a.resume ? " · resume" : ""}`, run: (cx) => this.goToAgent(a, cx) })), { label: "Cancel", run: () => {} }],
      at: 0,
    }, cx);
  }

  // ── keys ───────────────────────────────────────────────────────────────

  menuKey(k, cx) {
    const m = this.menu;
    const n = m.items.length;
    if (k === "down") m.at = (m.at + 1) % n;
    else if (k === "up") m.at = (m.at + n - 1) % n;
    else if (k === "enter") this.choose(m.items[m.at], cx);
    else if (!m.confirm && /^[1-9]$/.test(k) && Number(k) <= n) this.choose(m.items[Number(k) - 1], cx);
    else return false;
    return true;
  }

  choose(item, cx) {
    this.menu = null;
    item.run(cx);
    cx.notify();
  }

  // One key, from on_key_down or a command (tab, shift-tab): whether it
  // was this screen's.
  press(k, cx) {
    if ((k === "tab" || k === "shift-tab") && !this.once(k)) return true;
    if (this.screen === "pr" && this.cur) return this.prKey(k, cx);
    if (this.menu) return this.menuKey(k, cx);
    if (k === "tab" || k === "shift-tab") {
      this.step(k === "tab" ? 1 : -1, cx);
      return true;
    }
    return this.listKey(k, cx);
  }

  // A key on the PR screen, by its tab (prkeys.js has the rules). The Files
  // tab's view has every key first; what it declines never reaches a menu
  // or the PR's actions.
  prKey(k, cx) {
    if (this.prTab === "files" && this.files?.key(k, cx)) return true;
    switch (prRoute(k, this.prTab, Boolean(this.menu))) {
      case "menu":
        return this.menuKey(k, cx);
      case "tab":
        this.setPrTab(tabFor(k, this.prTab), cx);
        return true;
      case "back":
        this.back(cx);
        return true;
      case "link":
        this.open(this.tabLink(), cx);
        return true;
      case "copy":
        this.copy(this.tabLink(), cx);
        return true;
      case "reload":
        this.reload(cx);
        return true;
      case "action":
        return this.prAction(k, cx);
      case "checks":
        return this.checksKey(k, cx);
      case "ignore":
        return true;
      default:
        return false;
    }
  }

  // Overview's keys: what changes the PR, or leaves for its worktree,
  // agents or issue.
  prAction(k, cx) {
    const pr = this.cur;
    switch (k) {
      case "w":
        this.worktree(cx, false);
        break;
      case "s":
        this.worktree(cx, true);
        break;
      case "m":
        this.mergeMenu(cx);
        break;
      case "d":
        this.toggleDraft(cx);
        break;
      case "a":
        this.agentsKey(cx);
        break;
      case "l":
        this.openIssue(issueOf(pr, this.detail?.body), cx);
        break;
      default:
        return false;
    }
    return true;
  }

  // The Checks tab's keys: choose a check, open its run.
  checksKey(k, cx) {
    const cs = this.shownChecks();
    if (!cs.length) return true;
    if (k === "enter") {
      const c = cs[this.checkAt];
      if (c?.url) this.open(c.url, cx);
      else this.say(`${c?.name ?? "That check"} has no run to open.`, cx);
      return true;
    }
    const d = k === "down" || k === "j" ? 1 : -1;
    this.checkAt = Math.max(0, Math.min(cs.length - 1, this.checkAt + d));
    this.checkScroll.scroll_to_item(this.checkAt);
    return true;
  }

  // What o opens and y copies: the PR, its checks, its files on GitHub.
  tabLink() {
    const url = this.cur?.url;
    if (!url) return "";
    if (this.prTab === "checks") return `${url}/checks`;
    if (this.prTab === "files") return this.files?.link() ?? `${url}/files`;
    return url;
  }

  listKey(k, cx) {
    const n = this.pickingRepo() ? this.shownRepos().length : this.shown?.length ?? 0;
    if (k === "down" && n) (this.at = Math.min(n - 1, this.at + 1)), this.follow();
    else if (k === "up" && n) (this.at = Math.max(0, this.at - 1)), this.follow();
    else if (k === "pagedown" && n) (this.at = Math.min(n - 1, this.at + 6)), this.follow();
    else if (k === "pageup" && n) (this.at = Math.max(0, this.at - 6)), this.follow();
    else if (k === "right" && !this.filter) this.step(1, cx);
    else if (k === "left" && !this.filter) this.step(-1, cx);
    else return false;
    const l = this.lists[this.tab];
    if (!this.pickingRepo() && l?.next && this.at >= n - 4) this.load(this.tab, cx, true);
    return true;
  }

  // ── drawing ────────────────────────────────────────────────────────────

  // A PR's card in a list: its icon, title, number, repo and when; then its
  // branch, checks, review, size, auto-merge, queue, labels and agents.
  card(o, pr, on, i) {
    const g = groupOf(pr.group);
    const look = prLook(o, pr);
    const ag = this.agentsOf(pr);
    const chips = [];
    const id = (k) => `${k}-${pr.key}`;
    chips.push(chip(o, id("br"), [icon("branch", o.dim, 13), pr.head], { mono: true }));
    if (pr.checks) {
      const c = checkLook(o, pr.checks);
      chips.push(chip(o, id("ck"), [icon(c.icon, c.color, 12), `checks ${c.word}`], { color: c.color }));
    }
    if (pr.conflicts) chips.push(chip(o, id("cf"), ["conflicts"], { color: o.fix }));
    if (pr.review === "APPROVED") chips.push(chip(o, id("rv"), [icon("check", o.review, 12), "approved"], { color: o.review }));
    else if (pr.review === "CHANGES_REQUESTED") chips.push(chip(o, id("rv"), ["changes requested"], { color: o.fix }));
    else if (pr.review === "REVIEW_REQUIRED") chips.push(chip(o, id("rv"), ["review required"]));
    chips.push(chip(o, id("sz"), [div().text_color(o.review).child(`+${pr.additions}`), div().text_color(o.fix).child(`−${pr.deletions}`)]));
    if (pr.auto) chips.push(chip(o, id("am"), [`auto-merge · ${pr.auto.toLowerCase()}`], { color: o.accent }));
    if (pr.queue) chips.push(chip(o, id("q"), [icon("queue", o.accent, 12), `queued · ${pr.queue.position}`], { color: o.accent }));
    for (const l of pr.labels.slice(0, 3)) chips.push(chip(o, id(`lb${l.name}`), [div().w(7).h(7).rounded_full().bg(`#${l.color}`), l.name]));
    if (ag.length) {
      const busy = ag.find((a) => a.status === "working");
      chips.push(chip(o, id("ag"), [busy ? icon("work", o.work, 12).spin(1100) : icon("person", o.muted, 12), ag.length === 1 ? ag[0].name : `${ag.length} agents`]));
    }
    if (this.treeOf(pr)) chips.push(chip(o, id("wt"), [icon("worktree", o.dim, 12), "worktree"]));
    return h_flex()
      .id(`pr-${pr.key}`)
      .flex_none()
      .items_stretch()
      .rounded(10)
      .overflow_hidden()
      .when(on, (el) => el.bg(o.raised).shadow_md())
      .when(!on, (el) => el.hover((el) => el.bg(o.raised)))
      .cursor_pointer()
      .h(CARD_H - 2)
      // The chosen one's mark, in its group's colour.
      .child(v_flex().w(3).ml(12).flex_none().pt(12).pb(12).child(div().flex_1().min_h(16).rounded(2).when(on, (el) => el.bg(o[g.tone]))))
      .child(
        h_flex().flex_1().min_w(0).items_start().gap(10).pl(8).pr(14).pt(11).pb(12)
          .child(div().flex_none().pt(1).child(icon(look.icon, look.color)))
          .child(
            v_flex().flex_1().min_w(0).gap(7)
              .child(
                h_flex().gap(8).items_center()
                  .child(div().min_w(0).truncate().text_size(14.5).font_semibold().text_color(o.fg).child(pr.title))
                  .child(div().flex_none().font_family(MONO).text_size(12).text_color(o.muted).child(`#${pr.number}`))
                  .child(div().flex_1())
                  .child(div().flex_none().text_size(12).text_color(o.dim).child(`${pr.repo.split("/")[1]} · ${pr.author} · ${ago(pr.updated)}`)),
              )
              // One line of chips, so every card is as tall: the list keeps
              // the chosen one in sight by their heights.
              .child(h_flex().gap(6).items_center().overflow_hidden().children(chips)),
          ),
      );
  }

  // A tab's name: the repo tab's is its repo's; short, where it's tight.
  tabLabel(tb, short) {
    if (tb.id === "repo" && this.repo) return this.repo.name;
    return short ? tb.short ?? tb.label : tb.label;
  }

  heading(o, g, n) {
    return h_flex().flex_none().h(HEADING_H).px(10).pt(8).gap(8).items_center().text_size(10.5)
      .child(div().font_semibold().text_color(o[g.tone]).child(g.label.toUpperCase()))
      .child(div().font_medium().text_color(o.dim).child(String(n)))
      .child(div().flex_1().h(1).bg(o.line));
  }

  tabBar(t, o) {
    return h_flex().flex_none().gap(4).items_center()
      .children(TABS.map((tb) => {
        const on = tb.id === this.tab;
        const l = this.lists[tb.id];
        const label = this.tabLabel(tb, this.width < 700);
        const n = l?.loaded && (tb.id !== "repo" || this.repo) ? `${l.prs.length}${l.next ? "+" : ""}` : "";
        return h_flex().id(`tab-${tb.id}`).flex_none().h(28).px(10).gap(7).items_center().rounded(7).cursor_pointer().text_size(12.5)
          .when(on, (el) => el.bg(o.raised).shadow_sm())
          .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click((_e, cx) => {
            this.tab = tb.id;
            localStorage.setItem("tab", tb.id);
            this.at = 0;
            this.picking = false;
            cx.notify();
          })
          // Its icon, the spinner in its place while it loads: the same
          // size, so the tabs never move.
          .child(l?.loading ? icon("work", o.accent, 12).spin(1100) : icon(tb.icon, on ? o.fg : o.dim, 12))
          .child(div().when(on, (el) => el.font_semibold()).when(!on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(label))
          .child(countPill(o, n, on));
      }))
      .child(div().flex_1())
      .when(this.tab === "repo", (el) => el.child(words(o, [[[this.picking && this.repo ? "Back to the repo" : "Change repo", o.accent, (cx) => {
        if (this.picking && this.repo) {
          this.picking = false;
          return cx.notify();
        }
        this.showRepos(cx);
      }]]], "chg")));
  }

  note(o, text, color) {
    return div().px(14).py(10).text_size(12.8).text_color(color ?? o.dim).child(text);
  }

  // The list: notes about it (an error, empty, loading), and its entries,
  // headings and rows (pull requests, or repos to pick), each of a fixed
  // height, for the virtual list that keeps the chosen row in sight.
  listBody(o) {
    const notes = [];
    const entries = [];
    const after = [];
    this.entryOf = [];
    if (this.pickingRepo()) {
      const rs = this.shownRepos();
      this.at = Math.max(0, Math.min(this.at, rs.length - 1));
      if (!this.repos) notes.push(this.note(o, "The shown space isn't in a GitHub repo. Change repo to pick one."));
      else if (this.repos.loading) notes.push(this.note(o, "Loading your repos…"));
      else if (this.repos.error) notes.push(this.note(o, this.repos.error, o.fix));
      rs.forEach((r, i) => {
        const on = i === this.at;
        this.entryOf[i] = entries.length;
        entries.push({ key: `repo-${r.repo}`, row: i, h: REPO_H, el: () => div().h(REPO_H).pb(2).child(
          h_flex().h(REPO_H - 2).px(14).gap(10).items_center().rounded(8).cursor_pointer()
            .when(on, (el) => el.bg(o.raised))
            .when(!on, (el) => el.hover((s) => s.bg(o.raised)))
            .child(icon("pr", o.dim, 14))
            .child(div().flex_1().truncate().font_family(MONO).text_size(12.5).text_color(o.fg).child(r.repo))
            .child(div().flex_none().text_size(11.5).text_color(o.dim).child(`pushed ${ago(r.pushed)}`))) });
      });
      return { notes, entries, after };
    }
    const l = this.lists[this.tab];
    const shown = this.shown;
    if (l?.error) notes.push(this.note(o, l.error, o.fix));
    else if (!shown.length) {
      const empty = this.err ? "" : !l?.loaded || l.loading ? "Loading…" : this.filter ? "No pull request matches." : this.tab === "review" ? "Nothing waiting on your review." : "No open pull requests.";
      if (empty) notes.push(this.note(o, empty));
    }
    let last = null;
    shown.forEach((pr, i) => {
      if (pr.group !== last) {
        const g = groupOf(pr.group);
        const n = shown.filter((p) => p.group === pr.group).length;
        entries.push({ key: `h-${pr.group}`, h: HEADING_H, el: () => this.heading(o, g, n) });
        last = pr.group;
      }
      this.entryOf[i] = entries.length;
      entries.push({ key: `pr-${pr.key}`, row: i, h: CARD_H, el: () => div().h(CARD_H).pb(2).child(this.card(o, pr, i === this.at, i)) });
    });
    if (l?.next) after.push(div().px(14).py(6).text_size(12).text_color(o.dim).child(l.loading ? "Loading more…" : "More below: ↓ loads them"));
    if (l?.warning) after.push(div().px(14).py(6).text_size(11.5).text_color(o.dim).child(l.warning));
    return { notes, entries, after };
  }

  listView(o) {
    const { notes, entries, after } = this.listBody(o);
    return v_flex().flex_1().min_h(0).gap(2)
      .children(notes)
      .when(entries.length > 0, (el) => el.child(
        div().relative().h(Math.min(LIST_H, entries.reduce((h, e) => h + e.h, 0))).min_h(0).flex_shrink(1)
          .child(v_virtual_list("gh-rows", entries.length, entries.map((e) => e.h), (i) => entries[i].key,
            (range) => entries.slice(range.start, range.end).map((e) => e.el())).track_scroll(this.scroll).size_full()
            // A click chooses a row; on the chosen one, opens it.
            .on_item_click((key, cx) => {
              const e = entries.find((x) => x.key === key);
              if (e?.row == null) return;
              if (e.row === this.at) return this.enter(cx);
              this.at = e.row;
              cx.notify();
            }))
          .child(Scrollbar.vertical("gh-rows").absolute().inset_0())))
      .children(after);
  }

  // Keeps the chosen row in sight: the first, with its heading.
  follow() {
    const e = this.entryOf?.[this.at];
    if (e == null) return;
    this.scroll.scroll_to_item(this.at === 0 ? 0 : e);
  }

  // The PR screen: what it is (state, title, author, branch, size), its
  // tabs, and the shown tab, every tab as tall so switching never jumps.
  prView(o) {
    const pr = this.cur;
    const d = this.detail;
    const look = prLook(o, pr);
    const stateWord = pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED" ? "Closed" : pr.draft ? "Draft" : pr.state ? "Open" : "";
    const now = Date.now();
    const from = this.direct && this.backTo?.label ? this.backTo.label : this.direct && this.from === "recap" ? "Recap" : this.tabLabel(TABS.find((x) => x.id === this.tab), true);
    const body = this.prTab === "checks" ? this.checksTab(o) : this.prTab === "files" ? this.files.view(o) : this.overviewTab(o);

    return v_flex().flex_1().min_h(0).gap(10)
      .child(
        h_flex().flex_none().gap(10).items_center()
          .child(h_flex().id("back").flex_none().h(24).px(8).gap(4).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(o.raised))
            .on_click((_e, cx) => this.back(cx))
            .child(icon("back", o.muted, 13))
            .child(div().text_size(12).text_color(o.muted).child(from)))
          .when(Boolean(stateWord), (el) => el.child(chip(o, "state", [icon(look.icon, look.color, 12), stateWord], { color: look.color })))
          .child(div().font_family(MONO).text_size(12.5).text_color(o.muted).child(`#${pr.number}`))
          .child(div().text_size(12.5).text_color(o.dim).child(pr.repo))
          .child(div().flex_1())
          .when(Boolean(pr.updated), (el) => el.child(div().text_size(12).text_color(o.dim).child(`updated ${ago(pr.updated, now)}`))),
      )
      .child(div().flex_none().text_size(17).font_semibold().text_color(o.fg).line_height(1.35).child(pr.title))
      .when(Boolean(d), (el) => el.child(
        h_flex().flex_none().gap(8).flex_wrap().items_center().text_size(12)
          .child(icon("person", o.dim, 13))
          .child(div().font_medium().text_color(o.fg).child(d.author))
          .child(chip(o, "head", [icon("branch", o.dim, 13), d.head], { mono: true }))
          .child(div().text_color(o.dim).child("→"))
          .child(chip(o, "base", [d.base], { mono: true }))
          .child(div().font_family(MONO).text_color(o.review).child(`+${d.additions}`))
          .child(div().font_family(MONO).text_color(o.fix).child(`−${d.deletions}`)),
      ))
      .child(this.prTabs(o))
      .child(v_flex().id("pr-tab").h(PR_BODY_H).min_h(0).flex_shrink(1).child(body));
  }

  // The PR screen's tabs, each with its key and, past Overview, its count.
  prTabs(o) {
    const d = this.detail;
    const counts = { checks: d ? String(d.checkList.length) : "", files: d ? String(d.files) : "" };
    return h_flex().flex_none().gap(4).items_center().border_b_1().border_color(o.line)
      .children(PR_TABS.map((tb, i) => {
        const on = tb.id === this.prTab;
        return h_flex().id(`prtab-${tb.id}`).flex_none().h(34).px(10).gap(7).items_center().cursor_pointer()
          .when(on, (el) => el.border_b_2().border_color(o.accent))
          .when(!on, (el) => el.hover((s) => s.bg(o.raised)))
          .on_click((_e, cx) => {
            this.setPrTab(tb.id, cx);
            this.keys.focus();
          })
          .child(cap(o, String(i + 1)))
          .child(div().text_size(12.5).when(on, (el) => el.font_semibold()).when(!on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(tb.label))
          .when(tb.id in counts, (el) => el.child(countPill(o, counts[tb.id], on)));
      }));
  }

  // What a tab shows before the PR's detail has come: loading, or why not.
  waiting(o) {
    return div().text_size(12.8).text_color(this.err ? o.fix : o.dim).child(this.err || "Loading…");
  }

  // Overview: whether it can merge, a strip of its checks, threads and
  // approvals, and its description; at the side, who's on it and what it's
  // linked to. Narrow, the side comes between.
  overviewTab(o) {
    const d = this.detail;
    if (!d) return this.waiting(o);
    const pr = this.cur;
    const wide = this.width >= 820;
    const main = v_flex().flex_1().min_w(0).min_h(0).gap(12)
      .child(this.readiness(o, d))
      .when(!wide, (el) => el.child(this.prSide(o, d, false)))
      .child(v_flex().id("pr-body").flex_1().min_h(0).overflow_y_scrollbar().pr(6)
        .child(TextView.markdown(`md-${pr.key}`, d.body).selectable(true).text_size(13).text_color(o.muted).on_link_click((url, cx) => this.open(url, cx))));
    if (!wide) return main;
    return h_flex().flex_1().min_h(0).gap(16).items_stretch().child(main).child(this.prSide(o, d, true));
  }

  // Whether it can merge, and if not why not, in its tone, with the way to;
  // under it, its checks, unresolved threads and approvals.
  readiness(o, d) {
    const toneIcon = { ok: "done", err: "fix", queue: "queue", merged: "merged" }[d.tone] ?? "idle";
    const checks = d.checkList;
    const count = (x) => checks.filter((c) => c.outcome === x).length;
    const approved = d.reviewers.filter((r) => r.state === "APPROVED").length;
    const changes = d.reviewers.filter((r) => r.state === "CHANGES_REQUESTED").length;
    const word = (text, color) => div().text_size(12).text_color(color).child(text);
    const part = (id, title, said, bar, last = false) => v_flex().id(id).flex_1().min_w(0).gap(7).px(12).py(9)
      .when(!last, (el) => el.border_r_1().border_color(o.line))
      .child(h_flex().gap(8).items_center().flex_wrap().child(div().text_size(12.5).font_semibold().text_color(o.fg).child(title)).children(said))
      .child(bar);
    const bar = (parts) => {
      const n = parts.reduce((s, [c]) => s + c, 0);
      return h_flex().w_full().h(6).rounded(3).overflow_hidden().bg(o.line)
        .children(parts.filter(([c]) => c > 0).map(([c, color]) => div().h_full().w(`${(100 * c) / n}%`).bg(color)));
    };
    return v_flex().flex_none().rounded(8).border_1().border_color(o.line).overflow_hidden()
      .child(
        h_flex().gap(10).items_center().px(12).py(8).bg(tint(toneColor(o, d.tone), 0.12))
          .child(icon(toneIcon, toneColor(o, d.tone), 15))
          .child(div().flex_1().min_w(0).font_medium().text_color(o.fg).child(d.ready))
          .when(Boolean(d.auto && d.state === "OPEN"), (el) => el.child(chip(o, "auto", [`auto-merge on · ${d.auto.toLowerCase()}`], { color: o.accent })))
          .when(d.state === "OPEN" && d.merge.length > 0, (el) => el.child(h_flex().id("merge-btn").flex_none().h(26).px(10).items_center().rounded(6)
            .bg(o.accent).cursor_pointer().hover((s) => s.opacity(0.85))
            .on_click((_e, cx) => this.mergeMenu(cx))
            .child(div().text_size(12).font_semibold().text_color(o.surface).child(d.queueOn ? "Merge queue…" : "Merge…")))),
      )
      .child(
        h_flex().items_stretch().border_t_1().border_color(o.line).bg(o.sunk)
          .child(part("ov-checks", "Checks",
            checks.length ? CHECK_ORDER.filter(count).map((x) => word(`${count(x)} ${checkLook(o, x).word}`, checkLook(o, x).color)) : [word("none", o.dim)],
            bar(CHECK_ORDER.map((x) => [count(x), checkLook(o, x).color]))))
          .child(part("ov-threads", "Threads",
            [d.threads ? word(`${d.threads} unresolved`, o.work) : word("none unresolved", o.dim)],
            bar([[d.threads, o.work]])))
          .child(part("ov-reviews", "Approvals",
            approved || changes
              ? [approved ? word(`${approved} approved`, o.review) : null, changes ? word(`${changes} want changes`, o.fix) : null].filter(Boolean)
              : [word("none yet", o.dim)],
            bar([[approved, o.review], [changes, o.fix], [d.reviewers.length - approved - changes, o.dim]]), true)),
      );
  }

  // Overview's side: its agents, reviewers, issue and worktree, labels.
  prSide(o, d, wide) {
    const pr = this.cur;
    const tree = this.treeOf(pr);
    const ag = this.agentsOf(pr);
    const issueKey = issueOf(pr, d.body);
    const section = (title, kids) => v_flex().flex_none().gap(6)
      .child(div().text_size(10.5).font_semibold().text_color(o.dim).child(title))
      .children(kids);
    const reviewer = (r) => chip(o, `rv-${r.name}`, [
      r.state === "APPROVED" ? icon("check", o.review, 12) : r.state === "CHANGES_REQUESTED" ? icon("cross", o.fix, 12) : r.state === "PENDING" ? icon("idle", o.work, 12) : null,
      r.name, r.state === "PENDING" ? "requested" : r.state === "COMMENTED" ? "commented" : null,
    ], { color: r.state === "APPROVED" ? o.review : r.state === "CHANGES_REQUESTED" ? o.fix : null });
    const sections = [
      ag.length ? section(`AGENTS ${ag.length}`, ag.slice(0, 4).map((a, i) => this.agentRow(o, a, i))) : null,
      section("REVIEWERS", [d.reviewers.length
        ? h_flex().gap(6).flex_wrap().children(d.reviewers.map(reviewer))
        : div().text_size(12).text_color(o.dim).child("none yet")]),
      section("LINKED", [h_flex().gap(6).flex_wrap().items_center()
        .when(Boolean(issueKey), (el) => el.child(chip(o, "issue", [icon("pr", o.accent, 12), issueKey, this.linear ? "in Linear" : null], { color: o.accent, click: (cx) => this.openIssue(issueKey, cx) })))
        .child(tree ? chip(o, "tree", [icon("worktree", o.accent, 12), "worktree"], { color: o.accent }) : div().text_size(12).text_color(o.dim).child("no worktree yet"))]),
      d.labels.length ? section("LABELS", [h_flex().gap(6).flex_wrap().children(d.labels.map((l) => chip(o, `lb-${l.name}`, [div().w(7).h(7).rounded_full().bg(`#${l.color}`), l.name])))]) : null,
    ].filter(Boolean);
    return v_flex().id("pr-side").flex_none().gap(14)
      .when(wide, (el) => el.w(SIDE_W).min_h(0).pl(16).border_l_1().border_color(o.line).overflow_y_scrollbar())
      .children(sections);
  }

  // One of its agents: what it's called and doing; how it's on the PR, where.
  agentRow(o, a, i) {
    return v_flex().id(`ag-${i}`).flex_none().px(6).py(4).gap(2).rounded(6).cursor_pointer().hover((s) => s.bg(o.raised))
      .on_click((_e, cx) => this.goToAgent(a, cx))
      .child(h_flex().gap(8).items_center()
        .child(a.status === "working" ? div().relative().flex_none().w(14).h(14).child(icon("work", o.work, 14).spin(1100))
          : a.status === "blocked" ? icon("need", o.need, 14) : icon(a.status ? "idle" : "person", o.dim, 14))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(o.fg).child(a.name))
        .child(div().flex_none().text_size(11.5).text_color(a.resume ? o.accent : o.dim).child(a.resume ? "resume" : a.status ?? "")))
      .child(div().pl(22).truncate().text_size(11.5).text_color(o.dim).child(`${a.part} · ${a.machine ?? "this computer"}`));
  }

  // Its checks, failing first, then running, passing, skipped.
  shownChecks() {
    const rank = (c) => {
      const i = CHECK_ORDER.indexOf(c.outcome);
      return i < 0 ? CHECK_ORDER.length : i;
    };
    return [...(this.detail?.checkList ?? [])].sort((a, b) => rank(a) - rank(b));
  }

  // Checks: every check, one chosen; enter or a click on the chosen one
  // opens its run.
  checksTab(o) {
    if (!this.detail) return this.waiting(o);
    const cs = this.shownChecks();
    if (!cs.length) return div().text_size(12.8).text_color(o.dim).child("No checks ran on it.");
    this.checkAt = Math.max(0, Math.min(this.checkAt, cs.length - 1));
    const count = (x) => cs.filter((c) => c.outcome === x).length;
    return v_flex().flex_1().min_h(0).gap(8)
      .child(h_flex().flex_none().gap(10).items_center().px(8)
        .child(h_flex().flex_none().w(140).h(6).rounded(3).overflow_hidden().bg(o.line)
          .children(CHECK_ORDER.filter(count).map((x) => div().h_full().w(`${(100 * count(x)) / cs.length}%`).bg(checkLook(o, x).color))))
        .children(CHECK_ORDER.filter(count).map((x) => div().text_size(12).text_color(checkLook(o, x).color).child(`${count(x)} ${checkLook(o, x).word}`))))
      .child(v_flex().id("checks").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.checkScroll)
        .children(cs.map((c, i) => {
          const on = i === this.checkAt;
          const cl = checkLook(o, c.outcome);
          return h_flex().id(`chk-${i}`).flex_none().h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer()
            .when(on, (el) => el.bg(tint(o.accent, 0.14)))
            .when(!on, (el) => el.hover((s) => s.bg(o.raised)))
            .on_click((_e, cx) => {
              if (on) return this.checksKey("enter", cx);
              this.checkAt = i;
              cx.notify();
            })
            .child(icon(cl.icon, cl.color, 13))
            .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(on ? o.fg : o.muted).child(c.name))
            .when(c.required, (el) => el.child(chip(o, `chk-req-${i}`, ["required"])))
            .child(div().flex_none().w(64).text_size(11.5).text_color(cl.color).child(cl.word));
        })));
  }

  // A menu is drawn, and has the keys, only off the PR screen or on its
  // Overview.
  menuShown() {
    return Boolean(this.menu) && (this.screen !== "pr" || this.prTab === "overview");
  }

  menuView(o) {
    const m = this.menu;
    return v_flex().flex_none().gap(2).p(10).rounded(10).border_1().border_color(o.line).bg(o.raised).shadow_md()
      .child(div().px(6).pb(6).text_size(13).font_semibold().text_color(o.fg).child(m.title))
      .children(m.items.map((it, i) => {
        const on = i === m.at;
        return h_flex().id(`mi-${i}`).h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer()
          .when(on, (el) => el.bg(tint(o.accent, 0.18)))
          .when(!on, (el) => el.hover((s) => s.bg(o.sunk)))
          .on_click((_e, cx) => this.choose(it, cx))
          .when(!m.confirm, (el) => el.child(div().flex_none().w(14).font_family(MONO).text_size(11.5).text_color(o.dim).child(String(i + 1))))
          .child(div().text_size(13).when(on, (el) => el.font_medium()).text_color(on ? o.fg : o.muted).child(it.label));
      }));
  }

  footer(o) {
    const k = (keys, label, fn, id) => key(o, keys, label, fn, id);
    if (this.menuShown()) {
      return [
        k(["↑", "↓"], "choose", () => {}, "f-ch"),
        k(["enter"], "do it", (cx) => this.choose(this.menu.items[this.menu.at], cx), "f-go"),
        k(["esc"], "cancel", (cx) => this.escape(cx), "f-esc"),
      ];
    }
    if (this.screen === "pr") {
      const tabs = k(["1", "2", "3"], "tabs", (cx) => this.setPrTab(tabFor("tab", this.prTab), cx), "f-tabs");
      const back = k(["esc"], "back", (cx) => this.escape(cx), "f-esc");
      if (this.prTab === "files") return [...this.files.footer(k), tabs, back];
      if (this.prTab === "checks") {
        return [
          k(["↑", "↓"], "choose", () => {}, "f-ch"),
          k(["enter"], "open its run", (cx) => this.checksKey("enter", cx), "f-go"),
          k(["o"], "GitHub", (cx) => this.open(this.tabLink(), cx), "f-o"),
          k(["y"], "copy link", (cx) => this.copy(this.tabLink(), cx), "f-y"),
          tabs,
          back,
        ];
      }
      return [
        k(["w"], "worktree", (cx) => this.worktree(cx, false), "f-w"),
        k(["s"], "start an agent", (cx) => this.worktree(cx, true), "f-s"),
        k(["m"], "merge", (cx) => this.mergeMenu(cx), "f-m"),
        k(["d"], this.detail?.draft ? "ready for review" : "draft", (cx) => this.toggleDraft(cx), "f-d"),
        k(["a"], "agents", (cx) => this.agentsKey(cx), "f-a"),
        ...(issueOf(this.cur, this.detail?.body) ? [k(["l"], "issue", (cx) => this.openIssue(issueOf(this.cur, this.detail?.body), cx), "f-l")] : []),
        k(["o"], "GitHub", (cx) => this.open(this.cur.url, cx), "f-o"),
        k(["y"], "copy link", (cx) => this.copy(this.cur.url, cx), "f-y"),
        tabs,
        back,
      ];
    }
    return [
      k(["↑", "↓"], "choose", () => {}, "f-ch"),
      k(["enter"], "open", (cx) => this.enter(cx), "f-go"),
      k(["←", "→"], "tabs", (cx) => this.step(1, cx), "f-tab"),
      k(["esc"], "close", (cx) => this.escape(cx), "f-esc"),
    ];
  }

  render() {
    const t = theme();
    const o = tones(t);
    this.shown = this.shownList();
    if (this.screen === "list" && !this.pickingRepo()) this.at = Math.max(0, Math.min(this.at, this.shown.length - 1));
    const summary = this.demo ? "Demo · made-up org" : this.login ? `${this.login}${this.on ? ` · on ${this.on}` : ""}` : "";
    const note = this.busy || this.err || this.flash;
    const noteColor = this.busy ? o.accent : this.err ? o.fix : o.muted;
    const pr = this.screen === "pr" && this.cur;

    return v_flex()
      .id("github")
      .w_full()
      .min_h(0)
      .p(16)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      // The keyboard: the filter's, in the list (as Recap's), so ↑ ↓ reach the
      // list through it; on a screen without one, the popup's own.
      .when(Boolean(pr), (el) => el.track_focus(this.keys))
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 20) {
          this.width = size.width;
          cx.notify();
        }
      })
      .on_key_down((e, cx) => {
        const k = e.keystroke;
        if (k === "escape") this.escape(cx);
        else if (!this.press(k, cx)) return;
        cx.stop_propagation();
        cx.notify();
      })
      .when(!pr, (el) => el
        .child(
          h_flex().h(36).flex_none().px(12).gap(10).items_center().rounded(9).border_1().border_color(o.line).bg(o.sunk)
            .child(icon("search", o.dim, 15))
            .child(Input.new(this.input).flex_1().h_full().text_size(13).text_color(o.fg))
            .child(div().flex_none().text_size(12).text_color(o.muted).child(summary)),
        )
        .child(this.tabBar(t, o))
        .child(this.listView(o)))
      .when(Boolean(pr), (el) => el.child(this.prView(o)))
      .when(this.menuShown(), (el) => el.child(this.menuView(o)))
      .when(Boolean(note), (el) => el.child(h_flex().flex_none().gap(8).items_center()
        .when(Boolean(this.busy), (el) => el.child(icon("work", o.accent, 12).spin(1100)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(noteColor).child(note))))
      .child(h_flex().flex_none().gap(14).flex_wrap().items_center().pt(8).border_t_1().border_color(o.line).children(this.footer(o)));
  }
}
