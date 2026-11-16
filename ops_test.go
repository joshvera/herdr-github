package main

import (
	"fmt"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

// opRun is one request to the app on a fresh state dir's behalf, through
// runApp as the mod would, on whatever the fake GitHub is.
func opRun(t *testing.T, req string) map[string]any {
	t.Helper()
	t.Cleanup(func() { labelStateFile = "labels.json" })
	return appRun(t, req)
}

const opPR = `"pr":{"host":"github.com","repo":"o/r","number":7}`

func diffReq(head, path string) string {
	return `{"op":"diff",` + opPR + `,"head":"` + head + `","path":"` + path + `"}`
}

func actReq(do, head, path string) string {
	return `{"op":"act","do":"` + do + `",` + opPR + `,"head":"` + head + `","path":"` + path + `"}`
}

// opsGraphQL serves a PR's head to the PR-head query (each head in turn, the
// last for ever after) and records mutations; any other query fails the test.
type opsGraphQL struct {
	t         *testing.T
	mu        sync.Mutex
	heads     []string
	headReads int
	mutations []gqlRequest
}

func (o *opsGraphQL) handler() http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		req := decodeReq(o.t, r)
		o.mu.Lock()
		defer o.mu.Unlock()
		switch {
		case strings.HasPrefix(strings.TrimSpace(req.Query), "mutation"):
			o.mutations = append(o.mutations, req)
			reply(w, map[string]any{"ok": map[string]any{"clientMutationId": nil}})
		case strings.Contains(req.Query, "pullRequest(number: $n) { id headRefOid }"):
			i := o.headReads
			if i >= len(o.heads) {
				i = len(o.heads) - 1
			}
			o.headReads++
			reply(w, map[string]any{"repository": map[string]any{"pullRequest": map[string]any{"id": "PR_x", "headRefOid": o.heads[i]}}})
		default:
			o.t.Errorf("unexpected query: %.80s", req.Query)
			http.Error(w, "no", http.StatusInternalServerError)
		}
	}
}

// A `diff` for an uncached head fetches and keeps; the next one (a new
// process, in life) answers from the cache and asks GitHub for nothing:
// not the PR, not its detail, not the head.
func TestOpDiffFetchesOnceThenAnswersWithNoRequest(t *testing.T) {
	cacheFixture(t)
	gql := &opsGraphQL{t: t, heads: []string{headA}}
	var rest int
	files := []restFile{{Filename: "a.rb", Status: "modified", Changes: 2, SHA: "1", Patch: "@@ -1,2 +1,2 @@\n keep\n-old\n+new"}}
	fakeGitHubREST(t, gql.handler(), restFilesPages(t, files, 100, headA, &rest))

	first := opRun(t, diffReq(headA, "a.rb"))
	if first["state"] != "ok" || first["head"] != headA || first["path"] != "a.rb" || len(first["rows"].([]any)) != 4 {
		t.Fatalf("first: %v", first)
	}
	if gql.headReads != 2 || rest != 1 {
		t.Fatalf("a fetch reads the head before and after the pages: %d head reads, %d REST pages", gql.headReads, rest)
	}

	fakeGitHubREST(t, nil, nil) // any request at all fails the test
	second := opRun(t, diffReq(headA, "a.rb"))
	if fmt.Sprint(second) != fmt.Sprint(first) {
		t.Fatalf("second: %v", second)
	}
}

// The diff's states, from the cache (no network). Each is a real answer.
func TestOpDiffStates(t *testing.T) {
	cacheFixture(t)
	var big strings.Builder
	big.WriteString("@@ -0,0 +1,5001 @@")
	for i := 0; i < 5001; i++ {
		big.WriteString("\n+x")
	}
	files := []restFile{
		{Filename: "ok.rb", Status: "modified", Changes: 2, SHA: "1", Patch: "@@ -1 +1 @@ def run\n-a\n+b\n\\ No newline at end of file"},
		{Filename: "logo.png", Status: "modified", SHA: "2"},
		{Filename: "huge.sql", Status: "modified", Changes: 90000, SHA: "3"},
		{Filename: "pure_rename.rb", PreviousFilename: "old.rb", Status: "renamed", SHA: "4"},
		{Filename: "empty.txt", Status: "added", SHA: emptyBlobSHA},
		{Filename: "many.txt", Status: "added", Changes: 5001, SHA: "5", Patch: big.String()},
		{Filename: "crlf.txt", Status: "modified", Changes: 2, SHA: "6", Patch: "@@ -1 +1 @@\r\n-a\r\n+b\r\n"},
	}
	if err := writeDiffCache(testRepo, 7, headA, files, time.Now()); err != nil {
		t.Fatal(err)
	}
	fakeGitHubREST(t, nil, nil)

	for path, want := range map[string]string{
		"ok.rb": "ok", "logo.png": "binary", "huge.sql": "large", "pure_rename.rb": "empty",
		"empty.txt": "empty", "many.txt": "large", "crlf.txt": "ok",
	} {
		got := opRun(t, diffReq(headA, path))
		if got["state"] != want {
			t.Errorf("%s: state %v, want %s", path, got["state"], want)
		}
		rows, _ := got["rows"].([]any)
		if (want == "ok") != (len(rows) > 0) {
			t.Errorf("%s: %d rows", path, len(rows))
		}
		if rows == nil {
			t.Errorf("%s: rows must be [] not null: %v", path, got)
		}
	}
	// The note keeps its kind and its text; the hunk header its section name.
	rows := opRun(t, diffReq(headA, "ok.rb"))["rows"].([]any)
	if r := rows[0].(map[string]any); r["kind"] != "hunk" || r["text"] != "@@ -1 +1 @@ def run" {
		t.Fatalf("hunk row %v", r)
	}
	if r := rows[3].(map[string]any); r["kind"] != "note" || r["text"] != `\ No newline at end of file` {
		t.Fatalf("note row %v", r)
	}
	// A path that isn't in the PR is an error that names it.
	if res := opRun(t, diffReq(headA, "nope.rb")); res["error"] == nil || !strings.Contains(res["error"].(string), "nope.rb") {
		t.Fatalf("%v", res)
	}
}

