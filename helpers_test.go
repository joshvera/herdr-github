package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/charmbracelet/bubbles/cursor"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
)

// TestMain keeps the suite away from the real machine: its own state and
// config dirs, no herdr socket, no background processes, a fixed clock.
func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "herdr-github-test")
	if err != nil {
		panic(err)
	}
	os.Setenv("HERDR_PLUGIN_STATE_DIR", dir+"/state")
	os.Setenv("HERDR_PLUGIN_CONFIG_DIR", dir+"/config")
	os.Setenv("CLAUDE_CONFIG_DIR", dir+"/claude")
	for _, v := range []string{"GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"} {
		os.Unsetenv(v)
	}
	herdrCallFn = func(method string, _ any, _ any) error { return errors.New("no herdr in tests: " + method) }
	spawnTickFn = func() {}
	tokenFn = func(context.Context, string) (string, error) { return "", errors.New("no tokens in tests") }
	fixed := time.Date(2026, 9, 24, 12, 0, 0, 0, time.UTC)
	nowFn = func() time.Time { return fixed }
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// fakeGitHub serves the GraphQL endpoint from h, with a token that works.
// Any REST request fails the test: use fakeGitHubREST for those.
func fakeGitHub(t *testing.T, h http.HandlerFunc) {
	t.Helper()
	fakeGitHubREST(t, h, nil)
}

// fakeGitHubREST serves GraphQL from gql and REST from rest, on one server
// (every host points at it). A nil handler fails the test if it's asked.
// REST paths arrive as GitHub's own, e.g. /repos/o/r/pulls/1/files, since
// the base URL is the server's /rest.
func fakeGitHubREST(t *testing.T, gql, rest http.HandlerFunc) {
	t.Helper()
	unexpected := func(kind string) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			t.Errorf("unexpected %s request: %s", kind, r.URL)
			http.Error(w, "not expected", http.StatusInternalServerError)
		}
	}
	if gql == nil {
		gql = unexpected("GraphQL")
	}
	if rest == nil {
		rest = unexpected("REST")
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/rest/", func(w http.ResponseWriter, r *http.Request) {
		r.URL.Path = strings.TrimPrefix(r.URL.Path, "/rest")
		rest(w, r)
	})
	mux.HandleFunc("/", gql)
	srv := httptest.NewServer(mux)
	oldE, oldR, oldT := endpointFn, restEndpointFn, tokenFn
	endpointFn = func(string) string { return srv.URL }
	restEndpointFn = func(string) string { return srv.URL + "/rest" }
	tokenFn = func(context.Context, string) (string, error) { return "tok", nil }
	t.Cleanup(func() {
		srv.Close()
		endpointFn, restEndpointFn, tokenFn = oldE, oldR, oldT
	})
}

// restFilesPages serves a PR's REST files in pages of pageSize, as GitHub
// does: ?page=N, and a Link header naming the next page while there is one.
// Every file's contents_url names ref, unless the file is removed.
func restFilesPages(t *testing.T, files []restFile, pageSize int, ref string, hits *int) http.HandlerFunc {
	t.Helper()
	return func(w http.ResponseWriter, r *http.Request) {
		if hits != nil {
			*hits++
		}
		if got := r.Header.Get("Authorization"); got != "bearer tok" {
			t.Errorf("Authorization = %q", got)
		}
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		if r.URL.Query().Get("per_page") != "100" || page < 1 {
			t.Errorf("query %q", r.URL.RawQuery)
		}
		lo, hi := (page-1)*pageSize, page*pageSize
		if lo > len(files) {
			lo = len(files)
		}
		if hi > len(files) {
			hi = len(files)
		}
		if hi < len(files) {
			// GitHub's Link names its own host; the client mustn't follow it.
			w.Header().Set("Link", fmt.Sprintf(`<https://api.example.invalid/x?page=%d>; rel="next", <https://api.example.invalid/x?page=9>; rel="last"`, page+1))
		}
		out := []map[string]any{}
		for _, f := range files[lo:hi] {
			m := map[string]any{"filename": f.Filename, "status": f.Status, "changes": f.Changes, "sha": f.SHA}
			if f.PreviousFilename != "" {
				m["previous_filename"] = f.PreviousFilename
			}
			if f.Patch != "" {
				m["patch"] = f.Patch
			}
			if f.Status != "removed" && ref != "" {
				m["contents_url"] = "https://api.github.com/repos/o/r/contents/" + f.Filename + "?ref=" + ref
			}
			out = append(out, m)
		}
		_ = json.NewEncoder(w).Encode(out)
	}
}

