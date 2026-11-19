package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakePR is one PR on the fake GitHub: its files and review threads (as
// GraphQL nodes), paged 100 at a time by cursor "p<offset>", and the head
// each read of it sees.
type fakePR struct {
	t       *testing.T
	mu      sync.Mutex
	head    func(call int) string // the head the nth files query (0-based) sees
	after   string                // the head a PR-head query sees; "" = the files query's first
	files   []map[string]any
	threads []map[string]any
	queries []gqlRequest
	headQs  int
	errors  []map[string]any // sent with the data (a partial answer)
	// What the first page says of the PR and its reviews.
	mine      bool
	reviews   []map[string]any
	submitted []map[string]any // what reviews(last: 10) says
}

func (p *fakePR) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		req := decodeReq(p.t, r)
		p.mu.Lock()
		defer p.mu.Unlock()
		if !strings.Contains(req.Query, "files(first") {
			p.headQs++
			head := p.after
			if head == "" {
				head = p.head(0)
			}
			reply(w, map[string]any{"repository": map[string]any{"pullRequest": map[string]any{"id": "PR_x", "headRefOid": head}}})
			return
		}
		call := len(p.queries)
		p.queries = append(p.queries, req)
		pr := map[string]any{"id": "PR_x", "headRefOid": p.head(call)}
		page := func(all []map[string]any, after any) map[string]any {
			off := 0
			if s, ok := after.(string); ok {
				off, _ = strconv.Atoi(strings.TrimPrefix(s, "p"))
			}
			end := off + 100
			if end > len(all) {
				end = len(all)
			}
			return map[string]any{
				"pageInfo": map[string]any{"hasNextPage": end < len(all), "endCursor": "p" + strconv.Itoa(end)},
				"nodes":    all[off:end],
			}
		}
		if req.Variables["review"] == true {
			pr["viewerDidAuthor"], pr["state"] = p.mine, "OPEN"
			pr["reviews"] = map[string]any{"nodes": append([]map[string]any{}, p.reviews...)}
			pr["submitted"] = map[string]any{"nodes": append([]map[string]any{}, p.submitted...)}
		}
		if req.Variables["files"] == true {
			pr["files"] = page(p.files, req.Variables["fa"])
		}
		if req.Variables["threads"] == true {
			pr["reviewThreads"] = page(p.threads, req.Variables["ta"])
		}
		out := map[string]any{"data": map[string]any{"repository": map[string]any{"pullRequest": pr}}}
		if p.errors != nil {
			out["errors"] = p.errors
		}
		_ = json.NewEncoder(w).Encode(out)
	}
}

func staticHead(h string) func(int) string { return func(int) string { return h } }

func fileNode(path, changeType, viewed string, add, del int) map[string]any {
	return map[string]any{"path": path, "additions": add, "deletions": del, "changeType": changeType, "viewerViewedState": viewed}
}

// threadNode is a review thread as GraphQL sends it; over overrides fields.
func threadNode(id, path string, over map[string]any) map[string]any {
	n := map[string]any{
		"id": id, "isResolved": false, "isOutdated": false, "path": path,
		"line": 10, "startLine": 10, "originalLine": 10, "diffSide": "RIGHT", "startDiffSide": "RIGHT", "subjectType": "LINE",
		"comments": map[string]any{"pageInfo": map[string]any{"hasNextPage": false}, "nodes": []any{commentNode("PRRC_"+id, "someone", "hi", "SUBMITTED")}},
		"hunk":     map[string]any{"nodes": []any{map[string]any{"diffHunk": "@@ -1 +1 @@\n-a\n+b"}}},
	}
	for k, v := range over {
		n[k] = v
	}
	return n
}

func commentNode(id, author, body, state string) map[string]any {
	var a any
	if author != "" {
		a = map[string]any{"login": author}
	}
	return map[string]any{"id": id, "author": a, "body": body, "createdAt": "2026-09-20T10:00:00Z", "state": state, "url": "https://github.com/o/r/pull/7#discussion_" + id}
}

func ctxBG() context.Context { return context.Background() }

