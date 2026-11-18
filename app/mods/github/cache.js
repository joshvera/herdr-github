// The popup's cache, as data: what the two files hold, whose they are, how
// two copies' writes combine, how a write retries, and the rules for what
// a cached thing may replace or allow. No imports, so the rules can be run
// on their own (test/cache.test.mjs); store.js reads and writes the files.
//
//   a copy's answer ──► patch { who, lists | repos | spaces | details }
//                         │
//        read file ──► parse (bad or old version: empty) ──► apply patch
//                         │      same who: union, newer `saved` wins
//                         │      other who: newer `who.at` wins whole file
//                         ▼
//                       prune (age, count, bytes) ──► write if unchanged
//                                                     since read, else again
//
// Times (`saved`, `who.at`, a detail's `at`) are ms since the epoch: when
// the request that answered was sent (`saved`), or when status said who
// (`who.at`).

export const VERSION = 2;

export const LIMITS = {
  details: 50,
  // readTextFile stops at 1 MiB; a file it can't read can't be rewritten
  // with compare-and-swap, so each file stays well under.
  detailBytes: 600 * 1024,
  listBytes: 400 * 1024,
  // A merged or closed PR's detail, once this old, is dropped.
  doneAfter: 24 * 3600 * 1000,
  repos: 30,
  spaces: 30,
};

const MAPS = { lists: ["lists", "repos", "spaces"], details: ["details"] };

export function empty(kind, who = null) {
  const doc = { version: VERSION, who };
  for (const m of MAPS[kind]) doc[m] = {};
  return doc;
}

// A file's text as a document of `kind` ("lists" or "details"). Anything
// else (missing, unparseable, another version) is an empty one: the cache
// is a convenience, never an error.
export function parse(text, kind) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return empty(kind);
  }
  if (!raw || typeof raw !== "object" || raw.version !== VERSION) return empty(kind);
  const doc = empty(kind, parseWho(raw.who));
  for (const m of MAPS[kind]) {
    for (const [k, e] of Object.entries(raw[m] ?? {})) {
      if (e && typeof e === "object" && Number.isFinite(e.saved)) doc[m][k] = e;
    }
  }
  return doc;
}

function parseWho(w) {
  if (!w || typeof w !== "object" || typeof w.machine !== "string" || !Array.isArray(w.hosts) || !Number.isFinite(w.at)) return null;
  const hosts = w.hosts.filter((h) => typeof h?.host === "string" && typeof h?.login === "string" && h.login);
  return hosts.length ? { machine: w.machine, hosts, at: w.at } : null;
}

// ── who ────────────────────────────────────────────────────────────────────

// Who a status answer from `machine` ("" for this computer) says is signed
// in: each host with a login. Null when no host has one.
export function whoOf(machine, hosts, at) {
  const signed = (hosts ?? [])
    .filter((h) => h?.host && h.login)
    .map((h) => ({ host: String(h.host).toLowerCase(), login: String(h.login) }))
    .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
  return signed.length ? { machine: machine ?? "", hosts: signed, at } : null;
}

// Whether two whos can be the same account: the same machine, and no host
// signed in as someone else. A host that one of them lacks (it answered
// with an error, which is how both signed out and offline look) is unknown,
// not different: a flaky host shouldn't throw the cache away.
export function sameWho(a, b) {
  if (!a || !b || a.machine !== b.machine) return false;
  const logins = new Map(a.hosts.map((h) => [h.host, h.login]));
  return b.hosts.every((h) => !logins.has(h.host) || logins.get(h.host) === h.login);
}

// ── writes ─────────────────────────────────────────────────────────────────

// A copy's write onto what the file holds now: the entries it produced,
// under the who it confirmed. Returns the document to write, or null when
// the write is out of date (the file belongs to an account confirmed after
// this copy's) or has no who to write under.
export function applyPatch(doc, patch, kind, now) {
  if (!patch?.who) return null;
  let out;
  if (doc.who && sameWho(doc.who, patch.who)) {
    out = { ...doc, who: patch.who.at >= doc.who.at ? patch.who : doc.who };
    for (const m of MAPS[kind]) out[m] = { ...doc[m] };
  } else {
    if (doc.who && doc.who.at > patch.who.at) return null;
    out = empty(kind, patch.who);
  }
  for (const m of MAPS[kind]) {
    for (const [k, e] of Object.entries(patch[m] ?? {})) {
      const cur = out[m][k];
      if (!cur || e.saved >= cur.saved) out[m][k] = e;
    }
  }
  return prune(out, kind, now);
}

// Caps, applied to the merged document: the oldest go first.
export function prune(doc, kind, now) {
  const out = { ...doc };
  if (kind === "details") {
    const live = Object.entries(doc.details).filter(([, e]) => !(isDone(e.d) && now - e.saved > LIMITS.doneAfter));
    out.details = newest(live, LIMITS.details, LIMITS.detailBytes);
    return out;
  }
  out.spaces = newest(Object.entries(doc.spaces), LIMITS.spaces, Infinity);
  // The lists' rows are what makes the file big: the repo lists give way
  // first, oldest first; Mine and Review stay.
  const fixed = utf8Length(JSON.stringify({ ...doc, repos: {}, spaces: out.spaces }));
  out.repos = newest(Object.entries(doc.repos), LIMITS.repos, LIMITS.listBytes - fixed);
  return out;
}

