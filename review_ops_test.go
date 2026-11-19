package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// reviewFake is GitHub for the review actions: the pre-read (the PR, its
// head and the viewer's pending review), the PR-head read a REST fetch makes
// after its pages, and each mutation, recorded. Any other query (the detail
// query, say) fails the test. A mutation answers from fail when it's named
// there, else as GitHub does when it works.
type reviewFake struct {
	t         *testing.T
	mu        sync.Mutex
	head      string
	pending   map[string]any // the viewer's pending review, as reviewNode makes it; nil for none
	deletedIn map[string]any // deletePullRequestReviewComment's review
	fail      map[string]http.HandlerFunc
	reads     int
	mutations []gqlRequest
}

func newReviewFake(t *testing.T) *reviewFake {
	return &reviewFake{t: t, head: headA, fail: map[string]http.HandlerFunc{}}
}

// mutationFields are the mutations the review actions send, by name.
var mutationFields = []string{
	"addPullRequestReviewThreadReply", "addPullRequestReviewThread", "addPullRequestReview",
	"unresolveReviewThread", "resolveReviewThread", "updatePullRequestReviewComment",
	"deletePullRequestReviewComment", "submitPullRequestReview", "deletePullRequestReview",
}

func mutationField(q string) string {
	for _, f := range mutationFields {
		if strings.Contains(q, f+"(input") {
			return f
		}
	}
	return ""
}

func (f *reviewFake) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		req := decodeReq(f.t, r)
		f.mu.Lock()
		defer f.mu.Unlock()
		q := strings.TrimSpace(req.Query)
		if strings.HasPrefix(q, "mutation") {
			f.mutations = append(f.mutations, req)
			field := mutationField(q)
			if h, ok := f.fail[field]; ok {
				h(w, r)
				return
			}
			reply(w, map[string]any{field: f.payload(field, req)})
			return
		}
		switch {
		case strings.Contains(q, "reviews(states: PENDING") && !strings.Contains(q, "files(first"):
			f.reads++
			nodes := []any{}
			if f.pending != nil {
				nodes = append(nodes, f.pending)
			}
			reply(w, map[string]any{"repository": map[string]any{"pullRequest": map[string]any{
				"id": "PR_x", "headRefOid": f.head, "viewerDidAuthor": true, "state": "OPEN", "reviews": map[string]any{"nodes": nodes},
			}}})
		case strings.Contains(q, "pullRequest(number: $n) { id headRefOid }"):
			reply(w, map[string]any{"repository": map[string]any{"pullRequest": map[string]any{"id": "PR_x", "headRefOid": f.head}}})
		default:
			f.t.Errorf("unexpected query: %.100s", q)
			http.Error(w, "no", http.StatusInternalServerError)
		}
	}
}

// payload is what GitHub answers a mutation that worked.
func (f *reviewFake) payload(field string, req gqlRequest) map[string]any {
	body, _ := req.Variables["body"].(string)
	mine := func(id, state string) map[string]any {
		c := commentNode(id, "me", body, state)
		c["viewerDidAuthor"], c["viewerCanUpdate"], c["viewerCanDelete"] = true, true, true
		return c
	}
	switch field {
	case "addPullRequestReviewThread":
		th := threadNode("PRRT_new", fmt.Sprint(req.Variables["path"]), map[string]any{
			"line": req.Variables["line"], "startLine": nil, "diffSide": req.Variables["side"], "viewerCanReply": true,
			"comments": map[string]any{"pageInfo": map[string]any{"hasNextPage": false}, "nodes": []any{mine("PRRC_new", "PENDING")}},
		})
		th["review"] = map[string]any{"nodes": []any{map[string]any{"pullRequestReview": reviewNode("PRR_mine", "PENDING", true, 4, headA)}}}
		return map[string]any{"thread": th}
	case "addPullRequestReview":
		n := 0
		added := []any{}
		if th, ok := req.Variables["threads"].([]any); ok && len(th) > 0 {
			n = 1
			added = append(added, mine("PRRC_new", "PENDING"))
		}
		rv := reviewNode("PRR_new", "PENDING", true, n, headA)
		rv["added"] = map[string]any{"nodes": added}
		rv["url"] = "https://github.com/o/r/pull/7#pullrequestreview-9"
		return map[string]any{"pullRequestReview": rv}
	case "addPullRequestReviewThreadReply":
		c := mine("PRRC_reply", "PENDING")
		c["pullRequestReview"] = reviewNode(fmt.Sprint(req.Variables["review"]), "PENDING", true, 2, headA)
		return map[string]any{"comment": c}
	case "resolveReviewThread", "unresolveReviewThread":
		return map[string]any{"thread": map[string]any{"isResolved": field == "resolveReviewThread"}}
	case "updatePullRequestReviewComment":
		return map[string]any{"pullRequestReviewComment": mine(fmt.Sprint(req.Variables["id"]), "SUBMITTED")}
	case "deletePullRequestReviewComment":
		return map[string]any{"pullRequestReview": f.deletedIn}
	case "submitPullRequestReview":
		return map[string]any{"pullRequestReview": map[string]any{"url": "https://github.com/o/r/pull/7#pullrequestreview-1"}}
	case "deletePullRequestReview":
		return map[string]any{"pullRequestReview": map[string]any{"id": req.Variables["id"]}}
	}
	f.t.Errorf("no payload for %q", field)
	return nil
}

