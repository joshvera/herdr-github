package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// The Files changed view's data: the PR's files and review threads from
// GraphQL (paged, within limits), a rename's old path from REST, and one
// file's diff as rows (see patch.go). Everything in an answer is from one
// head commit, and the answer says which.

// Limits: past any of them the answer says more: true. Pages are 100 (files,
// threads) and a thread's first 50 comments, as filesQuery asks.
const (
	maxFiles   = 3000 // REST's own cap too
	maxThreads = 300
)

// ── what the mod gets ─────────────────────────────────────────────────────────

// filesAnswer is the `files` op's answer.
type filesAnswer struct {
	Head    string       `json:"head"`
	Files   []fileEntry  `json:"files"`
	Threads []fileThread `json:"threads"`
	More    bool         `json:"more"` // there's more than was fetched: counts are lower bounds
}

// fileEntry is one changed file. Viewed is viewed, unviewed or dismissed
// (viewed, then changed). Threads and Open count its threads, all and
// unresolved.
type fileEntry struct {
	Path      string `json:"path"`
	From      string `json:"from"` // a rename's or copy's old path
	Status    string `json:"status"`
	Additions int    `json:"additions"`
	Deletions int    `json:"deletions"`
	Viewed    string `json:"viewed"`
	Threads   int    `json:"threads"`
	Open      int    `json:"open"`
}

// fileThread is a review thread. Line is the line it ends on, on Side
// (left: the old file, right: the new one), or 0 when GitHub gives none. A
// multi-line thread has StartLine and StartSide; a single-line one has 0 and "".
type fileThread struct {
	ID           string          `json:"id"`
	Path         string          `json:"path"`
	Subject      string          `json:"subject"` // line, file
	Line         int             `json:"line"`
	Side         string          `json:"side"`
	StartLine    int             `json:"startLine"`
	StartSide    string          `json:"startSide"`
	OriginalLine int             `json:"originalLine"`
	Hunk         string          `json:"hunk"` // only for a line thread with no line: what it was about
	Resolved     bool            `json:"resolved"`
	Outdated     bool            `json:"outdated"`
	Comments     []threadComment `json:"comments"`
}

// threadComment's State is submitted, or pending: the signed-in person's own
// unsent review comment.
type threadComment struct {
	ID      string `json:"id"`
	Author  string `json:"author"`
	Body    string `json:"body"`
	Created int64  `json:"created"` // ms since the epoch
	State   string `json:"state"`
	URL     string `json:"url"`
}

// reviewInfo is the viewer's pending review: its body, how many comments it
// holds, and the commit it's pinned to.
type reviewInfo struct {
	ID       string `json:"id"`
	Body     string `json:"body"`
	Comments int    `json:"comments"`
	Commit   string `json:"commit"`
}

// diffAnswer is the `diff` op's answer.
type diffAnswer struct {
	Head  string    `json:"head"`
	Path  string    `json:"path"`
	State string    `json:"state"`
	Rows  []diffRow `json:"rows"`
}

// ── GraphQL ───────────────────────────────────────────────────────────────────

// Strings in these come out of graphql() cleaned; a hunk (DiffHunk, a
// multiline field) keeps its line breaks.
type gqlFile struct {
	Path              string `json:"path"`
	Additions         int    `json:"additions"`
	Deletions         int    `json:"deletions"`
	ChangeType        string `json:"changeType"`
	ViewerViewedState string `json:"viewerViewedState"`
}

type gqlComment struct {
	ID        string    `json:"id"`
	Author    *actor    `json:"author"`
	Body      string    `json:"body"`
	CreatedAt time.Time `json:"createdAt"`
	State     string    `json:"state"`
	URL       string    `json:"url"`
}

type gqlThread struct {
	ID            string `json:"id"`
	IsResolved    bool   `json:"isResolved"`
	IsOutdated    bool   `json:"isOutdated"`
	Path          string `json:"path"`
	Line          int    `json:"line"`
	StartLine     int    `json:"startLine"`
	OriginalLine  int    `json:"originalLine"`
	DiffSide      string `json:"diffSide"`
	StartDiffSide string `json:"startDiffSide"`
	SubjectType   string `json:"subjectType"`
	Comments      struct {
		PageInfo struct {
			HasNextPage bool `json:"hasNextPage"`
		} `json:"pageInfo"`
		Nodes []gqlComment `json:"nodes"`
	} `json:"comments"`
	// The first comment's hunk, on its own alias so only one comment's is fetched.
	Hunk struct {
		Nodes []struct {
			DiffHunk string `json:"diffHunk"`
		} `json:"nodes"`
	} `json:"hunk"`
}