// demoModel is the picker on the demo org, tab t loaded, worktrees marked.
func demoModel(t *testing.T, tb tab) model {
	t.Helper()
	d := newDemoSource()
	home := d.homeRepo()
	m := newModel(context.Background(), withDefaults(config{}), d, "", &home)
	m.width, m.height, m.tab = 110, 34, tb
	// A blinking cursor is a timer that never ends; drive would wait on it.
	m.filter.Cursor.SetMode(cursor.CursorStatic)
	// As Init does: every tab loads at once.
	for _, x := range []tab{tabMine, tabReview, tabRepo} {
		p, err := d.list(context.Background(), x, "")
		if err != nil {
			t.Fatal(err)
		}
		next, _ := m.Update(listMsg{tab: x, repo: d.home.key(), prs: p.prs, gen: m.gen})
		m = next.(model)
	}
	next, _ := m.Update(worktreesMsg{marks: d.worktreeMarks(), gen: m.gen})
	next, _ = next.(model).Update(agentsMsg(d.agents()))
	return next.(model)
}

// onPR puts the cursor on pull request number n, wherever its group lists it.
func onPR(t *testing.T, m model, n int) model {
	t.Helper()
	for i, r := range m.rows() {
		if r.pr != nil && r.pr.Number == n {
			m.cursor = i
			m.scrollTo()
			return m
		}
	}
	t.Fatalf("#%d isn't listed", n)
	return m
}

// lineOf is the screen line that says text, as the popup draws it now.
func lineOf(t *testing.T, m model, text string) int {
	t.Helper()
	for y, l := range strings.Split(stripStyles(m.View()), "\n") {
		if strings.Contains(l, text) {
			return y
		}
	}
	t.Fatalf("nothing on screen says %q:\n%s", text, stripStyles(m.View()))
	return 0
}

// tabX is a column inside tab tb, to click it.
func tabX(m model, tb tab) int {
	_, cells := m.tabBar()
	return cells[tb].x0 + 2
}

// press sends keys one by one, running whatever each one starts to the end.
func press(m model, keys ...string) model {
	for _, k := range keys {
		next, cmd := m.Update(keyMsg(k))
		m = drive(next.(model), cmd)
	}
	return m
}

// drive runs cmd and everything it leads to, feeding each message back in,
// as Bubble Tea would. Spinner ticks are dropped (they'd go on for ever), and
// so is quitting (the model is what's checked).
func drive(m model, cmd tea.Cmd) model {
	queue := []tea.Cmd{cmd}
	for steps := 0; len(queue) > 0 && steps < 200; steps++ {
		c := queue[0]
		queue = queue[1:]
		if c == nil {
			continue
		}
		msg := c()
		switch msg := msg.(type) {
		case nil, spinner.TickMsg, tea.QuitMsg:
			continue
		case tea.BatchMsg:
			queue = append(queue, msg...)
			continue
		}
		next, more := m.Update(msg)
		m = next.(model)
		queue = append(queue, more)
	}
	return m
}

// quits reports whether cmd (run to its end) asks Bubble Tea to quit.
func quits(cmd tea.Cmd) bool {
	queue := []tea.Cmd{cmd}
	for len(queue) > 0 {
		c := queue[0]
		queue = queue[1:]
		if c == nil {
			continue
		}
		switch msg := c().(type) {
		case tea.QuitMsg:
			return true
		case tea.BatchMsg:
			queue = append(queue, msg...)
		}
	}
	return false
}