const isDone = (d) => d?.state === "MERGED" || d?.state === "CLOSED";

// At most `count` entries, newest first, together at most `bytes` long.
function newest(entries, count, bytes) {
  const out = {};
  let size = 0;
  for (const [k, e] of [...entries].sort((a, b) => b[1].saved - a[1].saved).slice(0, count)) {
    size += utf8Length(JSON.stringify(k)) + utf8Length(JSON.stringify(e)) + 2;
    if (size > bytes) break;
    out[k] = e;
  }
  return out;
}

// What a string takes in UTF-8, without TextEncoder (not every runtime here has it).
export function utf8Length(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c < 0xdc00 && i + 1 < s.length) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

// One write: read, apply the patch, write only if the file is still what
// was read (herdr's compare-and-swap), else read again; at most `tries`
// times, then give up. Never throws: whether it wrote. `io` is
// { read(path): text | null, write(path, text, expected) }.
export async function writeWith(io, path, kind, patch, now, tries = 3) {
  for (let i = 0; i < tries; i++) {
    let text;
    try {
      text = await io.read(path);
    } catch {
      return false;
    }
    const next = applyPatch(parse(text, kind), patch, kind, now());
    if (!next) return false;
    try {
      await io.write(path, JSON.stringify(next), text ?? null);
      return true;
    } catch {}
  }
  return false;
}

// Runs async jobs one after another, each after the last has settled.
export function serial() {
  let tail = Promise.resolve();
  return (job) => {
    const p = tail.then(job, job);
    tail = p.catch(() => {});
    return p;
  };
}

// Request stamps for one copy: the time, but never the same twice and never
// going back, so the later of two requests always has the larger stamp.
export function stamper(now) {
  let last = 0;
  return () => (last = Math.max(now(), last + 1));
}

// ── lists ──────────────────────────────────────────────────────────────────

// A tab's list from the cache, into `l` (in place: a load in flight holds
// it). Not over an answer that came live: that one is newer.
export function seed(l, kept) {
  if (!kept || (l.loaded && !l.cached)) return false;
  Object.assign(l, { prs: kept.prs ?? [], next: kept.next ?? "", loaded: true, cached: true, saved: kept.saved, error: "" });
  return true;
}

// The patch that keeps a tab's answer: the repo tab's under the repo it was
// asked for (`spec`, captured when the request was sent), not whichever is
// shown when it answers.
export function listPatch(who, tab, spec, l, saved) {
  const e = { prs: l.prs, next: l.next, saved };
  return tab === "repo" ? { who, repos: { [spec]: e } } : { who, lists: { [tab]: e } };
}

// ── the repo tab's repo, per space ─────────────────────────────────────────

// What the space's remotes say, against what was kept for it ({ repo, found,
// picked }): `found` is { kind: "found", spec } | { kind: "none" } (the
// folder has no GitHub remote) | { kind: "failed" } (no answer). The repo
// to show (null: none) and what to keep (null: nothing changes).
//
// A repo picked with "Change repo" stays until the folder's remote changes.
export function resolveRepo(kept, found) {
  const keptSpec = kept?.repo || null;
  if (found.kind === "failed") return { spec: keptSpec, keep: null };
  if (found.kind === "none") return { spec: null, keep: kept && !kept.repo && !kept.found ? null : { repo: "", found: "", picked: false } };
  if (kept?.picked && kept.found === found.spec) return { spec: keptSpec, keep: null };
  if (kept && !kept.picked && kept.repo === found.spec) return { spec: found.spec, keep: null };
  return { spec: found.spec, keep: { repo: found.spec, found: found.spec, picked: false } };
}

export function pickedRepo(kept, spec) {
  return { repo: spec, found: kept?.found ?? "", picked: true };
}

// ── a PR's detail on screen ────────────────────────────────────────────────

// Whether `next` ({ at, cached }) may replace the detail shown. A cached
// one (from the file, or warmed before the PR was opened) only fills an
// empty screen or replaces an older cached one; a live answer replaces any
// cached one, and a live one older than itself never.
export function takesOver(shown, next) {
  if (!shown) return true;
  if (next.cached) return Boolean(shown.cached) && next.at > shown.at;
  return Boolean(shown.cached) || next.at > shown.at;
}

// Whether what's shown may be acted on: a detail, and a live one. Every
// choice built from its fields (merge, draft, clean-up) asks first.
export function canAct(shown) {
  return Boolean(shown?.d) && !shown.cached;
}

// The quiet mark on something shown from the cache: being refreshed, or why
// it couldn't be, and how old it is. "" when it's live.
export function staleMark(cached, saved, error, loading = true) {
  if (!cached) return "";
  const from = Number.isFinite(saved) ? `from ${clock(saved)}` : "from before";
  if (error) return `${error} · showing ${from}`;
  return loading ? `Refreshing… · ${from}` : from;
}

function clock(ms) {
  const t = new Date(ms);
  return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
}