func (f *reviewFake) sent() []gqlRequest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]gqlRequest{}, f.mutations...)
}

// reviewOpFixture is a fresh state dir, a cached diff of a.rb at headA and
// the fake GitHub; any REST request fails the test.
func reviewOpFixture(t *testing.T) *reviewFake {
	t.Helper()
	cacheFixture(t)
	files := []restFile{{Filename: "a.rb", Status: "modified", Changes: 2, SHA: "1", Patch: "@@ -1,2 +1,3 @@\n keep\n-old\n+new\n+more"}}
	if err := writeDiffCache(testRepo, 7, headA, files, time.Now()); err != nil {
		t.Fatal(err)
	}
	f := newReviewFake(t)
	fakeGitHubREST(t, f.handler(), nil)
	return f
}

func doReq(do string, fields map[string]any) string {
	m := map[string]any{"op": "act", "do": do, "pr": map[string]any{"host": "github.com", "repo": "o/r", "number": 7}}
	for k, v := range fields {
		m[k] = v
	}
	data, _ := json.Marshal(m)
	return string(data)
}

// reviewRun is a review action through runApp, decoded into T.
func reviewRun[T any](t *testing.T, req string) T {
	t.Helper()
	return demoRunAs[T](t, req)
}

func commentReq(body string, line int, side string) string {
	return doReq("comment", map[string]any{"head": headA, "path": "a.rb", "line": line, "side": side, "body": body})
}

// A comment with a pending review on the head joins it: one read, one
// mutation, with the review's ID, and the answer has the thread.
func TestOpCommentIntoThePendingReview(t *testing.T) {
	f := reviewOpFixture(t)
	f.pending = reviewNode("PRR_mine", "PENDING", true, 3, headA)
	got := reviewRun[commentAnswer](t, commentReq("Looks off\r\n  by one ", 2, "right"))
	if !got.OK || got.Thread == nil || got.Thread.ID != "PRRT_new" || got.Comment.ID != "PRRC_new" || !got.Comment.Mine {
		t.Fatalf("%+v", got)
	}
	if want := (reviewInfo{ID: "PRR_mine", Body: "overall\nthoughts", Comments: 4, Commit: headA}); got.Review == nil || *got.Review != want {
		t.Fatalf("review %+v", got.Review)
	}
	sent := f.sent()
	if len(sent) != 1 || f.reads != 1 {
		t.Fatalf("%d mutations, %d reads", len(sent), f.reads)
	}
	m := sent[0]
	if mutationField(m.Query) != "addPullRequestReviewThread" || m.Variables["review"] != "PRR_mine" ||
		m.Variables["path"] != "a.rb" || m.Variables["line"] != float64(2) || m.Variables["side"] != "RIGHT" {
		t.Fatalf("%+v", m)
	}
	// Sent as typed: no trimming, no line endings changed.
	if m.Variables["body"] != "Looks off\r\n  by one " {
		t.Fatalf("body %q", m.Variables["body"])
	}
}

