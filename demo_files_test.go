package main

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

const demoPR482 = `"pr":{"host":"github.com","repo":"halcyon/notes-app","number":482}`

// demoRunAs is a demo request through runApp, decoded into the real type.
func demoRunAs[T any](t *testing.T, req string) T {
	t.Helper()
	t.Cleanup(func() { labelStateFile = "labels.json" })
	var out bytes.Buffer
	if err := runApp(context.Background(), withDefaults(config{}), []string{req}, &out); err != nil {
		t.Fatal(err)
	}
	var v T
	if err := json.Unmarshal(out.Bytes(), &v); err != nil {
		t.Fatalf("%v: %s", err, out.String())
	}
	return v
}

func demoFilesReq(t *testing.T) filesAnswer {
	t.Helper()
	return demoRunAs[filesAnswer](t, `{"op":"files","demo":true,`+demoPR482+`}`)
}

func demoDiff(t *testing.T, head, path string) diffAnswer {
	t.Helper()
	return demoRunAs[diffAnswer](t, `{"op":"diff","demo":true,`+demoPR482+`,"head":"`+head+`","path":"`+path+`"}`)
}

// The demo has what the spec asks of one PR: files across two folders, an
// added file, a renamed one, a binary one, a resolved thread, an open thread
// with two comments, and a pending comment.
func TestAppDemoFiles(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	got := demoFilesReq(t)
	if got.Head != demoHead(482) || !headPattern.MatchString(got.Head) {
		t.Fatalf("head %q", got.Head)
	}
	if len(got.Files) != 9 || got.More {
		t.Fatalf("%d files, more %v", len(got.Files), got.More)
	}
	paths := []string{}
	folders := map[string]bool{}
	status := map[string]fileEntry{}
	for _, f := range got.Files {
		paths = append(paths, f.Path)
		folders[filepath.Dir(f.Path)] = true
		status[f.Status] = f
	}
	if !sort.StringsAreSorted(paths) {
		t.Errorf("files aren't in path order: %v", paths)
	}
	if len(folders) < 2 {
		t.Errorf("folders %v", folders)
	}
	if status["added"].Path == "" || status["deleted"].Path == "" || status["modified"].Path == "" {
		t.Errorf("statuses %v", status)
	}
	if r := status["renamed"]; r.From != "Sources/Sync/Markers.swift" || r.Path != "Sources/Sync/ConflictMarkers.swift" {
		t.Errorf("rename %+v", r)
	}

	var resolved, openTwo, pending, outdated, onFile int
	for _, th := range got.Threads {
		switch {
		case th.Resolved:
			resolved++
		case len(th.Comments) == 2:
			openTwo++
		}
		if th.Outdated {
			outdated++
			if th.Line != 0 || th.Hunk == "" {
				t.Errorf("outdated thread %+v", th)
			}
		}
		if th.Subject == "file" {
			onFile++
		}
		for _, c := range th.Comments {
			if c.State == "pending" {
				pending++
			}
			if c.State != "pending" && c.State != "submitted" {
				t.Errorf("comment state %q", c.State)
			}
		}
	}
	if resolved != 1 || openTwo != 1 || pending != 1 || outdated != 1 || onFile != 1 {
		t.Errorf("resolved %d, open with two comments %d, pending %d, outdated %d, on a file %d", resolved, openTwo, pending, outdated, onFile)
	}
	// The counts on the files are the threads', all and unresolved.
	for _, f := range got.Files {
		if f.Path == "Sources/Sync/ThreeWay.swift" && (f.Threads != 2 || f.Open != 1) {
			t.Errorf("ThreeWay counts %+v", f)
		}
	}
}

// Every demo thread that has a line lands on a row of its file's diff, on
// the side it names: the demo is a fair test of placing threads.
func TestAppDemoThreadsLandOnRows(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	files := demoFilesReq(t)
	for _, th := range files.Threads {
		if th.Line == 0 {
			continue
		}
		d := demoDiff(t, files.Head, th.Path)
		found := false
		for _, r := range d.Rows {
			if (th.Side == "right" && r.New == th.Line) || (th.Side == "left" && r.Old == th.Line) {
				found = true
			}
		}
		if !found {
			t.Errorf("thread %s (%s:%d %s) matches no row", th.ID, th.Path, th.Line, th.Side)
		}
	}
}