// Files, in GitHub's order, with a rename's old path from REST; threads in
// file then line order with their counts on the files.
func TestFilesAnswer(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t, head: staticHead(headA)}
	pr.files = []map[string]any{
		fileNode("api/a.rb", "MODIFIED", "VIEWED", 12, 3),
		fileNode("api/b.rb", "RENAMED", "DISMISSED", 0, 0),
		fileNode("web/c.ts", "ADDED", "UNVIEWED", 29, 0),
		fileNode("web/d.png", "DELETED", "UNVIEWED", 0, 0),
	}
	pr.threads = []map[string]any{
		threadNode("T4", "web/c.ts", map[string]any{"line": 3, "startLine": 3}),
		threadNode("T2", "api/a.rb", map[string]any{"line": 40, "startLine": 40, "isResolved": true}),
		threadNode("T1", "api/a.rb", map[string]any{"line": 5, "startLine": 5}),
		threadNode("T0", "gone/x.rb", map[string]any{"line": 1, "startLine": 1}), // a file not listed
	}
	rest := []restFile{
		{Filename: "api/a.rb", Status: "modified", Changes: 15, SHA: "1", Patch: "@@ -1 +1 @@\n-a\n+b"},
		{Filename: "api/b.rb", PreviousFilename: "api/old_b.rb", Status: "renamed", SHA: "2"},
	}
	fakeGitHubREST(t, pr.handler(), restFilesPages(t, rest, 100, headA, nil))

	got, err := newClient("github.com").files(ctxBG(), testRepo, 7)
	if err != nil {
		t.Fatal(err)
	}
	wantFiles := []fileEntry{
		{Path: "api/a.rb", Status: "modified", Additions: 12, Deletions: 3, Viewed: "viewed", Threads: 2, Open: 1},
		{Path: "api/b.rb", From: "api/old_b.rb", Status: "renamed", Viewed: "dismissed"},
		{Path: "web/c.ts", Status: "added", Additions: 29, Viewed: "unviewed", Threads: 1, Open: 1},
		{Path: "web/d.png", Status: "deleted", Viewed: "unviewed"},
	}
	if got.Head != headA || got.More || !reflect.DeepEqual(got.Files, wantFiles) {
		t.Fatalf("head %s more %v\n got %+v\nwant %+v", got.Head, got.More, got.Files, wantFiles)
	}
	var order []string
	for _, th := range got.Threads {
		order = append(order, th.ID)
	}
	if !reflect.DeepEqual(order, []string{"T1", "T2", "T4", "T0"}) {
		t.Fatalf("thread order %v", order)
	}
	// The PR's REST files were kept for the diffs that follow.
	if _, ok := readDiffCache(testRepo, 7, headA); !ok {
		t.Fatal("the REST files weren't cached")
	}
}