// No pending review: one addPullRequestReview, pinned to the head, holding
// the thread, with no event (so it stays pending). The answer has no thread.
func TestOpCommentStartsAPendingReview(t *testing.T) {
	f := reviewOpFixture(t)
	got := opRun(t, commentReq("old line", 2, "LEFT"))
	if got["ok"] != true || got["thread"] != nil || got["comment"].(map[string]any)["id"] != "PRRC_new" || got["review"].(map[string]any)["id"] != "PRR_new" {
		t.Fatalf("%v", got)
	}
	sent := f.sent()
	if len(sent) != 1 {
		t.Fatalf("%d mutations", len(sent))
	}
	m := sent[0]
	if mutationField(m.Query) != "addPullRequestReview" || strings.Contains(m.Query, "event") || m.Variables["commit"] != headA || m.Variables["pr"] != "PR_x" {
		t.Fatalf("%+v", m)
	}
	th := m.Variables["threads"].([]any)[0].(map[string]any)
	if th["path"] != "a.rb" || th["line"] != float64(2) || th["side"] != "LEFT" || th["body"] != "old line" {
		t.Fatalf("thread %v", th)
	}
}

// What a comment is refused for, before anything is sent.
func TestOpCommentRefusals(t *testing.T) {
	long := strings.Repeat("é", maxBody+1)
	for name, tc := range map[string]struct {
		req     string
		pending map[string]any
		head    string
		reads   int
		check   func(map[string]any) bool
	}{
		"empty":       {req: commentReq("", 2, "right")},
		"whitespace":  {req: commentReq(" \n\t ", 2, "right")},
		"too long":    {req: commentReq(long, 2, "right")},
		"no side":     {req: commentReq("x", 2, "up")},
		"no line":     {req: commentReq("x", 0, "right")},
		"stale head":  {req: commentReq("x", 2, "right"), head: headB, reads: 1, check: func(m map[string]any) bool { return m["stale"] == true }},
		"not in diff": {req: commentReq("x", 9, "right"), reads: 1},
		// Line 3 is an added line: there's no line 3 on the old side.
		"wrong side": {req: commentReq("x", 3, "left"), reads: 1},
		"older review": {req: commentReq("x", 2, "right"), pending: reviewNode("PRR_mine", "PENDING", true, 1, headB), reads: 1, check: func(m map[string]any) bool {
			return m["error"] == olderCommitMsg && m["review"].(map[string]any)["commit"] == headB
		}},
	} {
		t.Run(name, func(t *testing.T) {
			f := reviewOpFixture(t)
			f.pending = tc.pending
			if tc.head != "" {
				f.head = tc.head
			}
			got := opRun(t, tc.req)
			if got["error"] == nil || got["ok"] != nil || got["unknown"] != nil {
				t.Fatalf("%v", got)
			}
			if tc.check != nil && !tc.check(got) {
				t.Fatalf("%v", got)
			}
			if len(f.sent()) != 0 || f.reads != tc.reads {
				t.Fatalf("%d mutations, %d reads", len(f.sent()), f.reads)
			}
		})
	}
}

// With no diff cached, the line is checked against the file's patch, read
// from REST as `diff` reads it.
func TestOpCommentChecksTheLineThroughREST(t *testing.T) {
	cacheFixture(t)
	f := newReviewFake(t)
	var rest int
	files := []restFile{{Filename: "a.rb", Status: "modified", Changes: 2, SHA: "1", Patch: "@@ -1 +1 @@\n-a\n+b"}}
	fakeGitHubREST(t, f.handler(), restFilesPages(t, files, 100, headA, &rest))
	if got := opRun(t, commentReq("x", 5, "right")); got["error"] == nil || len(f.sent()) != 0 {
		t.Fatalf("%v", got)
	}
	if rest != 1 {
		t.Fatalf("%d REST pages", rest)
	}
	if got := opRun(t, commentReq("x", 1, "right")); got["ok"] != true || len(f.sent()) != 1 {
		t.Fatalf("%v", got)
	}
}

// GitHub refuses the mutation: refused, said as GitHub said it, never sent again.
func TestOpCommentRefusedByGitHub(t *testing.T) {
	f := reviewOpFixture(t)
	f.pending = reviewNode("PRR_mine", "PENDING", true, 3, headA)
	f.fail["addPullRequestReviewThread"] = writeJSON(`{"data":{"addPullRequestReviewThread":null},"errors":[{"type":"UNPROCESSABLE","message":"Line could not be resolved"}]}`, 200)
	got := opRun(t, commentReq("x", 2, "right"))
	if got["error"] != "GitHub: Line could not be resolved" || got["unknown"] != nil || len(f.sent()) != 1 {
		t.Fatalf("%v, %d mutations", got, len(f.sent()))
	}
}

