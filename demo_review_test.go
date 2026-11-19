package main

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

const demoPR480 = `"pr":{"host":"github.com","repo":"halcyon/notes-app","number":480}`

// demoDo is a review action on a demo PR, as the mod sends it.
func demoDo(pr, do string, fields map[string]any) string {
	m := map[string]any{"op": "act", "do": do, "demo": true}
	for k, v := range fields {
		m[k] = v
	}
	data, _ := json.Marshal(m)
	return strings.TrimSuffix(string(data), "}") + "," + pr + "}"
}

func demoThreadByID(t *testing.T, a threadsAnswer, id string) fileThread {
	t.Helper()
	for _, th := range a.Threads {
		if th.ID == id {
			return th
		}
	}
	t.Fatalf("no thread %s in %+v", id, a.Threads)
	return fileThread{}
}

// The demo's files say whose PR it is, carry Sam's pending review and what
// Sam may do to each thread and comment: the threads differ.
func TestAppDemoReviewFields(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	got := demoFilesReq(t)
	if want := (prInfo{ID: "PR_demo_482", Mine: true, State: "open"}); got.PR != want {
		t.Fatalf("pr %+v", got.PR)
	}
	if want := (reviewInfo{ID: "PRR_demo_482", Comments: 1, Commit: demoHead(482)}); got.Review == nil || *got.Review != want {
		t.Fatalf("review %+v", got.Review)
	}
	open := demoThreadByID(t, got.threadsAnswer, "PRRT_demo_1")
	pendingOnly := demoThreadByID(t, got.threadsAnswer, "PRRT_demo_3")
	resolved := demoThreadByID(t, got.threadsAnswer, "PRRT_demo_2")
	if !open.CanResolve || open.CanUnresolve || pendingOnly.CanResolve || !resolved.CanUnresolve || resolved.CanResolve || !open.CanReply {
		t.Fatalf("permissions: open %+v, pending-only %+v, resolved %+v", open, pendingOnly, resolved)
	}
	jonas, sam := open.Comments[0], open.Comments[1]
	if jonas.Mine || jonas.CanEdit || !sam.Mine || !sam.CanEdit || !sam.CanDelete {
		t.Fatalf("comments %+v %+v", jonas, sam)
	}
	// Maria's PR: not Sam's, with Sam's pending review a commit behind.
	other := demoRunAs[filesAnswer](t, `{"op":"files","demo":true,`+demoPR480+`}`)
	if other.PR.Mine || other.Review == nil || other.Review.Commit != demoOldHead(480) || other.Review.Comments != 1 {
		t.Fatalf("#480 %+v %+v", other.PR, other.Review)
	}
}

// Each action changes the demo's saved state, and the next request (a new
// process, in life) sees it.
func TestAppDemoReviewActionsStay(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	head := demoHead(482)
	const engine = "Sources/Sync/SyncEngine.swift"

	c := demoRunAs[commentAnswer](t, demoDo(demoPR482, "comment", map[string]any{"head": head, "path": engine, "line": 142, "side": "right", "body": "Is 20s right?"}))
	if !c.OK || c.Thread == nil || c.Comment.Body != "Is 20s right?" || c.Comment.State != "pending" || c.Review == nil || c.Review.Comments != 2 {
		t.Fatalf("comment %+v", c)
	}
	files := demoFilesReq(t)
	if th := demoThreadByID(t, files.threadsAnswer, c.Thread.ID); th.Line != 142 || th.Side != "right" || th.Path != engine {
		t.Fatalf("the new thread %+v", th)
	}
	if files.Review.Comments != 2 {
		t.Fatalf("review %+v", files.Review)
	}

	r := demoRunAs[replyAnswer](t, demoDo(demoPR482, "reply", map[string]any{"thread": "PRRT_demo_1", "body": "Also: retries?"}))
	if !r.OK || r.Thread != "PRRT_demo_1" || r.Review.Comments != 3 || !r.Comment.Mine {
		t.Fatalf("reply %+v", r)
	}
	if res := demoRunAs[resolveAnswer](t, demoDo(demoPR482, "resolve", map[string]any{"thread": "PRRT_demo_1"})); !res.Resolved {
		t.Fatalf("resolve %+v", res)
	}
	if th := demoThreadByID(t, demoFilesReq(t).threadsAnswer, "PRRT_demo_1"); !th.Resolved || len(th.Comments) != 3 {
		t.Fatalf("after resolve %+v", th)
	}
	if res := demoRunAs[resolveAnswer](t, demoDo(demoPR482, "unresolve", map[string]any{"thread": "PRRT_demo_1"})); res.Resolved {
		t.Fatalf("unresolve %+v", res)
	}

	e := demoRunAs[editAnswer](t, demoDo(demoPR482, "edit", map[string]any{"comment": c.Comment.ID, "body": "Is 20s right?\nIt was 30."}))
	if !e.OK || e.Comment.Body != "Is 20s right?\nIt was 30." {
		t.Fatalf("edit %+v", e)
	}
	if th := demoThreadByID(t, demoFilesReq(t).threadsAnswer, c.Thread.ID); th.Comments[0].Body != "Is 20s right?\nIt was 30." {
		t.Fatalf("after edit %+v", th)
	}

	// Submitted: the pending comments are sent, and there's no pending review.
	s := demoRunAs[submitAnswer](t, demoDo(demoPR482, "submit", map[string]any{"reviewId": "PRR_demo_482", "count": 3, "event": "comment"}))
	if !s.OK || !strings.Contains(s.URL, "#pullrequestreview-") {
		t.Fatalf("submit %+v", s)
	}
	after := demoFilesReq(t)
	if after.Review != nil {
		t.Fatalf("still pending: %+v", after.Review)
	}
	for _, th := range after.Threads {
		for _, cm := range th.Comments {
			if cm.State == "pending" {
				t.Fatalf("a comment is still pending: %+v", cm)
			}
		}
	}
}