type pageInfo struct {
	HasNextPage bool   `json:"hasNextPage"`
	EndCursor   string `json:"endCursor"`
}

const filesQuery = `query($owner: String!, $name: String!, $n: Int!, $files: Boolean!, $fa: String, $threads: Boolean!, $ta: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      id headRefOid
      files(first: 100, after: $fa) @include(if: $files) {
        pageInfo { hasNextPage endCursor }
        nodes { path additions deletions changeType viewerViewedState }
      }
      reviewThreads(first: 100, after: $ta) @include(if: $threads) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine originalLine diffSide startDiffSide subjectType
          comments(first: 50) {
            pageInfo { hasNextPage }
            nodes { id author { login } body createdAt state url }
          }
          hunk: comments(first: 1) { nodes { diffHunk } }
        }
      }
    }
  }
}`

// prFiles is what GraphQL has of a PR's files and threads, from one head.
type prFiles struct {
	ID, Head string
	Files    []gqlFile
	Threads  []gqlThread
	More     bool
}

// errMoved: the head changed between two pages.
var errMoved = errors.New("the pull request changed while loading")

// loadFiles reads the PR's files and threads, page by page. If a push lands
// between pages it starts over once; a second time it gives up.
func (c *ghClient) loadFiles(ctx context.Context, r repoRef, number int) (*prFiles, error) {
	for attempt := 0; attempt < 2; attempt++ {
		g, err := c.loadFilesOnce(ctx, r, number)
		if !errors.Is(err, errMoved) {
			return g, err
		}
	}
	return nil, errors.New("the pull request changed while loading; press r")
}

func (c *ghClient) loadFilesOnce(ctx context.Context, r repoRef, number int) (*prFiles, error) {
	var out prFiles
	needFiles, needThreads := true, true
	var fileAfter, threadAfter any // nil until there's a cursor
	for round := 0; needFiles || needThreads; round++ {
		var res struct {
			Repository *struct {
				PullRequest *struct {
					ID         string `json:"id"`
					HeadRefOid string `json:"headRefOid"`
					Files      *struct {
						PageInfo pageInfo  `json:"pageInfo"`
						Nodes    []gqlFile `json:"nodes"`
					} `json:"files"`
					ReviewThreads *struct {
						PageInfo pageInfo    `json:"pageInfo"`
						Nodes    []gqlThread `json:"nodes"`
					} `json:"reviewThreads"`
				} `json:"pullRequest"`
			} `json:"repository"`
		}
		err := c.graphql(ctx, filesQuery, map[string]any{
			"owner": r.Owner, "name": r.Name, "n": number,
			"files": needFiles, "fa": fileAfter, "threads": needThreads, "ta": threadAfter,
		}, &res)
		// A partial answer (a team the token can't see, say) still shows, and
		// says there's more than it has.
		if err != nil && !isPartial(err) {
			return nil, err
		}
		if res.Repository == nil || res.Repository.PullRequest == nil {
			return nil, fmt.Errorf("%s#%d isn't there, or isn't yours to see", r, number)
		}
		out.More = out.More || err != nil
		pr := res.Repository.PullRequest
		if !headPattern.MatchString(pr.HeadRefOid) {
			return nil, fmt.Errorf("GitHub gave no head commit for %s#%d", r, number)
		}
		if round == 0 {
			out.ID, out.Head = pr.ID, pr.HeadRefOid
		} else if pr.HeadRefOid != out.Head {
			return nil, errMoved
		}
		if needFiles && pr.Files != nil {
			out.Files = append(out.Files, pr.Files.Nodes...)
			needFiles = pr.Files.PageInfo.HasNextPage
			fileAfter = pr.Files.PageInfo.EndCursor
			if needFiles && len(out.Files) >= maxFiles {
				needFiles, out.More = false, true
			}
		} else {
			needFiles = false
		}
		if needThreads && pr.ReviewThreads != nil {
			out.Threads = append(out.Threads, pr.ReviewThreads.Nodes...)
			needThreads = pr.ReviewThreads.PageInfo.HasNextPage
			threadAfter = pr.ReviewThreads.PageInfo.EndCursor
			if needThreads && len(out.Threads) >= maxThreads {
				needThreads, out.More = false, true
			}
		} else {
			needThreads = false
		}
	}
	for _, t := range out.Threads {
		if t.Comments.PageInfo.HasNextPage {
			out.More = true
		}
	}
	return &out, nil
}