// Each failure after the request is written answers unknown, and nothing
// is sent a second time.
func TestOpCommentUnknown(t *testing.T) {
	for name, h := range map[string]http.HandlerFunc{
		"5xx":              writeJSON(`{"message":"boom"}`, 502),
		"errors with data": writeJSON(`{"data":{"addPullRequestReviewThread":{"thread":null}},"errors":[{"type":"FORBIDDEN","message":"x"}]}`, 200),
		"dropped":          hangUp(t),
	} {
		t.Run(name, func(t *testing.T) {
			f := reviewOpFixture(t)
			f.pending = reviewNode("PRR_mine", "PENDING", true, 3, headA)
			f.fail["addPullRequestReviewThread"] = h
			got := opRun(t, commentReq("x", 2, "right"))
			if got["unknown"] != true || got["error"] == nil || got["ok"] != nil || len(f.sent()) != 1 {
				t.Fatalf("%v, %d mutations", got, len(f.sent()))
			}
		})
	}
}

func replyReq(body string) string {
	return doReq("reply", map[string]any{"thread": "PRRT_1", "body": body})
}

// A reply into the pending review always names it.
func TestOpReplyIntoThePendingReview(t *testing.T) {
	f := reviewOpFixture(t)
	f.pending = reviewNode("PRR_mine", "PENDING", true, 1, headA)
	got := reviewRun[replyAnswer](t, replyReq("agreed"))
	if !got.OK || got.Thread != "PRRT_1" || got.Comment.ID != "PRRC_reply" || got.Review == nil || got.Review.Comments != 2 {
		t.Fatalf("%+v", got)
	}
	sent := f.sent()
	if len(sent) != 1 || mutationField(sent[0].Query) != "addPullRequestReviewThreadReply" ||
		sent[0].Variables["review"] != "PRR_mine" || sent[0].Variables["thread"] != "PRRT_1" || sent[0].Variables["body"] != "agreed" {
		t.Fatalf("%+v", sent)
	}
}

// No pending review: an empty one on the head first, then the reply into it.
func TestOpReplyWithNoPendingReview(t *testing.T) {
	f := reviewOpFixture(t)
	got := reviewRun[replyAnswer](t, replyReq("agreed"))
	if !got.OK || got.Comment.ID != "PRRC_reply" || got.Review == nil || got.Review.ID != "PRR_new" {
		t.Fatalf("%+v", got)
	}
	sent := f.sent()
	if len(sent) != 2 {
		t.Fatalf("%d mutations", len(sent))
	}
	start, reply := sent[0], sent[1]
	if mutationField(start.Query) != "addPullRequestReview" || start.Variables["commit"] != headA || start.Variables["threads"] != nil || strings.Contains(start.Query, "event") {
		t.Fatalf("start %+v", start)
	}
	if mutationField(reply.Query) != "addPullRequestReviewThreadReply" || reply.Variables["review"] != "PRR_new" {
		t.Fatalf("reply %+v", reply)
	}
}

// The empty review was made and the reply wasn't: the answer says so, with
// the new review, in the reply's class. Nothing is sent a third time.
func TestOpReplySecondStepFails(t *testing.T) {
	for name, tc := range map[string]struct {
		h       http.HandlerFunc
		unknown bool
	}{
		"refused": {writeJSON(`{"data":{"addPullRequestReviewThreadReply":null},"errors":[{"type":"NOT_FOUND","message":"no thread"}]}`, 200), false},
		"unknown": {writeJSON(`{"message":"boom"}`, 500), true},
	} {
		t.Run(name, func(t *testing.T) {
			f := reviewOpFixture(t)
			f.fail["addPullRequestReviewThreadReply"] = tc.h
			got := opRun(t, replyReq("agreed"))
			if (got["unknown"] == true) != tc.unknown || got["ok"] != nil || !strings.Contains(fmt.Sprint(got["error"]), "empty pending review was left behind") {
				t.Fatalf("%v", got)
			}
			if rv, ok := got["review"].(map[string]any); !ok || rv["id"] != "PRR_new" || rv["comments"] != float64(0) {
				t.Fatalf("review %v", got["review"])
			}
			if len(f.sent()) != 2 {
				t.Fatalf("%d mutations", len(f.sent()))
			}
		})
	}
}

