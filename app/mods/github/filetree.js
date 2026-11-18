// The Files tab's tree: a PR's changed files under their folders, a folder
// that holds only one folder joined to it ("Sources/Sync"), as GitHub draws
// them. No imports, so it can be run on its own.
//
//   Package.swift                 file   depth 0
//   Sources/Sync                  dir    depth 0   (Sources held only Sync)
//     ConflictMarkers.swift       file   depth 1
//     ThreeWay.swift              file   depth 1
//
// Files keep the order they came in (GitHub's, path order) within their
// folder; the rows' order is the order ] and [ step through.

// Whether `path` matches a filter: every word of it, in any case.
export function matchesPath(path, query) {
  const hay = path.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

// The rows of the tree for `files` (each `{ path, … }`): `{ kind: "dir",
// name, depth, key }` and `{ kind: "file", file, name, depth, key }`.
export function treeRows(files) {
  const root = { dirs: new Map(), kids: [] };
  for (const file of files) {
    const parts = file.path.split("/");
    const name = parts.pop();
    let node = root;
    for (const part of parts) {
      let next = node.dirs.get(part);
      if (!next) {
        next = { name: part, dirs: new Map(), kids: [] };
        node.dirs.set(part, next);
        node.kids.push(next);
      }
      node = next;
    }
    node.kids.push({ file, name });
  }
  const rows = [];
  const walk = (node, depth, prefix) => {
    for (const kid of node.kids) {
      if (kid.file) {
        rows.push({ kind: "file", file: kid.file, name: kid.name, depth, key: `f:${kid.file.path}` });
        continue;
      }
      // A folder that holds one folder and nothing else is drawn as one.
      let dir = kid;
      let name = dir.name;
      while (dir.kids.length === 1 && !dir.kids[0].file) {
        dir = dir.kids[0];
        name += `/${dir.name}`;
      }
      const path = prefix + name;
      rows.push({ kind: "dir", name, depth, key: `d:${path}` });
      walk(dir, depth + 1, `${path}/`);
    }
  };
  walk(root, 0, "");
  return rows;
}

// A file's status as one letter, and the tone it's drawn in.
export function statusMark(status) {
  switch (status) {
    case "added":
      return { letter: "A", tone: "review", word: "added" };
    case "deleted":
      return { letter: "D", tone: "fix", word: "deleted" };
    case "renamed":
      return { letter: "R", tone: "accent", word: "renamed" };
    case "copied":
      return { letter: "C", tone: "accent", word: "copied" };
    case "changed":
      return { letter: "T", tone: "muted", word: "type changed" };
    default:
      return { letter: "M", tone: "work", word: "modified" };
  }
}