// How each kind of thread is anchored.
func TestFilesThreadShapes(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t, head: staticHead(headA)}
	pr.files = []map[string]any{fileNode("a.rb", "MODIFIED", "UNVIEWED", 1, 1)}
	hunk := func(s string) map[string]any { return map[string]any{"nodes": []any{map[string]any{"diffHunk": s}}} }
	pr.threads = []map[string]any{
		// A single-line thread: GitHub says startLine == line.
		threadNode("single", "a.rb", map[string]any{"line": 7, "startLine": 7}),
		// A single-line thread whose startLine is null.
		threadNode("nullstart", "a.rb", map[string]any{"line": 8, "startLine": nil, "startDiffSide": nil}),
		// A multi-line thread, from the old file's line 4 to the new file's line 9.
		threadNode("multi", "a.rb", map[string]any{"line": 9, "startLine": 4, "diffSide": "RIGHT", "startDiffSide": "LEFT"}),
		// A multi-line thread across sides that starts and ends on one number:
		// a one-line replacement (-x at old 5, +y at new 5) commented on whole.
		threadNode("crossside", "a.rb", map[string]any{"line": 5, "startLine": 5, "diffSide": "RIGHT", "startDiffSide": "LEFT"}),
		// Outdated, but it still has a line.
		threadNode("outdated-line", "a.rb", map[string]any{"line": 12, "startLine": 12, "isOutdated": true, "originalLine": 11}),
		// Outdated with no line: the hunk says what it was about, newlines kept.
		threadNode("outdated-noline", "a.rb", map[string]any{"line": nil, "startLine": nil, "isOutdated": true, "originalLine": 5, "diffSide": "LEFT", "hunk": hunk("@@ -3,2 +3,2 @@\n ctx\n-gone\x1b[31m")}),
		// On the whole file.
		threadNode("file", "a.rb", map[string]any{"line": nil, "startLine": nil, "originalLine": nil, "subjectType": "FILE"}),
		// A comment of the signed-in person's own, not sent yet; a deleted author.
		threadNode("pending", "a.rb", map[string]any{"line": 20, "startLine": 20, "comments": map[string]any{
			"pageInfo": map[string]any{"hasNextPage": false},
			"nodes":    []any{commentNode("C1", "someone", "first\nsecond\x1b]0;x\x07", "SUBMITTED"), commentNode("C2", "", "draft", "PENDING")},
		}}),
	}
	fakeGitHubREST(t, pr.handler(), restFilesPages(t, nil, 100, headA, nil))
	got, err := newClient("github.com").files(ctxBG(), testRepo, 7)
	if err != nil {
		t.Fatal(err)
	}
	by := map[string]fileThread{}
	for _, th := range got.Threads {
		by[th.ID] = th
	}
	check := func(id string, want fileThread) {
		t.Helper()
		g := by[id]
		g.Comments = nil
		want.ID, want.Path = id, "a.rb"
		if !reflect.DeepEqual(g, want) {
			t.Errorf("%s:\n got %+v\nwant %+v", id, g, want)
		}
	}
	check("single", fileThread{Subject: "line", Line: 7, Side: "right", OriginalLine: 10})
	check("nullstart", fileThread{Subject: "line", Line: 8, Side: "right", OriginalLine: 10})
	check("multi", fileThread{Subject: "line", Line: 9, Side: "right", StartLine: 4, StartSide: "left", OriginalLine: 10})
	check("crossside", fileThread{Subject: "line", Line: 5, Side: "right", StartLine: 5, StartSide: "left", OriginalLine: 10})
	check("outdated-line", fileThread{Subject: "line", Line: 12, Side: "right", OriginalLine: 11, Outdated: true})
	check("outdated-noline", fileThread{Subject: "line", Line: 0, Side: "left", OriginalLine: 5, Outdated: true, Hunk: "@@ -3,2 +3,2 @@\n ctx\n-gone"})
	check("file", fileThread{Subject: "file", Side: "right"})
	check("pending", fileThread{Subject: "line", Line: 20, Side: "right", OriginalLine: 10})

	want := []threadComment{
		{ID: "C1", Author: "someone", Body: "first\nsecond", Created: time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC).UnixMilli(), State: "submitted", URL: "https://github.com/o/r/pull/7#discussion_C1"},
		{ID: "C2", Author: "ghost", Body: "draft", Created: time.Date(2026, 9, 20, 10, 0, 0, 0, time.UTC).UnixMilli(), State: "pending", URL: "https://github.com/o/r/pull/7#discussion_C2"},
	}
	if !reflect.DeepEqual(by["pending"].Comments, want) {
		t.Fatalf("comments %+v", by["pending"].Comments)
	}
	// A hunk is only sent for a line thread with no line.
	if by["single"].Hunk != "" || by["file"].Hunk != "" {
		t.Fatal("a hunk was sent for a thread that has a line, or is on the file")
	}
}

// What GitHub sends is typed by other people: a thread's path, its author and
// its comments are cleaned; only the body (and hunk) keep their line breaks.
func TestFilesCleansWhatGitHubSends(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t, head: staticHead(headA)}
	pr.files = []map[string]any{fileNode("a\x1b]52;c;ZXZpbA==\x07.rb", "MODIFIED", "UNVIEWED", 1, 1)}
	pr.threads = []map[string]any{threadNode("T", "a.rb", map[string]any{
		"comments": map[string]any{"pageInfo": map[string]any{"hasNextPage": false}, "nodes": []any{commentNode("C", "ev\x1b[31mil", "a\nb\x1b[2J", "SUBMITTED")}},
	})}
	fakeGitHubREST(t, pr.handler(), restFilesPages(t, nil, 100, headA, nil))
	got, err := newClient("github.com").files(ctxBG(), testRepo, 7)
	if err != nil {
		t.Fatal(err)
	}
	if got.Files[0].Path != "a.rb" {
		t.Fatalf("path %q", got.Files[0].Path)
	}
	if c := got.Threads[0].Comments[0]; c.Author != "evil" || c.Body != "a\nb" {
		t.Fatalf("comment %+v", c)
	}
}