// The first step's outcome isn't known: the reply is never sent.
func TestOpReplyFirstStepUnknown(t *testing.T) {
	f := reviewOpFixture(t)
	f.fail["addPullRequestReview"] = writeJSON(`{"message":"boom"}`, 503)
	got := opRun(t, replyReq("agreed"))
	if got["unknown"] != true || !strings.HasPrefix(fmt.Sprint(got["error"]), "No answer. An empty pending review may have been created.") {
		t.Fatalf("%v", got)
	}
	if len(f.sent()) != 1 {
		t.Fatalf("%d mutations", len(f.sent()))
	}
}

// The deadline falls between the two: the reply is refused, with the new review.
func TestOpReplyDeadlineBetweenTheTwo(t *testing.T) {
	oldD, oldM := mutationDeadline, minTimeToSend
	mutationDeadline, minTimeToSend = time.Second, 500*time.Millisecond
	t.Cleanup(func() { mutationDeadline, minTimeToSend = oldD, oldM })
	f := reviewOpFixture(t)
	f.fail["addPullRequestReview"] = func(w http.ResponseWriter, r *http.Request) {
		time.Sleep(600 * time.Millisecond) // GitHub is slow to make the review
		reply(w, map[string]any{"addPullRequestReview": f.payload("addPullRequestReview", gqlRequest{Variables: map[string]any{}})})
	}
	got := opRun(t, replyReq("agreed"))
	if got["unknown"] != nil || !strings.Contains(fmt.Sprint(got["error"]), "Took too long to prepare. Nothing was sent.") {
		t.Fatalf("%v", got)
	}
	if rv, ok := got["review"].(map[string]any); !ok || rv["id"] != "PRR_new" {
		t.Fatalf("review %v", got["review"])
	}
	if len(f.sent()) != 1 {
		t.Fatalf("%d mutations", len(f.sent()))
	}
}

func TestOpResolveAndUnresolve(t *testing.T) {
	f := reviewOpFixture(t)
	if got := reviewRun[resolveAnswer](t, doReq("resolve", map[string]any{"thread": "PRRT_1"})); !got.OK || !got.Resolved {
		t.Fatalf("%+v", got)
	}
	if got := reviewRun[resolveAnswer](t, doReq("unresolve", map[string]any{"thread": "PRRT_1"})); !got.OK || got.Resolved {
		t.Fatalf("%+v", got)
	}
	sent := f.sent()
	if len(sent) != 2 || mutationField(sent[0].Query) != "resolveReviewThread" || mutationField(sent[1].Query) != "unresolveReviewThread" || sent[0].Variables["id"] != "PRRT_1" {
		t.Fatalf("%+v", sent)
	}
	if f.reads != 0 {
		t.Fatalf("%d reads: resolving places nothing", f.reads)
	}
	f.fail["resolveReviewThread"] = writeJSON(`{"data":{"resolveReviewThread":null},"errors":[{"type":"FORBIDDEN","message":"Resource not accessible by integration"}]}`, 200)
	if got := opRun(t, doReq("resolve", map[string]any{"thread": "PRRT_1"})); got["error"] == nil || got["unknown"] != nil {
		t.Fatalf("%v", got)
	}
	if got := opRun(t, doReq("resolve", nil)); got["error"] == nil || len(f.sent()) != 3 {
		t.Fatalf("no thread: %v, %d mutations", got, len(f.sent()))
	}
}

func TestOpEdit(t *testing.T) {
	f := reviewOpFixture(t)
	got := reviewRun[editAnswer](t, doReq("edit", map[string]any{"comment": "PRRC_1", "body": "better\nwords"}))
	if !got.OK || got.Comment.ID != "PRRC_1" || got.Comment.Body != "better\nwords" {
		t.Fatalf("%+v", got)
	}
	sent := f.sent()
	if len(sent) != 1 || mutationField(sent[0].Query) != "updatePullRequestReviewComment" || sent[0].Variables["id"] != "PRRC_1" {
		t.Fatalf("%+v", sent)
	}
	for _, body := range []string{"", "   ", strings.Repeat("x", maxBody+1)} {
		if got := opRun(t, doReq("edit", map[string]any{"comment": "PRRC_1", "body": body})); got["error"] == nil {
			t.Fatalf("%q: %v", body, got)
		}
	}
	if len(f.sent()) != 1 {
		t.Fatalf("%d mutations", len(f.sent()))
	}
	// Exactly at the limit is fine.
	if got := opRun(t, doReq("edit", map[string]any{"comment": "PRRC_1", "body": strings.Repeat("é", maxBody)})); got["ok"] != true {
		t.Fatalf("%v", got)
	}
}