// The patch's line breaks survive: rows are parsed before sanitizing.
func TestOpDiffKeepsALinePerRowThroughSanitizing(t *testing.T) {
	cacheFixture(t)
	patch := "@@ -1,3 +1,3 @@\n a\n-b\x1b]52;c;AAAA\x07\n+c\n"
	if err := writeDiffCache(testRepo, 7, headA, []restFile{{Filename: "a", Status: "modified", Changes: 2, SHA: "1", Patch: patch}}, time.Now()); err != nil {
		t.Fatal(err)
	}
	fakeGitHubREST(t, nil, nil)
	rows := opRun(t, diffReq(headA, "a"))["rows"].([]any)
	if len(rows) != 4 || rows[2].(map[string]any)["text"] != "b" {
		t.Fatalf("%v", rows)
	}
}

// GitHub is on another head than the one asked for: the files are kept under
// the head found (so the `files` that follows is free), and the diff is stale.
func TestOpDiffStaleWhenThePRMovedOn(t *testing.T) {
	cacheFixture(t)
	gql := &opsGraphQL{t: t, heads: []string{headB}}
	files := []restFile{{Filename: "a.rb", Status: "modified", Changes: 2, SHA: "1", Patch: "@@ -1 +1 @@\n-a\n+b"}}
	fakeGitHubREST(t, gql.handler(), restFilesPages(t, files, 100, headB, nil))
	got := opRun(t, diffReq(headA, "a.rb"))
	if got["state"] != "stale" || got["head"] != headB || len(got["rows"].([]any)) != 0 || got["error"] != nil {
		t.Fatalf("%v", got)
	}
	if _, ok := readDiffCache(testRepo, 7, headB); !ok {
		t.Fatal("the files at the head found weren't kept")
	}
	if _, ok := readDiffCache(testRepo, 7, headA); ok {
		t.Fatal("the files were kept under the head asked for")
	}
}

// Stale even when the files can't be had: the mod reloads either way.
func TestOpDiffStaleBeatsAFailedFetch(t *testing.T) {
	cacheFixture(t)
	gql := &opsGraphQL{t: t, heads: []string{headB}}
	fakeGitHubREST(t, gql.handler(), func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", 502) })
	if got := opRun(t, diffReq(headA, "a.rb")); got["state"] != "stale" {
		t.Fatalf("%v", got)
	}
}

// A push lands while the pages are read: nothing is kept.
func TestOpDiffStaleWhenTheHeadMovesDuringTheFetch(t *testing.T) {
	cacheFixture(t)
	gql := &opsGraphQL{t: t, heads: []string{headA, headB}}
	files := []restFile{{Filename: "a.rb", Status: "modified", Changes: 2, SHA: "1", Patch: "@@ -1 +1 @@\n-a\n+b"}}
	fakeGitHubREST(t, gql.handler(), restFilesPages(t, files, 100, headA, nil))
	got := opRun(t, diffReq(headA, "a.rb"))
	if got["state"] != "stale" || got["head"] != headB {
		t.Fatalf("%v", got)
	}
	if names := cacheNames(t); len(names) != 0 {
		t.Fatalf("kept anyway: %v", names)
	}
}

// REST names the commit it served (contents_url ref): other than the head
// GitHub says, nothing is kept.
func TestOpDiffStaleWhenRESTNamesAnotherCommit(t *testing.T) {
	cacheFixture(t)
	gql := &opsGraphQL{t: t, heads: []string{headA}}
	files := []restFile{{Filename: "a.rb", Status: "modified", Changes: 2, SHA: "1", Patch: "@@ -1 +1 @@\n-a\n+b"}}
	fakeGitHubREST(t, gql.handler(), restFilesPages(t, files, 100, headB, nil))
	got := opRun(t, diffReq(headA, "a.rb"))
	if got["state"] != "stale" || got["head"] != headB {
		t.Fatalf("%v", got)
	}
	if names := cacheNames(t); len(names) != 0 {
		t.Fatalf("kept anyway: %v", names)
	}
}

func TestOpDiffRESTFailureIsAnError(t *testing.T) {
	cacheFixture(t)
	gql := &opsGraphQL{t: t, heads: []string{headA}}
	fakeGitHubREST(t, gql.handler(), func(w http.ResponseWriter, r *http.Request) { http.Error(w, `{"message":"Server Error"}`, 500) })
	got := opRun(t, diffReq(headA, "a.rb"))
	if got["error"] == nil || got["stale"] != nil || got["state"] != nil {
		t.Fatalf("%v", got)
	}
}

func TestOpSignedOutAnswersAsEverythingElseDoes(t *testing.T) {
	cacheFixture(t)
	fakeGitHub(t, func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusUnauthorized) })
	for _, req := range []string{`{"op":"files",` + opPR + `}`, diffReq(headA, "a"), actReq("viewed", headA, "a")} {
		if got := opRun(t, req); got["signedOut"] != "github.com" {
			t.Errorf("%s: %v", req, got)
		}
	}
}