// Files page to 3000 and threads to 300; past either is more: true, and the
// pages are asked for together until one connection is done.
func TestFilesLimits(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t, head: staticHead(headA)}
	for i := 0; i < 3100; i++ {
		pr.files = append(pr.files, fileNode(fmt.Sprintf("f%04d", i), "MODIFIED", "UNVIEWED", 1, 1))
	}
	for i := 0; i < 350; i++ {
		pr.threads = append(pr.threads, threadNode(fmt.Sprintf("T%d", i), "f0000", map[string]any{"line": i + 1, "startLine": i + 1}))
	}
	fakeGitHubREST(t, pr.handler(), restFilesPages(t, nil, 100, headA, nil))
	got, err := newClient("github.com").files(ctxBG(), testRepo, 7)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.Files) != 3000 || len(got.Threads) != 300 || !got.More {
		t.Fatalf("%d files, %d threads, more %v", len(got.Files), len(got.Threads), got.More)
	}
	if got.Files[2999].Path != "f2999" || got.Files[0].Threads != 300 {
		t.Fatalf("last file %q, first file's threads %d", got.Files[2999].Path, got.Files[0].Threads)
	}
	if len(pr.queries) != 30 {
		t.Fatalf("%d GraphQL queries", len(pr.queries))
	}
	first, fourth := pr.queries[0].Variables, pr.queries[3].Variables
	if first["files"] != true || first["threads"] != true || fourth["files"] != true || fourth["threads"] != false {
		t.Fatalf("first %v, fourth %v", first, fourth)
	}
}

// Exactly at the limits is not "more".
func TestFilesAtTheLimitsIsNotMore(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t, head: staticHead(headA)}
	for i := 0; i < 3000; i++ {
		pr.files = append(pr.files, fileNode(fmt.Sprintf("f%04d", i), "MODIFIED", "UNVIEWED", 1, 1))
	}
	for i := 0; i < 300; i++ {
		pr.threads = append(pr.threads, threadNode(fmt.Sprintf("T%d", i), "f0000", nil))
	}
	fakeGitHubREST(t, pr.handler(), restFilesPages(t, nil, 100, headA, nil))
	got, err := newClient("github.com").files(ctxBG(), testRepo, 7)
	if err != nil || len(got.Files) != 3000 || len(got.Threads) != 300 || got.More {
		t.Fatalf("%d files, %d threads, more %v, err %v", len(got.Files), len(got.Threads), got.More, err)
	}
}

// A thread with more comments than were fetched says so.
func TestFilesMoreCommentsThanFetched(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t, head: staticHead(headA)}
	pr.files = []map[string]any{fileNode("a.rb", "MODIFIED", "UNVIEWED", 1, 1)}
	pr.threads = []map[string]any{threadNode("T", "a.rb", map[string]any{
		"comments": map[string]any{"pageInfo": map[string]any{"hasNextPage": true}, "nodes": []any{commentNode("C", "x", "y", "SUBMITTED")}},
	})}
	fakeGitHubREST(t, pr.handler(), restFilesPages(t, nil, 100, headA, nil))
	got, err := newClient("github.com").files(ctxBG(), testRepo, 7)
	if err != nil || !got.More || len(got.Threads[0].Comments) != 1 {
		t.Fatalf("%+v %v", got, err)
	}
}