// ── shaping ───────────────────────────────────────────────────────────────────

var fileStatuses = map[string]string{"ADDED": "added", "MODIFIED": "modified", "DELETED": "deleted", "RENAMED": "renamed", "COPIED": "copied", "CHANGED": "changed"}

func fileStatus(changeType string) string {
	if s, ok := fileStatuses[changeType]; ok {
		return s
	}
	return "changed"
}

var viewedStates = map[string]string{"VIEWED": "viewed", "UNVIEWED": "unviewed", "DISMISSED": "dismissed"}

func viewedState(s string) string {
	if v, ok := viewedStates[s]; ok {
		return v
	}
	return "unviewed"
}

func lowerOr(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return strings.ToLower(s)
}

// shapeThread is a thread as the mod gets it. GitHub gives startLine == line
// for a single-line thread (both on one side), which becomes 0 and ""; a
// thread from one side's line to the other side's line of the same number is
// still multi-line; the first comment's hunk
// is only sent for a line thread with no line to place it on.
func shapeThread(g gqlThread) fileThread {
	t := fileThread{
		ID: g.ID, Path: g.Path, Subject: lowerOr(g.SubjectType, "line"), Line: g.Line,
		Side: lowerOr(g.DiffSide, "right"), OriginalLine: g.OriginalLine,
		Resolved: g.IsResolved, Outdated: g.IsOutdated, Comments: []threadComment{},
	}
	if startSide := lowerOr(g.StartDiffSide, t.Side); g.StartLine != 0 && (g.StartLine != g.Line || startSide != t.Side) {
		t.StartLine, t.StartSide = g.StartLine, startSide
	}
	if t.Line == 0 && t.Subject == "line" && len(g.Hunk.Nodes) > 0 {
		t.Hunk = g.Hunk.Nodes[0].DiffHunk
	}
	for _, c := range g.Comments.Nodes {
		author := "ghost"
		if c.Author != nil {
			author = c.Author.Login
		}
		var created int64
		if !c.CreatedAt.IsZero() {
			created = c.CreatedAt.UnixMilli()
		}
		state := "submitted"
		if strings.EqualFold(c.State, "PENDING") {
			state = "pending"
		}
		t.Comments = append(t.Comments, threadComment{ID: c.ID, Author: author, Body: c.Body, Created: created, State: state, URL: c.URL})
	}
	return t
}

// orderThreads puts threads in file order, then line order (a thread with no
// line first, under the file's header), keeping GitHub's order otherwise;
// a thread on a file that isn't listed goes last.
func orderThreads(files []fileEntry, threads []fileThread) {
	index := map[string]int{}
	for i, f := range files {
		index[f.Path] = i
	}
	rank := func(t fileThread) int {
		if i, ok := index[t.Path]; ok {
			return i
		}
		return len(files)
	}
	sort.SliceStable(threads, func(i, j int) bool {
		a, b := threads[i], threads[j]
		if ra, rb := rank(a), rank(b); ra != rb {
			return ra < rb
		}
		if a.Path != b.Path {
			return a.Path < b.Path
		}
		return a.Line < b.Line
	})
}

// tallyThreads fills each file's thread counts.
func tallyThreads(files []fileEntry, threads []fileThread) {
	index := map[string]int{}
	for i, f := range files {
		index[f.Path] = i
	}
	for _, t := range threads {
		if i, ok := index[t.Path]; ok {
			files[i].Threads++
			if !t.Resolved {
				files[i].Open++
			}
		}
	}
}

