package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

const (
	headA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	headB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
)

var testRepo = repoRef{Host: "github.com", Owner: "o", Name: "r"}

func manyFiles(n int) []restFile {
	var out []restFile
	for i := 0; i < n; i++ {
		out = append(out, restFile{Filename: fmt.Sprintf("src/f%04d.go", i), Status: "modified", Changes: 2, SHA: "abc", Patch: "@@ -1 +1 @@\n-a\n+b"})
	}
	return out
}

// A PR's files come in pages of 100, in order, with every page asked for by
// number (never by the URL in the Link header).
func TestRestPagesThroughEveryPage(t *testing.T) {
	var hits int
	files := manyFiles(250)
	files[3].PreviousFilename = "src/old.go"
	files[3].Status = "renamed"
	fakeGitHubREST(t, nil, restFilesPages(t, files, 100, headA, &hits))
	got, err := newClient("github.com").restFetch(context.Background(), testRepo, 7, headA)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, files) {
		t.Fatalf("got %d files, first %+v", len(got), got[0])
	}
	if hits != 3 {
		t.Fatalf("%d requests for 250 files", hits)
	}
}

func TestRestSendsItsHeadersAndPathToTheRepo(t *testing.T) {
	fakeGitHubREST(t, nil, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/repos/o/r/pulls/7/files" {
			t.Errorf("path %q", r.URL.Path)
		}
		if r.Header.Get("User-Agent") != "herdr-github" || r.Header.Get("Accept") != "application/vnd.github+json" {
			t.Errorf("headers %v", r.Header)
		}
		fmt.Fprint(w, "[]")
	})
	if _, err := newClient("github.com").restFetch(context.Background(), testRepo, 7, headA); err != nil {
		t.Fatal(err)
	}
}

// GitHub's Link header says whether there's a next page; the token must not
// follow the URL it names.
func TestRestDoesNotFollowTheLinkHeadersURL(t *testing.T) {
	elsewhere := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Errorf("the token was sent to %s", r.URL)
	}))
	defer elsewhere.Close()
	var pages []string
	fakeGitHubREST(t, nil, func(w http.ResponseWriter, r *http.Request) {
		pages = append(pages, r.URL.Query().Get("page"))
		if r.URL.Query().Get("page") == "1" {
			w.Header().Set("Link", `<`+elsewhere.URL+`/steal?page=2>; rel="next"`)
		}
		fmt.Fprint(w, "[]")
	})
	if _, err := newClient("github.com").restFetch(context.Background(), testRepo, 7, headA); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(pages, []string{"1", "2"}) {
		t.Fatalf("asked for pages %v", pages)
	}
}

// REST caps a PR at 3000 files; a server that never stops saying "next" is
// read for 30 pages and no more.
func TestRestStopsAtThirtyPages(t *testing.T) {
	var hits int
	fakeGitHubREST(t, nil, func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.Header().Set("Link", `<https://x/y?page=99>; rel="next"`)
		fmt.Fprint(w, "[]")
	})
	if _, err := newClient("github.com").restFetch(context.Background(), testRepo, 7, headA); err != nil {
		t.Fatal(err)
	}
	if hits != restMaxPages {
		t.Fatalf("%d requests", hits)
	}
}

func TestRestBaseURLs(t *testing.T) {
	if got := restBase("github.com"); got != "https://api.github.com" {
		t.Fatal(got)
	}
	if got := restBase("ghe.example.com"); got != "https://ghe.example.com/api/v3" {
		t.Fatal(got)
	}
}

func TestRestSignedOut(t *testing.T) {
	fakeGitHubREST(t, nil, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"message":"Bad credentials"}`)
	})
	c := newClient("ghe.example.com")
	_, err := c.restFetch(context.Background(), repoRef{Host: "ghe.example.com", Owner: "o", Name: "r"}, 7, headA)
	var so *signedOutError
	if !errors.As(err, &so) || so.Host != "ghe.example.com" || !errors.Is(err, errSignedOut) {
		t.Fatalf("err %v", err)
	}
	if c.token != "" {
		t.Fatal("a refused token was kept")
	}
	if m := appError(err); m["signedOut"] != "ghe.example.com" {
		t.Fatalf("answer %v", m)
	}
}

// What GitHub says about a failure is typed by someone else too.
func TestRestErrorMessageIsCleaned(t *testing.T) {
	fakeGitHubREST(t, nil, func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		fmt.Fprint(w, `{"message":"rate limited\u001b]52;c;ZXZpbA==\u0007 try later"}`)
	})
	_, err := newClient("github.com").restFetch(context.Background(), testRepo, 7, headA)
	if err == nil || err.Error() != "GitHub: HTTP 403: rate limited try later" {
		t.Fatalf("err %v", err)
	}
}

// Each file names the commit it was served at; a page from another head is
// refused, whichever page it is on.
func TestRestRefusesAPageFromAnotherHead(t *testing.T) {
	files := manyFiles(150)
	fakeGitHubREST(t, nil, restFilesPages(t, files, 100, headB, nil))
	_, err := newClient("github.com").restFetch(context.Background(), testRepo, 7, headA)
	var st *staleError
	if !errors.As(err, &st) || st.Head != headB {
		t.Fatalf("err %v", err)
	}
}

// A removed file's contents_url names the base, and an Enterprise server may
// leave the ref out: neither counts against the head.
func TestRestFilesWithNoRefPass(t *testing.T) {
	files := []restFile{
		{Filename: "gone.go", Status: "removed", Changes: 3, SHA: "x", Patch: "@@ -1 +0,0 @@\n-a"},
		{Filename: "kept.go", Status: "modified", Changes: 2, SHA: "y", Patch: "@@ -1 +1 @@\n-a\n+b"},
	}
	fakeGitHubREST(t, nil, restFilesPages(t, files, 100, headA, nil))
	got, err := newClient("github.com").restFetch(context.Background(), testRepo, 7, headA)
	if err != nil || len(got) != 2 {
		t.Fatalf("%v %v", got, err)
	}
	fakeGitHubREST(t, nil, restFilesPages(t, files, 100, "", nil)) // no contents_url at all
	if got, err = newClient("github.com").restFetch(context.Background(), testRepo, 7, headA); err != nil || len(got) != 2 {
		t.Fatalf("%v %v", got, err)
	}
}

// The patch is kept raw: it's parsed into rows before anything cleans it.
func TestRestKeepsThePatchRaw(t *testing.T) {
	files := []restFile{{Filename: "a.go", Status: "modified", Changes: 2, SHA: "y", Patch: "@@ -1 +1 @@\n-a\r\n+b\x1b[31m"}}
	fakeGitHubREST(t, nil, restFilesPages(t, files, 100, headA, nil))
	got, err := newClient("github.com").restFetch(context.Background(), testRepo, 7, headA)
	if err != nil || got[0].Patch != files[0].Patch {
		t.Fatalf("%+v %v", got, err)
	}
}