// What delete answers as the pending review after.
func TestOpDelete(t *testing.T) {
	for name, tc := range map[string]struct {
		pending, deletedIn map[string]any
		want               *reviewInfo
	}{
		// GitHub's payload still says pending with 0, but it deleted it.
		"last pending comment": {reviewNode("PRR_mine", "PENDING", true, 1, headA), reviewNode("PRR_mine", "PENDING", true, 0, headA), nil},
		"one of several":       {reviewNode("PRR_mine", "PENDING", true, 3, headA), reviewNode("PRR_mine", "PENDING", true, 2, headA), &reviewInfo{ID: "PRR_mine", Body: "overall\nthoughts", Comments: 2, Commit: headA}},
		// A published comment's review isn't the pending one, which stays.
		"published": {reviewNode("PRR_mine", "PENDING", true, 3, headA), reviewNode("PRR_old", "COMMENTED", true, 4, headA), &reviewInfo{ID: "PRR_mine", Body: "overall\nthoughts", Comments: 3, Commit: headA}},
	} {
		t.Run(name, func(t *testing.T) {
			f := reviewOpFixture(t)
			f.pending, f.deletedIn = tc.pending, tc.deletedIn
			got := opRun(t, doReq("delete", map[string]any{"comment": "PRRC_1"}))
			if got["ok"] != true {
				t.Fatalf("%v", got)
			}
			v, present := got["review"]
			if !present {
				t.Fatal("no review in the answer")
			}
			typed := reviewRun[deleteAnswer](t, doReq("delete", map[string]any{"comment": "PRRC_1"}))
			if (tc.want == nil) != (v == nil) || (tc.want != nil && *typed.Review != *tc.want) {
				t.Fatalf("review %v, want %+v", v, tc.want)
			}
			if sent := f.sent(); mutationField(sent[0].Query) != "deletePullRequestReviewComment" || sent[0].Variables["id"] != "PRRC_1" {
				t.Fatalf("%+v", sent)
			}
		})
	}
}

func submitReq(reviewID string, count *int, event, body string) string {
	m := map[string]any{"event": event, "body": body}
	if reviewID != "" {
		m["reviewId"] = reviewID
	}
	if count != nil {
		m["count"] = *count
	}
	return doReq("submit", m)
}

func intp(n int) *int { return &n }

// Submit names the review shown, never "any pending reviews" of the PR.
func TestOpSubmitThePendingReview(t *testing.T) {
	f := reviewOpFixture(t)
	f.pending = reviewNode("PRR_mine", "PENDING", true, 3, headA)
	got := reviewRun[submitAnswer](t, submitReq("PRR_mine", intp(3), "request_changes", ""))
	if !got.OK || got.URL != "https://github.com/o/r/pull/7#pullrequestreview-1" {
		t.Fatalf("%+v", got)
	}
	sent := f.sent()
	if len(sent) != 1 || mutationField(sent[0].Query) != "submitPullRequestReview" || sent[0].Variables["id"] != "PRR_mine" ||
		sent[0].Variables["event"] != "REQUEST_CHANGES" || sent[0].Variables["body"] != nil || strings.Contains(sent[0].Query, "pullRequestId") {
		t.Fatalf("%+v", sent)
	}
}

// The review isn't what the dialog showed: refused, changed, with the review
// as it is now, and nothing sent.
func TestOpSubmitAndDiscardRefuseAChangedReview(t *testing.T) {
	for name, pending := range map[string]map[string]any{
		"count":    reviewNode("PRR_mine", "PENDING", true, 4, headA),
		"replaced": reviewNode("PRR_other", "PENDING", true, 3, headA),
		"gone":     nil,
		// Submitted elsewhere: GitHub's answer still has it, but it's no
		// longer pending, so there's no pending review.
		"submitted": reviewNode("PRR_mine", "SUBMITTED", true, 3, headA),
	} {
		gone := name == "gone" || name == "submitted"
		for _, req := range []string{submitReq("PRR_mine", intp(3), "comment", "lgtm"), doReq("discard", map[string]any{"reviewId": "PRR_mine", "count": 3})} {
			t.Run(name, func(t *testing.T) {
				f := reviewOpFixture(t)
				f.pending = pending
				got := opRun(t, req)
				if got["changed"] != true || got["error"] == nil || got["unknown"] != nil {
					t.Fatalf("%v", got)
				}
				v, present := got["review"]
				if !present || gone != (v == nil) {
					t.Fatalf("review %v (present %v)", v, present)
				}
				if name == "count" && got["error"] != "Your pending review changed (now 4 comments). Nothing was sent." {
					t.Fatalf("%v", got["error"])
				}
				if len(f.sent()) != 0 {
					t.Fatalf("%d mutations", len(f.sent()))
				}
			})
		}
	}
}

