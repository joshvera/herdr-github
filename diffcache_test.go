package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// headSeq answers GraphQL's PR head query with each head in turn (the last
// one for every call after), and counts the calls.
func headSeq(t *testing.T, calls *int32, heads ...string) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		req := decodeReq(t, r)
		if req.Variables["n"] == nil {
			t.Errorf("unexpected query %.60s", req.Query)
		}
		i := int(atomic.AddInt32(calls, 1)) - 1
		if i >= len(heads) {
			i = len(heads) - 1
		}
		reply(w, map[string]any{"repository": map[string]any{"pullRequest": map[string]any{"id": "PR_x", "headRefOid": heads[i]}}})
	}
}

func cacheFixture(t *testing.T) {
	t.Helper()
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
}

func cacheNames(t *testing.T) []string {
	t.Helper()
	entries, err := os.ReadDir(diffCacheDir())
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	var out []string
	for _, e := range entries {
		out = append(out, e.Name())
	}
	return out
}

func setAge(t *testing.T, r repoRef, n int, head string, mtime time.Time) {
	t.Helper()
	if err := os.Chtimes(diffCachePath(r, n, head), mtime, mtime); err != nil {
		t.Fatal(err)
	}
}

func headN(c string) string { return strings.Repeat(c, 40) }

func TestDiffCacheRoundTripsPrivately(t *testing.T) {
	cacheFixture(t)
	files := manyFiles(3)
	files[1].Patch = "@@ -1 +1 @@\n-a\r\n+b\x1b[31m" // kept raw
	if _, ok := readDiffCache(testRepo, 7, headA); ok {
		t.Fatal("a hit on an empty cache")
	}
	if err := writeDiffCache(testRepo, 7, headA, files, time.Now()); err != nil {
		t.Fatal(err)
	}
	got, ok := readDiffCache(testRepo, 7, headA)
	if !ok || !reflect.DeepEqual(got, files) {
		t.Fatalf("%v %+v", ok, got)
	}
	info, err := os.Stat(diffCachePath(testRepo, 7, headA))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %v %v", info, err)
	}
	if di, _ := os.Stat(diffCacheDir()); di.Mode().Perm() != 0o700 {
		t.Fatalf("dir mode %v", di.Mode())
	}
	if names := cacheNames(t); len(names) != 1 {
		t.Fatalf("left behind: %v", names)
	}
	// The key is lowercase, one path segment.
	if want := "github.com_o_r_7-" + headA + ".json"; cacheNames(t)[0] != want {
		t.Fatalf("named %q, want %q", cacheNames(t)[0], want)
	}
	// An empty PR is a PR: it's kept too.
	if err := writeDiffCache(testRepo, 8, headA, nil, time.Now()); err != nil {
		t.Fatal(err)
	}
	if got, ok := readDiffCache(testRepo, 8, headA); !ok || len(got) != 0 {
		t.Fatalf("empty: %v %v", ok, got)
	}
}

func TestDiffCacheKeyIsLowercase(t *testing.T) {
	r := repoRef{Host: "GitHub.com", Owner: "Octo", Name: "Repo.Js"}
	if got := diffCacheKey(r, 3); got != "github.com_octo_repo.js_3" {
		t.Fatal(got)
	}
}