func TestAppDemoDiffs(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	head := demoHead(482)
	engine := demoDiff(t, head, "Sources/Sync/SyncEngine.swift")
	if engine.State != "ok" || engine.Head != head || engine.Rows[0].Kind != "hunk" || engine.Rows[0].Text != "@@ -138,6 +138,10 @@ final class SyncEngine {" {
		t.Fatalf("%+v", engine.Rows[0])
	}
	if png := demoDiff(t, head, "Tests/SyncTests/Fixtures/conflict.png"); png.State != "binary" || len(png.Rows) != 0 {
		t.Fatalf("binary: %+v", png)
	}
	tests := demoDiff(t, head, "Tests/SyncTests/ThreeWayTests.swift")
	if last := tests.Rows[len(tests.Rows)-1]; last.Kind != "note" {
		t.Fatalf("last row %+v", last)
	}
	if gone := demoDiff(t, head, "Sources/Sync/LegacyMerge.swift"); gone.State != "ok" || gone.Rows[1].Kind != "del" || gone.Rows[1].Old != 1 {
		t.Fatalf("deleted: %+v", gone)
	}
	// Another head than the demo's is stale, as a real PR that moved on is.
	if st := demoDiff(t, headA, "Package.swift"); st.State != "stale" || st.Head != head || len(st.Rows) != 0 || st.Rows == nil {
		t.Fatalf("stale: %+v", st)
	}
	if res := appRun(t, `{"op":"diff","demo":true,`+demoPR482+`,"head":"`+head+`","path":"nope"}`); res["error"] == nil {
		t.Fatal("a file that isn't in the PR should be an error")
	}
	// A PR with no files in the demo has an empty list, not an error.
	empty := demoRunAs[filesAnswer](t, `{"op":"files","demo":true,"pr":{"host":"github.com","repo":"halcyon/notes-app","number":479}}`)
	if empty.Head != demoHead(479) || empty.Files == nil || len(empty.Files) != 0 || empty.Threads == nil {
		t.Fatalf("%+v", empty)
	}
}

// Marking a file viewed changes the demo's saved state, as setDraft does,
// and the next request (a new process) sees it. A stale head refuses.
func TestAppDemoViewed(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	head := demoHead(482)
	viewedOf := func(path string) string {
		for _, f := range demoFilesReq(t).Files {
			if f.Path == path {
				return f.Viewed
			}
		}
		t.Fatalf("%s isn't listed", path)
		return ""
	}
	const path = "Sources/Sync/ThreeWay.swift"
	act := func(do, h string) map[string]any {
		return appRun(t, `{"op":"act","do":"`+do+`","demo":true,`+demoPR482+`,"head":"`+h+`","path":"`+path+`"}`)
	}
	if v := viewedOf(path); v != "unviewed" {
		t.Fatalf("starts %s", v)
	}
	if res := act("viewed", head); res["ok"] != true {
		t.Fatal(res)
	}
	if v := viewedOf(path); v != "viewed" {
		t.Fatalf("after viewed: %s", v)
	}
	if res := act("unviewed", head); res["ok"] != true || viewedOf(path) != "unviewed" {
		t.Fatalf("%v, %s", res, viewedOf(path))
	}
	// A dismissed file (viewed, then changed) is in the demo too, and can be marked viewed.
	if v := viewedOf("Sources/Sync/SyncEngine.swift"); v != "dismissed" {
		t.Fatalf("SyncEngine %s", v)
	}
	// Stale: an error that says so, and nothing changes.
	res := act("viewed", headA)
	if res["stale"] != true || res["error"] == nil || res["ok"] != nil || viewedOf(path) != "unviewed" {
		t.Fatalf("stale: %v", res)
	}
	if res := appRun(t, `{"op":"act","do":"viewed","demo":true,`+demoPR482+`,"head":"`+head+`","path":"nope"}`); res["error"] == nil {
		t.Fatal("a file that isn't in the PR should be an error")
	}
}

// A save from before the demo had files still loads.
func TestAppDemoLoadsAnOlderSave(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	if err := os.MkdirAll(stateDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	old := `{"github.com/halcyon/notes-app#482":{"draft":false,"state":"OPEN","merge":"CLEAN","tree":true}}`
	if err := os.WriteFile(appDemoPath(), []byte(old), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := demoFilesReq(t); len(got.Files) != 9 || got.Files[1].Viewed != "viewed" {
		t.Fatalf("%+v", got.Files)
	}
}

// The demo never contacts GitHub and never touches the disk cache: not to
// read (a file planted for the demo PR's key is ignored) and not to write.
func TestAppDemoNeverTouchesTheDiffCache(t *testing.T) {
	t.Setenv("HERDR_PLUGIN_STATE_DIR", t.TempDir())
	fakeGitHubREST(t, nil, nil) // any request fails the test
	head := demoHead(482)
	r := repoRef{Host: "github.com", Owner: "halcyon", Name: "notes-app"}
	planted := []restFile{{Filename: "Package.swift", Status: "modified", Changes: 2, SHA: "1", Patch: "@@ -1 +1 @@\n-planted\n+planted"}}
	if err := writeDiffCache(r, 482, head, planted, time.Now()); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(diffCachePath(r, 482, head))

	d := demoDiff(t, head, "Package.swift")
	for _, row := range d.Rows {
		if row.Text == "planted" {
			t.Fatal("the demo read the disk cache")
		}
	}
	demoFilesReq(t)
	appRun(t, `{"op":"act","do":"viewed","demo":true,`+demoPR482+`,"head":"`+head+`","path":"Package.swift"}`)
	after, _ := os.ReadFile(diffCachePath(r, 482, head))
	if !bytes.Equal(before, after) || len(cacheNames(t)) != 1 {
		t.Fatalf("the demo wrote to the cache: %v", cacheNames(t))
	}
}

func TestDemoHeadsAreCommitIDs(t *testing.T) {
	for _, p := range newDemoSource().prs {
		if !headPattern.MatchString(p.HeadRefOid) {
			t.Errorf("#%d head %q", p.Number, p.HeadRefOid)
		}
	}
}