// GitHub answers part of it (and says what's missing): what came back shows,
// and says there's more.
func TestFilesPartialAnswer(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t, head: staticHead(headA), errors: []map[string]any{{"type": "FORBIDDEN", "message": "SAML"}}}
	pr.files = []map[string]any{fileNode("a.rb", "MODIFIED", "UNVIEWED", 1, 1)}
	fakeGitHubREST(t, pr.handler(), restFilesPages(t, nil, 100, headA, nil))
	got, err := newClient("github.com").files(ctxBG(), testRepo, 7)
	if err != nil || !got.More || len(got.Files) != 1 {
		t.Fatalf("%+v %v", got, err)
	}
}

// A push between two pages: start over once; a second one is an error to
// press r on (not a stale answer: reloading is what's being asked).
func TestFilesHeadMovesBetweenPages(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t}
	for i := 0; i < 250; i++ {
		pr.files = append(pr.files, fileNode(fmt.Sprintf("f%03d", i), "MODIFIED", "UNVIEWED", 1, 1))
	}
	// Call 1 sees a new head; the restart (calls 3, 4, 5) is steady on it.
	pr.head = func(call int) string {
		if call == 0 || call == 1 {
			return map[int]string{0: headA, 1: headB}[call]
		}
		return headB
	}
	fakeGitHubREST(t, pr.handler(), restFilesPages(t, nil, 100, headB, nil))
	got, err := newClient("github.com").files(ctxBG(), testRepo, 7)
	if err != nil || got.Head != headB || len(got.Files) != 250 {
		t.Fatalf("head %s, %d files, err %v", got.Head, len(got.Files), err)
	}

	pr = &fakePR{t: t, files: pr.files}
	pr.head = func(call int) string { return []string{headA, headB, headA, headB, headA, headB}[call%6] }
	fakeGitHubREST(t, pr.handler(), nil)
	_, err = newClient("github.com").files(ctxBG(), testRepo, 7)
	var st *staleError
	if err == nil || !strings.Contains(err.Error(), "press r") || errors.As(err, &st) {
		t.Fatalf("err %v", err)
	}
}

// REST can't be had, or the head moved while it was read: the files still
// answer, with no old paths, and nothing is cached.
func TestFilesWithoutRESTStillAnswer(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t, head: staticHead(headA)}
	pr.files = []map[string]any{fileNode("b.rb", "RENAMED", "UNVIEWED", 0, 0)}
	rest := []restFile{{Filename: "b.rb", PreviousFilename: "a.rb", Status: "renamed", SHA: "2"}}

	fakeGitHubREST(t, pr.handler(), func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", 502) })
	got, err := newClient("github.com").files(ctxBG(), testRepo, 7)
	if err != nil || got.Files[0].From != "" {
		t.Fatalf("REST failing: %+v %v", got.Files, err)
	}

	pr.after = headB // a push lands while REST is read
	fakeGitHubREST(t, pr.handler(), restFilesPages(t, rest, 100, headA, nil))
	got, err = newClient("github.com").files(ctxBG(), testRepo, 7)
	if err != nil || got.Files[0].From != "" {
		t.Fatalf("head moving: %+v %v", got.Files, err)
	}
	if names := cacheNames(t); len(names) != 0 {
		t.Fatalf("cached anyway: %v", names)
	}

	pr.after = "" // steady: the old path shows
	fakeGitHubREST(t, pr.handler(), restFilesPages(t, rest, 100, headA, nil))
	got, err = newClient("github.com").files(ctxBG(), testRepo, 7)
	if err != nil || got.Files[0].From != "a.rb" {
		t.Fatalf("steady: %+v %v", got.Files, err)
	}
}

// With a cache file for the head, `files` takes the old paths from it and
// makes no REST call.
func TestFilesTakesOldPathsFromTheCache(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t, head: staticHead(headA)}
	pr.files = []map[string]any{fileNode("b.rb", "RENAMED", "UNVIEWED", 0, 0)}
	if err := writeDiffCache(testRepo, 7, headA, []restFile{{Filename: "b.rb", PreviousFilename: "a.rb", Status: "renamed", SHA: "2"}}, time.Now()); err != nil {
		t.Fatal(err)
	}
	fakeGitHub(t, pr.handler()) // any REST request fails the test
	got, err := newClient("github.com").files(ctxBG(), testRepo, 7)
	if err != nil || got.Files[0].From != "a.rb" || pr.headQs != 0 {
		t.Fatalf("%+v %v (%d head reads)", got.Files, err, pr.headQs)
	}
}