// A file that isn't whole, isn't this PR's, or isn't this head's is a miss,
// never an error.
func TestDiffCacheBadFilesAreMisses(t *testing.T) {
	cacheFixture(t)
	if err := os.MkdirAll(diffCacheDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	path := diffCachePath(testRepo, 7, headA)
	for name, content := range map[string]string{
		"empty":      "",
		"cut off":    `{"key":"github.com/o/r#7","head":"` + headA + `","files":[{"filena`,
		"not json":   "hello",
		"wrong head": `{"key":"github.com/o/r#7","head":"` + headB + `","files":[]}`,
		"wrong PR":   `{"key":"github.com/o/other#7","head":"` + headA + `","files":[]}`,
		"no files":   `{"key":"github.com/o/r#7","head":"` + headA + `"}`,
	} {
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, ok := readDiffCache(testRepo, 7, headA); ok {
			t.Errorf("%s: a hit", name)
		}
	}
	if _, ok := readDiffCache(testRepo, 7, "../../etc/passwd"); ok {
		t.Error("a head that isn't a commit id was looked up")
	}
}

// A slow process for an old head finishes after a newer head's was written:
// it must not delete the newer one. Both files are real, with mtimes set.
func TestDiffCachePruneSparesANewerHeadsFile(t *testing.T) {
	cacheFixture(t)
	start := time.Now().Add(-10 * time.Minute) // when A first read the head
	h0, hA, hB := headN("0"), headN("a"), headN("b")

	// B, for the newer head, reads and writes after A began.
	if err := writeDiffCache(testRepo, 7, hB, manyFiles(2), start.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	setAge(t, testRepo, 7, hB, start.Add(2*time.Minute))
	// An older head's file, read long before A began.
	if err := writeDiffCache(testRepo, 7, h0, manyFiles(1), start.Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	setAge(t, testRepo, 7, h0, start.Add(-time.Hour))
	// A, for the old head, writes last.
	if err := writeDiffCache(testRepo, 7, hA, manyFiles(3), start); err != nil {
		t.Fatal(err)
	}

	want := []string{diffCacheKey(testRepo, 7) + "-" + hA + ".json", diffCacheKey(testRepo, 7) + "-" + hB + ".json"}
	if got := cacheNames(t); !reflect.DeepEqual(got, want) {
		t.Fatalf("left %v, want %v (the older head's file goes, the newer one's stays)", got, want)
	}
	if got, ok := readDiffCache(testRepo, 7, hB); !ok || len(got) != 2 {
		t.Fatal("the newer head's file was damaged")
	}
}

// Another PR's files are never touched, even one whose key is this key with
// more on the end (PR 1 and PR 12).
func TestDiffCachePruneLeavesOtherPRsAlone(t *testing.T) {
	cacheFixture(t)
	old := time.Now().Add(-time.Hour)
	for _, n := range []int{1, 12} {
		if err := writeDiffCache(testRepo, n, headB, manyFiles(1), old); err != nil {
			t.Fatal(err)
		}
		setAge(t, testRepo, n, headB, old.Add(-time.Minute))
	}
	other := repoRef{Host: "github.com", Owner: "o", Name: "r2"}
	if err := writeDiffCache(other, 1, headB, manyFiles(1), old); err != nil {
		t.Fatal(err)
	}
	setAge(t, other, 1, headB, old.Add(-time.Minute))

	if err := writeDiffCache(testRepo, 1, headA, manyFiles(1), time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, ok := readDiffCache(testRepo, 1, headB); ok {
		t.Error("PR 1's older head was kept")
	}
	if _, ok := readDiffCache(testRepo, 12, headB); !ok {
		t.Error("PR 12's file was deleted by PR 1's write")
	}
	if _, ok := readDiffCache(other, 1, headB); !ok {
		t.Error("another repo's file was deleted")
	}
}

func TestDiffCacheDropsAnythingOlderThanAWeek(t *testing.T) {
	cacheFixture(t)
	other := repoRef{Host: "github.com", Owner: "o", Name: "r2"}
	for _, n := range []int{1, 2} {
		if err := writeDiffCache(other, n, headB, manyFiles(1), time.Now()); err != nil {
			t.Fatal(err)
		}
	}
	setAge(t, other, 1, headB, time.Now().Add(-8*24*time.Hour))
	setAge(t, other, 2, headB, time.Now().Add(-6*24*time.Hour))
	dir := diffCacheDir()
	orphan, fresh := filepath.Join(dir, "tmp-orphan"), filepath.Join(dir, "tmp-inflight")
	for _, p := range []string{orphan, fresh} {
		if err := os.WriteFile(p, []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	long := time.Now().Add(-9 * 24 * time.Hour)
	if err := os.Chtimes(orphan, long, long); err != nil {
		t.Fatal(err)
	}

	if err := writeDiffCache(testRepo, 7, headA, manyFiles(1), time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, ok := readDiffCache(other, 1, headB); ok {
		t.Error("an 8 day old file stayed")
	}
	if _, ok := readDiffCache(other, 2, headB); !ok {
		t.Error("a 6 day old file went")
	}
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Error("an old orphaned temp file stayed")
	}
	if _, err := os.Stat(fresh); err != nil {
		t.Error("another process's temp file, mid-write, was deleted")
	}
}

// Many processes write and read at once: a reader gets a whole file or a miss.
func TestDiffCacheConcurrentWritersAndReaders(t *testing.T) {
	cacheFixture(t)
	var wg sync.WaitGroup
	files := manyFiles(200)
	for i := 0; i < 8; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				if err := writeDiffCache(testRepo, 7, headA, files, time.Now()); err != nil {
					t.Error(err)
				}
			}
		}()
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				if got, ok := readDiffCache(testRepo, 7, headA); ok && len(got) != 200 {
					t.Errorf("a partial file: %d files", len(got))
				}
			}
		}()
	}
	wg.Wait()
	if names := cacheNames(t); len(names) != 1 {
		t.Fatalf("left behind: %v", names)
	}
}

// Written once; read after with no request made at all.
func TestRestFilesAtWritesOnceThenReadsWithNoRequest(t *testing.T) {
	cacheFixture(t)
	var gql int32
	var rest int
	files := manyFiles(5)
	fakeGitHubREST(t, headSeq(t, &gql, headA), restFilesPages(t, files, 100, headA, &rest))
	c := newClient("github.com")
	got, err := c.restFilesAt(context.Background(), testRepo, 7, headA, time.Now())
	if err != nil || !reflect.DeepEqual(got, files) {
		t.Fatalf("%v %v", got, err)
	}
	if gql != 1 || rest != 1 {
		t.Fatalf("first fetch: %d head reads, %d REST pages", gql, rest)
	}
	if _, ok := readDiffCache(testRepo, 7, headA); !ok {
		t.Fatal("nothing was written")
	}
	got, err = c.restFilesAt(context.Background(), testRepo, 7, headA, time.Now())
	if err != nil || !reflect.DeepEqual(got, files) {
		t.Fatalf("%v %v", got, err)
	}
	if gql != 1 || rest != 1 {
		t.Fatalf("the cached read made requests: %d head reads, %d REST pages", gql, rest)
	}
}

// The head moves while the pages are read: nothing is written, and the
// caller is told it's stale (with the new head).
func TestRestFilesAtWritesNothingWhenTheHeadMoves(t *testing.T) {
	cacheFixture(t)
	var gql int32
	fakeGitHubREST(t, headSeq(t, &gql, headB), restFilesPages(t, manyFiles(5), 100, headA, nil))
	_, err := newClient("github.com").restFilesAt(context.Background(), testRepo, 7, headA, time.Now())
	var st *staleError
	if !errors.As(err, &st) || st.Head != headB {
		t.Fatalf("err %v", err)
	}
	if names := cacheNames(t); len(names) != 0 {
		t.Fatalf("written anyway: %v", names)
	}
}

// REST served another head than the one asked for (a file's ref says so).
func TestRestFilesAtWritesNothingOnARefMismatch(t *testing.T) {
	cacheFixture(t)
	var gql int32
	fakeGitHubREST(t, headSeq(t, &gql, headA), restFilesPages(t, manyFiles(5), 100, headB, nil))
	_, err := newClient("github.com").restFilesAt(context.Background(), testRepo, 7, headA, time.Now())
	var st *staleError
	if !errors.As(err, &st) || st.Head != headB {
		t.Fatalf("err %v", err)
	}
	if gql != 0 {
		t.Fatalf("%d head reads: the mismatch is known before the second one", gql)
	}
	if names := cacheNames(t); len(names) != 0 {
		t.Fatalf("written anyway: %v", names)
	}
}