// With no reviewId: refused while a pending review exists (it would be one
// the dialog didn't show), else a new review with no comments.
func TestOpSubmitWithoutAReview(t *testing.T) {
	f := reviewOpFixture(t)
	f.pending = reviewNode("PRR_mine", "PENDING", true, 2, headA)
	if got := opRun(t, submitReq("", nil, "approve", "")); got["changed"] != true || got["review"].(map[string]any)["id"] != "PRR_mine" {
		t.Fatalf("%v", got)
	}
	if len(f.sent()) != 0 {
		t.Fatalf("%d mutations", len(f.sent()))
	}
	f.pending = nil
	got := reviewRun[submitAnswer](t, submitReq("", nil, "comment", "Nice work"))
	if !got.OK || got.URL == "" {
		t.Fatalf("%+v", got)
	}
	sent := f.sent()
	if len(sent) != 1 || mutationField(sent[0].Query) != "addPullRequestReview" || sent[0].Variables["event"] != "COMMENT" ||
		sent[0].Variables["body"] != "Nice work" || sent[0].Variables["pr"] != "PR_x" {
		t.Fatalf("%+v", sent)
	}
}

// What submit refuses before it reads anything.
func TestOpSubmitRefusesBeforeAsking(t *testing.T) {
	f := reviewOpFixture(t)
	for _, req := range []string{
		submitReq("", nil, "comment", ""),             // the event comment, with nothing to say
		submitReq("", nil, "comment", "  \n"),         // only whitespace
		submitReq("PRR_mine", intp(0), "comment", ""), // a review with no comments, and no text
		submitReq("PRR_mine", nil, "approve", ""),     // no count
		submitReq("", nil, "merge", "x"),              // no such event
		submitReq("", nil, "approve", strings.Repeat("x", maxBody+1)),
		doReq("discard", map[string]any{"reviewId": "PRR_mine"}),
		doReq("discard", map[string]any{"count": 1}),
	} {
		if got := opRun(t, req); got["error"] == nil || got["ok"] != nil {
			t.Errorf("%s: %v", req, got)
		}
	}
	if f.reads != 0 || len(f.sent()) != 0 {
		t.Fatalf("%d reads, %d mutations", f.reads, len(f.sent()))
	}
}

func TestOpDiscard(t *testing.T) {
	f := reviewOpFixture(t)
	f.pending = reviewNode("PRR_mine", "PENDING", true, 0, headA)
	got := opRun(t, doReq("discard", map[string]any{"reviewId": "PRR_mine", "count": 0}))
	if got["ok"] != true || len(got) != 1 {
		t.Fatalf("%v", got)
	}
	sent := f.sent()
	if len(sent) != 1 || mutationField(sent[0].Query) != "deletePullRequestReview" || sent[0].Variables["id"] != "PRR_mine" {
		t.Fatalf("%+v", sent)
	}
}

// A pre-read that fails is refused, says nothing was sent, and sends nothing.
func TestOpReviewReadFailsSendsNothing(t *testing.T) {
	cacheFixture(t)
	var mutations int
	fakeGitHub(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(strings.TrimSpace(decodeReq(t, r).Query), "mutation") {
			mutations++
		}
		http.Error(w, "boom", http.StatusBadGateway)
	})
	for _, req := range []string{commentReq("x", 2, "right"), replyReq("x"), doReq("delete", map[string]any{"comment": "C"}), submitReq("", nil, "approve", "")} {
		got := opRun(t, req)
		if got["error"] == nil || got["unknown"] != nil || !strings.Contains(fmt.Sprint(got["error"]), "Nothing was sent") {
			t.Errorf("%s: %v", req, got)
		}
	}
	if mutations != 0 {
		t.Fatalf("%d mutations", mutations)
	}
}