// What the demo refuses, as the binary or GitHub would; nothing changes.
func TestAppDemoReviewRefusals(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	head := demoHead(482)
	const engine = "Sources/Sync/SyncEngine.swift"
	comment := func(pr, h string, line int, body string) map[string]any {
		return appRun(t, demoDo(pr, "comment", map[string]any{"head": h, "path": engine, "line": line, "side": "right", "body": body}))
	}
	before := demoFilesReq(t)
	for name, got := range map[string]map[string]any{
		"empty body":     comment(demoPR482, head, 142, " \n "),
		"too long":       comment(demoPR482, head, 142, strings.Repeat("x", maxBody+1)),
		"not in diff":    comment(demoPR482, head, 999, "x"),
		"stale head":     comment(demoPR482, headA, 142, "x"),
		"older commit":   appRun(t, demoDo(demoPR480, "comment", map[string]any{"head": demoHead(480), "path": "Sources/Onboarding/Welcome.swift", "line": 15, "side": "right", "body": "x"})),
		"no permission":  appRun(t, demoDo(demoPR482, "resolve", map[string]any{"thread": "PRRT_demo_3"})),
		"not yours":      appRun(t, demoDo(demoPR482, "edit", map[string]any{"comment": "PRRC_demo_1", "body": "x"})),
		"not yours too":  appRun(t, demoDo(demoPR482, "delete", map[string]any{"comment": "PRRC_demo_1"})),
		"changed":        appRun(t, demoDo(demoPR482, "submit", map[string]any{"reviewId": "PRR_demo_482", "count": 5, "event": "comment"})),
		"pending exists": appRun(t, demoDo(demoPR482, "submit", map[string]any{"event": "comment", "body": "x"})),
		"own PR":         appRun(t, demoDo(demoPR482, "submit", map[string]any{"reviewId": "PRR_demo_482", "count": 1, "event": "approve"})),
	} {
		if got["error"] == nil || got["ok"] != nil || got["unknown"] != nil {
			t.Errorf("%s: %v", name, got)
		}
		switch name {
		case "stale head":
			if got["stale"] != true {
				t.Errorf("stale: %v", got)
			}
		case "older commit":
			if got["error"] != olderCommitMsg {
				t.Errorf("older commit: %v", got)
			}
		case "changed", "pending exists":
			if got["changed"] != true || got["review"].(map[string]any)["comments"] != float64(1) {
				t.Errorf("%s: %v", name, got)
			}
		}
	}
	if after := demoFilesReq(t); len(after.Threads) != len(before.Threads) || *after.Review != *before.Review {
		t.Fatalf("a refusal changed something: %+v", after.Review)
	}
}

