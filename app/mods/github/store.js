// The popup's cache files on disk (the rules are cache.js's): read when the
// popup opens or a PR is, written one at a time per copy with herdr's
// compare-and-swap, and never under `herdr-app check`, which runs init for
// real.
import { appHome, readTextFile, writeTextFile, checking } from "herdr";
import { parse, writeWith, serial } from "./cache.js";

const io = { read: (path) => readTextFile(path), write: (path, text, expected) => writeTextFile(path, text, expected) };

// One per copy of the popup: copies share the module, not their queues.
export class Store {
  constructor() {
    this.paths = { lists: `${appHome()}/github-cache.json`, details: `${appHome()}/github-details.json` };
    this.queue = serial();
  }

  // The file of `kind` ("lists", "details"); an empty one if it's missing or bad.
  async read(kind) {
    return parse(await readTextFile(this.paths[kind]).catch(() => null), kind);
  }

  // A patch (cache.js applyPatch) onto the file; whether it was written.
  write(kind, patch) {
    if (checking()) return Promise.resolve(false);
    return this.queue(() => writeWith(io, this.paths[kind], kind, patch, Date.now));
  }
}
