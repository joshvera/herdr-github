// What the Files tab's changes act on. Every one goes through
// FilesView.send (files.js): x (resolve), shift-d y (deleteComment), the
// composer (sendDraft), shift-s (sendDialog) and v (toggleViewed). Each
// builds its request from the Files tab's own answers: the head from
// `files`, the review id and count from `files`/`threads`, the PR from its
// identity (prID). None reads the Overview's `detail`, which may be cached,
// so none needs main's mayAct guard (Instant open). A change that starts
// reading `detail` here fails this test: guard that path with mayAct, then
// change the test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const filesSide = ["files.js", "dialog.js", "compose.js", "drafts.js", "sent.js", "follow.js", "reviewkeys.js"];

test("the Files tab's changes never act on the Overview's (maybe cached) detail", () => {
  for (const name of filesSide) {
    const src = readFileSync(new URL(`../${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(src, /\bdetail\b/, `${name} reads detail: guard its sends with mayAct`);
  }
});