func TestFilesPRThatIsntThere(t *testing.T) {
	fakeGitHub(t, func(w http.ResponseWriter, r *http.Request) {
		reply(w, map[string]any{"repository": map[string]any{"pullRequest": nil}})
	})
	_, err := newClient("github.com").files(ctxBG(), testRepo, 7)
	if err == nil || !strings.Contains(err.Error(), "o/r#7 isn't there") {
		t.Fatalf("err %v", err)
	}
}

// reviewNode is a review as GraphQL sends it.
func reviewNode(id, state string, mine bool, comments int, commit string) map[string]any {
	return map[string]any{"id": id, "body": "overall\nthoughts", "state": state, "viewerDidAuthor": mine,
		"commit": map[string]any{"oid": commit}, "comments": map[string]any{"totalCount": comments}}
}

// `files` says whose PR it is, its state, the viewer's pending review and
// what the viewer may do to each thread and comment.
func TestFilesCarryTheReviewAndPermissions(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t, head: staticHead(headA), mine: true}
	pr.reviews = []map[string]any{
		reviewNode("PRR_other", "PENDING", false, 9, headA), // someone else's: never the viewer's
		reviewNode("PRR_mine", "PENDING", true, 3, headB),
	}
	for i := 0; i < 150; i++ {
		pr.files = append(pr.files, fileNode(fmt.Sprintf("f%03d", i), "MODIFIED", "UNVIEWED", 1, 1))
	}
	c := commentNode("C1", "me", "mine", "PENDING")
	c["viewerDidAuthor"], c["viewerCanUpdate"], c["viewerCanDelete"] = true, true, true
	pr.threads = []map[string]any{threadNode("T", "f000", map[string]any{
		"viewerCanReply": true, "viewerCanResolve": false, "viewerCanUnresolve": true,
		"comments": map[string]any{"pageInfo": map[string]any{"hasNextPage": false}, "nodes": []any{c, commentNode("C2", "you", "theirs", "SUBMITTED")}},
	})}
	fakeGitHubREST(t, pr.handler(), restFilesPages(t, nil, 100, headA, nil))
	got, err := newClient("github.com").files(ctxBG(), testRepo, 7)
	if err != nil {
		t.Fatal(err)
	}
	if want := (prInfo{ID: "PR_x", Mine: true, State: "open"}); got.PR != want {
		t.Fatalf("pr %+v", got.PR)
	}
	if want := (reviewInfo{ID: "PRR_mine", Body: "overall\nthoughts", Comments: 3, Commit: headB}); got.Review == nil || *got.Review != want {
		t.Fatalf("review %+v", got.Review)
	}
	th := got.Threads[0]
	if !th.CanReply || th.CanResolve || !th.CanUnresolve {
		t.Fatalf("thread permissions %+v", th)
	}
	mine, theirs := th.Comments[0], th.Comments[1]
	if !mine.Mine || !mine.CanEdit || !mine.CanDelete || theirs.Mine || theirs.CanEdit || theirs.CanDelete {
		t.Fatalf("comment permissions %+v %+v", mine, theirs)
	}
	// The PR and its reviews are asked for on the first page only.
	if len(pr.queries) != 2 || pr.queries[0].Variables["review"] != true || pr.queries[1].Variables["review"] != false {
		t.Fatalf("%d queries, review %v", len(pr.queries), pr.queries[0].Variables["review"])
	}
}

// No pending review of the viewer's: review is null, not left out.
func TestFilesWithNoPendingReviewSaysNull(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t, head: staticHead(headA)}
	pr.reviews = []map[string]any{reviewNode("PRR_sent", "COMMENTED", true, 1, headA)}
	fakeGitHubREST(t, pr.handler(), restFilesPages(t, nil, 100, headA, nil))
	got := opRun(t, `{"op":"files",`+opPR+`}`)
	if v, ok := got["review"]; !ok || v != nil {
		t.Fatalf("review %v (present %v)", v, ok)
	}
	if p := got["pr"].(map[string]any); p["id"] != "PR_x" || p["mine"] != false || p["state"] != "open" {
		t.Fatalf("pr %v", p)
	}
}