// Sam's review grows while it's polled, as an agent drafting it would make
// it, then stops.
func TestAppDemoReviewGrows(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	poll := func() threadsAnswer { return demoRunAs[threadsAnswer](t, `{"op":"threads","demo":true,`+demoPR482+`}`) }
	var counts []int
	for i := 0; i < 4; i++ {
		counts = append(counts, poll().Review.Comments)
	}
	if want := []int{2, 3, 3, 3}; counts[0] != want[0] || counts[1] != want[1] || counts[3] != want[3] {
		t.Fatalf("counts %v", counts)
	}
	// What arrived is in `files` too, on rows of the diff.
	files := demoFilesReq(t)
	if files.Review.Comments != 3 || len(files.Threads) != 7 {
		t.Fatalf("%+v, %d threads", files.Review, len(files.Threads))
	}
	for _, th := range files.Threads {
		if th.Line == 0 {
			continue
		}
		d := demoDiff(t, files.Head, th.Path)
		if !hasRow(d.Rows, th.Line, diffSides[th.Side]) {
			t.Errorf("%s (%s:%d) matches no row", th.ID, th.Path, th.Line)
		}
	}
	// `threads` has no files.
	if raw := appRun(t, `{"op":"threads","demo":true,`+demoPR482+`}`); raw["files"] != nil {
		t.Fatalf("%v", raw)
	}
}

// "!unknown" answers unknown and changes nothing; "!unknown-sent" answers
// unknown and makes the change, as a send that got through unanswered.
func TestAppDemoUnknown(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	reply := func(body string) map[string]any {
		return appRun(t, demoDo(demoPR482, "reply", map[string]any{"thread": "PRRT_demo_1", "body": body}))
	}
	count := func() int { return len(demoThreadByID(t, demoFilesReq(t).threadsAnswer, "PRRT_demo_1").Comments) }
	if got := reply(demoUnknown); got["unknown"] != true || got["error"] == nil || got["ok"] != nil {
		t.Fatalf("%v", got)
	}
	if n := count(); n != 2 {
		t.Fatalf("!unknown made a change: %d comments", n)
	}
	if got := reply(demoUnknownSent); got["unknown"] != true {
		t.Fatalf("%v", got)
	}
	th := demoThreadByID(t, demoFilesReq(t).threadsAnswer, "PRRT_demo_1")
	if len(th.Comments) != 3 || th.Comments[2].Body != demoUnknownSent || !th.Comments[2].Mine {
		t.Fatalf("!unknown-sent made no change: %+v", th.Comments)
	}
}

// Deleting the last pending comment drops the pending review, as GitHub does;
// a reply after that makes an empty one on the head and replies into it.
func TestAppDemoDeleteAndReplyWithNoReview(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	got := appRun(t, demoDo(demoPR482, "delete", map[string]any{"comment": "PRRC_demo_7"}))
	if v, ok := got["review"]; got["ok"] != true || !ok || v != nil {
		t.Fatalf("%v", got)
	}
	files := demoFilesReq(t)
	if files.Review != nil {
		t.Fatalf("review %+v", files.Review)
	}
	for _, th := range files.Threads {
		if th.ID == "PRRT_demo_3" {
			t.Fatal("a thread with no comments left is still there")
		}
	}
	r := demoRunAs[replyAnswer](t, demoDo(demoPR482, "reply", map[string]any{"thread": "PRRT_demo_1", "body": "One more thing."}))
	if !r.OK || r.Review == nil || r.Review.Comments != 1 || r.Review.Commit != demoHead(482) || r.Review.ID == "PRR_demo_482" {
		t.Fatalf("%+v", r.Review)
	}
	// A pending comment can be deleted while others remain: the review stays.
	c := demoRunAs[commentAnswer](t, demoDo(demoPR482, "comment", map[string]any{"head": demoHead(482), "path": "Package.swift", "line": 10, "side": "left", "body": "Why drop this?"}))
	d := demoRunAs[deleteAnswer](t, demoDo(demoPR482, "delete", map[string]any{"comment": c.Comment.ID}))
	if !d.OK || d.Review == nil || d.Review.Comments != 1 {
		t.Fatalf("%+v", d)
	}
}