// filesFrom is the answer for what GraphQL has, with each rename's old path
// from rest (which may be nil: then From is empty).
func filesFrom(g *prFiles, rest []restFile) filesAnswer {
	from := map[string]string{}
	for _, f := range rest {
		if f.PreviousFilename != "" {
			from[clean(f.Filename, false)] = clean(f.PreviousFilename, false)
		}
	}
	out := filesAnswer{Head: g.Head, Files: []fileEntry{}, Threads: []fileThread{}, More: g.More}
	for _, f := range g.Files {
		out.Files = append(out.Files, fileEntry{
			Path: f.Path, From: from[f.Path], Status: fileStatus(f.ChangeType),
			Additions: f.Additions, Deletions: f.Deletions, Viewed: viewedState(f.ViewerViewedState),
		})
	}
	for _, t := range g.Threads {
		out.Threads = append(out.Threads, shapeThread(t))
	}
	orderThreads(out.Files, out.Threads)
	tallyThreads(out.Files, out.Threads)
	return out
}

// ── the ops, on GitHub ────────────────────────────────────────────────────────

// files answers the `files` op. The old path of a rename comes from REST,
// which is also kept in the cache so a `diff` after it needs no request; if
// REST can't be had (or the head moved while it was read), From stays empty.
func (c *ghClient) files(ctx context.Context, r repoRef, number int) (filesAnswer, error) {
	before := time.Now()
	g, err := c.loadFiles(ctx, r, number)
	if err != nil {
		return filesAnswer{}, err
	}
	rest, err := c.restFilesAt(ctx, r, number, g.Head, before)
	if err != nil && ctx.Err() != nil {
		return filesAnswer{}, ctx.Err()
	}
	return filesFrom(g, rest), nil
}

// diffFrom is one file's diff, from the PR's REST files: its patch parsed
// into rows (see parsePatch), or the state that says why there are none.
func diffFrom(files []restFile, head, path string) (diffAnswer, error) {
	for _, f := range files {
		if clean(f.Filename, false) != path {
			continue
		}
		a := diffAnswer{Head: head, Path: path, State: diffOK, Rows: []diffRow{}}
		if f.Patch == "" {
			a.State = noPatchState(f)
			return a, nil
		}
		rows, large := parsePatch(f.Patch)
		switch {
		case large:
			a.State = diffLarge
		case len(rows) == 0:
			a.State = diffEmpty
		default:
			a.Rows = rows
		}
		return a, nil
	}
	return diffAnswer{}, fmt.Errorf("%q isn't one of this pull request's changed files", path)
}

// diff answers the `diff` op for a head the cache doesn't have (the app
// answers from the cache before it gets here). It reads the PR's head, then
// the files (guarded by restFilesAt, which keeps them under the head it
// found), and answers stale if that isn't the head asked for: the files are
// still kept, so the `files` the mod then asks for is free.
func (c *ghClient) diff(ctx context.Context, r repoRef, number int, head, path string) (diffAnswer, error) {
	before := time.Now()
	_, found, err := c.prHead(ctx, r, number)
	if err != nil {
		return diffAnswer{}, err
	}
	stale := func(now string) diffAnswer {
		return diffAnswer{Head: now, Path: path, State: diffStale, Rows: []diffRow{}}
	}
	files, err := c.restFilesAt(ctx, r, number, found, before)
	var st *staleError
	switch {
	case errors.As(err, &st):
		return stale(st.Head), nil
	case found != head:
		return stale(found), nil
	case err != nil:
		return diffAnswer{}, err
	}
	return diffFrom(files, head, path)
}

// setViewed marks a file viewed or not. The mutation takes only the PR's ID
// and the path, so the head is compared here first, and nothing is marked if
// it moved. A push can still land between the check and the mutation (GitHub
// offers no way to pin it); the worst case is a mark on a file that changed,
// which GitHub shows as dismissed.
func (c *ghClient) setViewed(ctx context.Context, r repoRef, number int, head, path string, viewed bool) error {
	id, current, err := c.prHead(ctx, r, number)
	if err != nil {
		return err
	}
	if current != head {
		return &staleError{Head: current}
	}
	mutation := "unmarkFileAsViewed"
	if viewed {
		mutation = "markFileAsViewed"
	}
	return c.mutate(ctx, `mutation($id: ID!, $path: String!) {
  `+mutation+`(input: {pullRequestId: $id, path: $path}) { clientMutationId }
}`, map[string]any{"id": id, "path": path}, mutation, nil)
}