// `threads`: the threads, the PR and the pending review, in one GraphQL
// request, with no files, no REST and no detail query.
func TestOpThreads(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t, head: staticHead(headA)}
	pr.reviews = []map[string]any{reviewNode("PRR_mine", "PENDING", true, 2, headA)}
	pr.files = []map[string]any{fileNode("a.rb", "MODIFIED", "UNVIEWED", 1, 1)}
	pr.threads = []map[string]any{
		threadNode("T2", "b.rb", map[string]any{"line": 1, "startLine": 1}),
		threadNode("T1", "a.rb", map[string]any{"line": 9, "startLine": 9}),
	}
	fakeGitHubREST(t, pr.handler(), nil) // any REST request fails the test
	got := opRun(t, `{"op":"threads",`+opPR+`}`)
	if _, ok := got["files"]; ok {
		t.Fatalf("threads answered files: %v", got)
	}
	for _, k := range []string{"head", "pr", "review", "threads", "more"} {
		if _, ok := got[k]; !ok {
			t.Fatalf("no %s in %v", k, got)
		}
	}
	typed := demoRunAs[threadsAnswer](t, `{"op":"threads",`+opPR+`}`)
	if typed.Head != headA || typed.Review == nil || typed.Review.ID != "PRR_mine" || len(typed.Threads) != 2 || typed.Threads[0].ID != "T1" {
		t.Fatalf("%+v", typed)
	}
	if len(pr.queries) != 2 || pr.headQs != 0 {
		t.Fatalf("%d queries, %d head reads", len(pr.queries), pr.headQs)
	}
	for _, q := range pr.queries {
		if q.Variables["files"] != false || strings.Contains(q.Query, "mergeStateStatus") {
			t.Fatalf("asked for files or the detail: %v", q.Variables)
		}
	}
}

// submittedNode is a review as the `submitted` read sends it.
func submittedNode(id, state string, mine bool, at any) map[string]any {
	return map[string]any{"id": id, "state": state, "viewerDidAuthor": mine, "submittedAt": at}
}

// `threads` carries the viewer's latest submitted review (A6): not someone
// else's, not the pending one, the latest by when it was submitted; null
// when there's none. It's read on the first page, under its own alias.
func TestThreadsCarryTheViewersLatestSubmittedReview(t *testing.T) {
	cacheFixture(t)
	pr := &fakePR{t: t, head: staticHead(headA)}
	pr.submitted = []map[string]any{
		submittedNode("PRR_late", "APPROVED", true, "2026-11-19T10:00:05Z"),
		submittedNode("PRR_early", "COMMENTED", true, "2026-11-19T10:00:00Z"),
		submittedNode("PRR_theirs", "CHANGES_REQUESTED", false, "2026-11-19T11:00:00Z"),
		submittedNode("PRR_pending", "PENDING", true, nil),
	}
	fakeGitHubREST(t, pr.handler(), nil)
	got := demoRunAs[threadsAnswer](t, `{"op":"threads",`+opPR+`}`)
	want := submittedInfo{ID: "PRR_late", State: "approved", At: time.Date(2026, 11, 19, 10, 0, 5, 0, time.UTC).UnixMilli()}
	if got.Submitted == nil || *got.Submitted != want {
		t.Fatalf("submitted %+v", got.Submitted)
	}
	q := pr.queries[0].Query
	if !strings.Contains(q, "submitted: reviews(last: 10) @include(if: $review) {") {
		t.Fatalf("the submitted read isn't aliased, or its directive isn't before its braces:\n%s", q)
	}

	pr.submitted = []map[string]any{submittedNode("PRR_pending", "PENDING", true, nil), submittedNode("PRR_theirs", "COMMENTED", false, "2026-11-19T11:00:00Z")}
	raw := opRun(t, `{"op":"threads",`+opPR+`}`)
	if v, ok := raw["submitted"]; !ok || v != nil {
		t.Fatalf("submitted %v (present %v)", v, ok)
	}
}