// Discarding Maria's pending review drops its comments; with none pending,
// Sam can approve her PR outright.
func TestAppDemoDiscardThenApprove(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	if got := appRun(t, demoDo(demoPR480, "discard", map[string]any{"reviewId": "PRR_demo_480", "count": 1})); got["ok"] != true {
		t.Fatalf("%v", got)
	}
	files := demoRunAs[filesAnswer](t, `{"op":"files","demo":true,`+demoPR480+`}`)
	if files.Review != nil || len(files.Threads) != 0 {
		t.Fatalf("%+v %+v", files.Review, files.Threads)
	}
	s := demoRunAs[submitAnswer](t, demoDo(demoPR480, "submit", map[string]any{"event": "approve"}))
	if !s.OK || s.URL == "" {
		t.Fatalf("%+v", s)
	}
	// And now a comment on the head starts a new review there.
	c := demoRunAs[commentAnswer](t, demoDo(demoPR480, "comment", map[string]any{"head": demoHead(480), "path": "Sources/Onboarding/Welcome.swift", "line": 15, "side": "right", "body": "One more"}))
	if !c.OK || c.Thread != nil || c.Review == nil || c.Review.Commit != demoHead(480) {
		t.Fatalf("%+v", c)
	}
}

// Only a change is saved: a refusal, or a poll that brought nothing, writes
// nothing, so it can't undo what another process saved meanwhile.
func TestAppDemoSavesOnlyAChange(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	appRun(t, demoDo(demoPR482, "resolve", map[string]any{"thread": "PRRT_demo_3"}))                    // refused
	appRun(t, demoDo(demoPR482, "reply", map[string]any{"thread": "PRRT_demo_1", "body": demoUnknown})) // unknown, unchanged
	demoRunAs[threadsAnswer](t, `{"op":"threads","demo":true,`+demoPR480+`}`)                           // nothing arrives on #480
	if _, err := os.Stat(appDemoPath()); !os.IsNotExist(err) {
		t.Fatalf("saved without a change: %v", err)
	}
	appRun(t, demoDo(demoPR482, "reply", map[string]any{"thread": "PRRT_demo_1", "body": demoUnknownSent})) // unknown, changed
	if _, err := os.Stat(appDemoPath()); err != nil {
		t.Fatalf("a change wasn't saved: %v", err)
	}
}

// A submit records the viewer's submitted review, which `threads` then
// carries, in a later process too; so does one that went through without an
// answer ("!unknown-sent"), and one that didn't ("!unknown") records nothing.
func TestAppDemoSubmittedReview(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	threads := func(pr string) threadsAnswer {
		return demoRunAs[threadsAnswer](t, `{"op":"threads","demo":true,`+pr+`}`)
	}
	if got := threads(demoPR480); got.Submitted != nil {
		t.Fatalf("submitted before any submit: %+v", got.Submitted)
	}
	appRun(t, demoDo(demoPR480, "discard", map[string]any{"reviewId": "PRR_demo_480", "count": 1}))
	if got := appRun(t, demoDo(demoPR480, "submit", map[string]any{"event": "approve", "body": demoUnknown})); got["unknown"] != true {
		t.Fatalf("%v", got)
	}
	if got := threads(demoPR480); got.Submitted != nil {
		t.Fatalf("!unknown recorded a review: %+v", got.Submitted)
	}
	if got := appRun(t, demoDo(demoPR480, "submit", map[string]any{"event": "approve", "body": demoUnknownSent})); got["unknown"] != true {
		t.Fatalf("%v", got)
	}
	got := threads(demoPR480)
	if got.Submitted == nil || got.Submitted.State != "approved" || got.Submitted.ID == "" || got.Submitted.At == 0 {
		t.Fatalf("submitted %+v", got.Submitted)
	}
	first := got.Submitted.ID
	// Sam's own review on #482, by its id.
	s := demoRunAs[submitAnswer](t, demoDo(demoPR482, "submit", map[string]any{"reviewId": "PRR_demo_482", "count": 1, "event": "comment"}))
	if !s.OK {
		t.Fatalf("%+v", s)
	}
	if got := threads(demoPR482); got.Submitted == nil || got.Submitted.ID != "PRR_demo_482" || got.Submitted.State != "commented" || got.Review != nil {
		t.Fatalf("%+v %+v", got.Submitted, got.Review)
	}
	if got := threads(demoPR480); got.Submitted == nil || got.Submitted.ID != first {
		t.Fatalf("#480's submitted changed: %+v", got.Submitted)
	}
}