// A head from a request is a commit id before it's used for anything; no
// request is made for one that isn't.
func TestOpHeadMustBeACommitID(t *testing.T) {
	cacheFixture(t)
	fakeGitHubREST(t, nil, nil) // any request fails the test
	for _, head := range []string{"", "../../etc/passwd", strings.ToUpper(headA), headA[:39], headA + "0", "g" + headA[1:]} {
		for _, req := range []string{diffReq(head, "a.rb"), actReq("viewed", head, "a.rb"), actReq("unviewed", head, "a.rb")} {
			if got := opRun(t, req); got["error"] == nil || got["ok"] != nil || got["state"] != nil {
				t.Errorf("head %q: %v", head, got)
			}
		}
	}
	for _, req := range []string{diffReq(headA, ""), actReq("viewed", headA, "")} {
		if got := opRun(t, req); got["error"] == nil {
			t.Errorf("no path: %v", got)
		}
	}
	// A 64-hex head (a SHA-256 repo) is a commit id too.
	if _, ok := readDiffCache(testRepo, 7, strings.Repeat("a", 64)); ok {
		t.Fatal("nothing was written")
	}
	if err := checkHeadAndPath(appRequest{Op: "diff", Head: strings.Repeat("a", 64), Path: "x"}); err != nil {
		t.Fatal(err)
	}
}

// Marks a file viewed: the PR's head is checked, then the mutation is sent
// with the PR's ID and the path, and nothing else is asked of GitHub.
func TestOpActViewedAndUnviewed(t *testing.T) {
	cacheFixture(t)
	gql := &opsGraphQL{t: t, heads: []string{headA}}
	fakeGitHubREST(t, gql.handler(), nil)
	got := opRun(t, actReq("viewed", headA, "api/a.rb"))
	if got["ok"] != true || got["note"] != "Marked api/a.rb as viewed" {
		t.Fatalf("%v", got)
	}
	got = opRun(t, actReq("unviewed", headA, "api/a.rb"))
	if got["ok"] != true || got["note"] != "Marked api/a.rb as not viewed" {
		t.Fatalf("%v", got)
	}
	if len(gql.mutations) != 2 {
		t.Fatalf("%d mutations", len(gql.mutations))
	}
	for i, want := range []string{"markFileAsViewed", "unmarkFileAsViewed"} {
		m := gql.mutations[i]
		if !strings.Contains(m.Query, want+"(input: {pullRequestId: $id, path: $path})") || m.Variables["id"] != "PR_x" || m.Variables["path"] != "api/a.rb" {
			t.Errorf("mutation %d: %v", i, m)
		}
	}
	if strings.Count(gql.mutations[0].Query, "unmark") != 0 {
		t.Error("viewed sent the unmark mutation")
	}
}

// The PR has new commits since the files were shown: nothing is marked, and
// the answer is an error that says it's stale.
func TestOpActRefusesOnAStaleHead(t *testing.T) {
	cacheFixture(t)
	gql := &opsGraphQL{t: t, heads: []string{headB}}
	fakeGitHubREST(t, gql.handler(), nil)
	for _, do := range []string{"viewed", "unviewed"} {
		got := opRun(t, actReq(do, headA, "a.rb"))
		if got["stale"] != true || got["error"] == nil || got["ok"] != nil || len(got) != 2 {
			t.Fatalf("%s: %v", do, got)
		}
	}
	if len(gql.mutations) != 0 {
		t.Fatalf("%d mutations were sent on a stale head", len(gql.mutations))
	}
}
