package main

import (
	"context"
	"encoding/json"
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

// threadsAnswer is the `threads` op's answer, the cheap poll: the PR's
// review threads and the viewer's pending review, from one head.
type threadsAnswer struct {
	Head string `json:"head"`
	PR   prInfo `json:"pr"`
	// The viewer's pending review; null when there's none, left out when
	// GitHub didn't say (a partial answer).
	Review answered[reviewInfo] `json:"review,omitzero"`
	// The viewer's latest submitted review; null when there's none, left
	// out when GitHub didn't say.
	Submitted answered[submittedInfo] `json:"submitted,omitzero"`
	Threads   []fileThread            `json:"threads"`
	More      bool                    `json:"more"` // there's more than was fetched: counts are lower bounds
}

// answered is what a read said of one thing: Val, nil for none, when Known.
// Not known (a partial answer whose read of it came back null) leaves its
// key out of the answer, so the mod keeps what it had; a null would say
// there's none, and "your pending review is gone" reads as "submitted".
type answered[T any] struct {
	Val   *T
	Known bool
}

func known[T any](v *T) answered[T] { return answered[T]{Val: v, Known: true} }

func (a answered[T]) IsZero() bool { return !a.Known }

func (a answered[T]) MarshalJSON() ([]byte, error) { return json.Marshal(a.Val) }

// UnmarshalJSON: a key that's there is known, null or not.
func (a *answered[T]) UnmarshalJSON(b []byte) error {
	a.Known = true
	return json.Unmarshal(b, &a.Val)
}

// filesAnswer is the `files` op's answer: what `threads` has, and the files.
type filesAnswer struct {
	threadsAnswer
	Files []fileEntry `json:"files"`
}

// prInfo is what the review actions need of the PR itself. Mine: the viewer
// wrote it. State is open, closed or merged.
type prInfo struct {
	ID    string `json:"id"`
	Mine  bool   `json:"mine"`
	State string `json:"state"`
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
	// What the viewer may do to it, as GitHub says.
	CanReply     bool `json:"canReply"`
	CanResolve   bool `json:"canResolve"`
	CanUnresolve bool `json:"canUnresolve"`
}

// threadComment's State is submitted, or pending: the signed-in person's own
// unsent review comment. Mine: the viewer wrote it.
type threadComment struct {
	ID        string `json:"id"`
	Author    string `json:"author"`
	Body      string `json:"body"`
	Created   int64  `json:"created"` // ms since the epoch
	State     string `json:"state"`
	URL       string `json:"url"`
	Mine      bool   `json:"mine"`
	CanEdit   bool   `json:"canEdit"`
	CanDelete bool   `json:"canDelete"`
}

// reviewInfo is the viewer's pending review: its body, how many comments it
// holds, and the commit it's pinned to.
type reviewInfo struct {
	ID       string `json:"id"`
	Body     string `json:"body"`
	Comments int    `json:"comments"`
	Commit   string `json:"commit"`
}

// submittedInfo is the viewer's latest submitted review on the PR. A
// submit with no pending review whose outcome wasn't known is checked
// against it: a new one means it went through (spec A6). State is
// commented, approved, changes_requested or dismissed; At is when GitHub
// says it was submitted, in ms since the epoch.
type submittedInfo struct {
	ID    string `json:"id"`
	State string `json:"state"`
	At    int64  `json:"at"`
}

// gqlSubmitted is a review as the `submitted` read has it.
type gqlSubmitted struct {
	ID              string  `json:"id"`
	State           string  `json:"state"`
	ViewerDidAuthor bool    `json:"viewerDidAuthor"`
	SubmittedAt     *string `json:"submittedAt"`
}

// submittedOf is the viewer's latest submitted review among reviews, or
// nil. reviews(author:) takes a login, so the filter is viewerDidAuthor; a
// pending review has no submittedAt.
func submittedOf(reviews []gqlSubmitted) *submittedInfo {
	var out *submittedInfo
	for _, r := range reviews {
		if !r.ViewerDidAuthor || strings.EqualFold(r.State, "PENDING") || r.SubmittedAt == nil {
			continue
		}
		at, err := time.Parse(time.RFC3339, *r.SubmittedAt)
		if err != nil {
			continue
		}
		if out == nil || at.UnixMilli() >= out.At {
			out = &submittedInfo{ID: r.ID, State: strings.ToLower(r.State), At: at.UnixMilli()}
		}
	}
	return out
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
	ID              string    `json:"id"`
	Author          *actor    `json:"author"`
	Body            string    `json:"body"`
	CreatedAt       time.Time `json:"createdAt"`
	State           string    `json:"state"`
	URL             string    `json:"url"`
	ViewerDidAuthor bool      `json:"viewerDidAuthor"`
	ViewerCanUpdate bool      `json:"viewerCanUpdate"`
	ViewerCanDelete bool      `json:"viewerCanDelete"`
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
	// What the viewer may do to it.
	ViewerCanReply     bool `json:"viewerCanReply"`
	ViewerCanResolve   bool `json:"viewerCanResolve"`
	ViewerCanUnresolve bool `json:"viewerCanUnresolve"`
	Comments           struct {
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

// gqlReview is a review as GraphQL has it. Commit is the commit it's pinned
// to (null for a review whose commit is gone).
type gqlReview struct {
	ID              string `json:"id"`
	Body            string `json:"body"`
	State           string `json:"state"`
	ViewerDidAuthor bool   `json:"viewerDidAuthor"`
	Commit          *struct {
		Oid string `json:"oid"`
	} `json:"commit"`
	Comments struct {
		TotalCount int `json:"totalCount"`
	} `json:"comments"`
}

// info is the review as the mod gets it.
func (g gqlReview) info() *reviewInfo {
	r := &reviewInfo{ID: g.ID, Body: g.Body, Comments: g.Comments.TotalCount}
	if g.Commit != nil {
		r.Commit = g.Commit.Oid
	}
	return r
}

// pending says whether it's an unsubmitted review.
func (g gqlReview) pending() bool { return strings.EqualFold(g.State, "PENDING") }

// pendingOf is the viewer's own pending review among reviews, or nil. GitHub
// allows one per person per PR; reviews(author:) takes a login, not "the
// viewer", so the filter is viewerDidAuthor.
func pendingOf(reviews []gqlReview) *reviewInfo {
	for _, r := range reviews {
		if r.ViewerDidAuthor && r.pending() {
			return r.info()
		}
	}
	return nil
}

// The fields every read and mutation payload asks for, so a comment, thread
// or review is the same shape whichever answer it came in.
const (
	commentFields = `id author { login } body createdAt state url viewerDidAuthor viewerCanUpdate viewerCanDelete`
	threadFields  = `id isResolved isOutdated path line startLine originalLine diffSide startDiffSide subjectType
          viewerCanReply viewerCanResolve viewerCanUnresolve
          comments(first: 50) {
            pageInfo { hasNextPage }
            nodes { ` + commentFields + ` }
          }
          hunk: comments(first: 1) { nodes { diffHunk } }`
	reviewFields = `id body state viewerDidAuthor commit { oid } comments { totalCount }`
	// pendingReviews are the PR's pending reviews the viewer can see: only
	// their own, but filtered on viewerDidAuthor all the same (pendingOf).
	pendingReviews = `reviews(states: PENDING, first: 20) ` + pendingReviewNodes
	// pendingReviewNodes is pendingReviews' selection set, apart so a
	// directive can go between the two (GraphQL wants it before the braces).
	pendingReviewNodes = `{ nodes { ` + reviewFields + ` } }`
	// submittedReviewNodes is the `submitted` read's selection set: the PR's
	// last reviews (the viewer's among them), as submittedOf wants them.
	submittedReviewNodes = `{ nodes { id state viewerDidAuthor submittedAt } }`
)

type pageInfo struct {
	HasNextPage bool   `json:"hasNextPage"`
	EndCursor   string `json:"endCursor"`
}

// filesQuery reads a page of files and of threads, and (on the first page,
// $review) the PR and the viewer's pending review.
const filesQuery = `query($owner: String!, $name: String!, $n: Int!, $review: Boolean!, $files: Boolean!, $fa: String, $threads: Boolean!, $ta: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) {
      id headRefOid
      viewerDidAuthor @include(if: $review)
      state @include(if: $review)
      reviews(states: PENDING, first: 20) @include(if: $review) ` + pendingReviewNodes + `
      submitted: reviews(last: 10) @include(if: $review) ` + submittedReviewNodes + `
      files(first: 100, after: $fa) @include(if: $files) {
        pageInfo { hasNextPage endCursor }
        nodes { path additions deletions changeType viewerViewedState }
      }
      reviewThreads(first: 100, after: $ta) @include(if: $threads) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ` + threadFields + `
        }
      }
    }
  }
}`

// prFiles is what GraphQL has of a PR's files and threads, from one head,
// and the viewer's pending review.
type prFiles struct {
	ID, Head  string
	PR        prInfo
	Review    answered[reviewInfo]
	Submitted answered[submittedInfo]
	Files     []gqlFile
	Threads   []gqlThread
	More      bool
}

// errMoved: the head changed between two pages.
var errMoved = errors.New("the pull request changed while loading")

// loadFiles reads the PR's threads, and its files when withFiles, page by
// page. If a push lands between pages it starts over once (it's a read); a
// second time it gives up.
func (c *ghClient) loadFiles(ctx context.Context, r repoRef, number int, withFiles bool) (*prFiles, error) {
	for attempt := 0; attempt < 2; attempt++ {
		g, err := c.loadFilesOnce(ctx, r, number, withFiles)
		if !errors.Is(err, errMoved) {
			return g, err
		}
	}
	return nil, errors.New("the pull request changed while loading; press r")
}

func (c *ghClient) loadFilesOnce(ctx context.Context, r repoRef, number int, withFiles bool) (*prFiles, error) {
	var out prFiles
	needFiles, needThreads := withFiles, true
	var fileAfter, threadAfter any // nil until there's a cursor
	for round := 0; needFiles || needThreads; round++ {
		var res struct {
			Repository *struct {
				PullRequest *struct {
					ID              string `json:"id"`
					HeadRefOid      string `json:"headRefOid"`
					ViewerDidAuthor bool   `json:"viewerDidAuthor"`
					State           string `json:"state"`
					Reviews         *struct {
						Nodes []gqlReview `json:"nodes"`
					} `json:"reviews"`
					Submitted *struct {
						Nodes []gqlSubmitted `json:"nodes"`
					} `json:"submitted"`
					Files *struct {
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
			"owner": r.Owner, "name": r.Name, "n": number, "review": round == 0,
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
			out.PR = prInfo{ID: pr.ID, Mine: pr.ViewerDidAuthor, State: strings.ToLower(pr.State)}
			// Null only in a partial answer (asked for, so a full answer
			// has them): then not known, rather than none. Nor is "none
			// found" in a partial answer: a null node may be the one.
			if pr.Reviews != nil {
				if rv := pendingOf(pr.Reviews.Nodes); rv != nil || err == nil {
					out.Review = known(rv)
				}
			}
			if pr.Submitted != nil {
				out.Submitted = known(submittedOf(pr.Submitted.Nodes))
			}
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
		CanReply: g.ViewerCanReply, CanResolve: g.ViewerCanResolve, CanUnresolve: g.ViewerCanUnresolve,
	}
	if startSide := lowerOr(g.StartDiffSide, t.Side); g.StartLine != 0 && (g.StartLine != g.Line || startSide != t.Side) {
		t.StartLine, t.StartSide = g.StartLine, startSide
	}
	if t.Line == 0 && t.Subject == "line" && len(g.Hunk.Nodes) > 0 {
		t.Hunk = g.Hunk.Nodes[0].DiffHunk
	}
	for _, c := range g.Comments.Nodes {
		t.Comments = append(t.Comments, shapeComment(c))
	}
	return t
}

// shapeComment is a comment as the mod gets it.
func shapeComment(c gqlComment) threadComment {
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
	return threadComment{
		ID: c.ID, Author: author, Body: c.Body, Created: created, State: state, URL: c.URL,
		Mine: c.ViewerDidAuthor, CanEdit: c.ViewerCanUpdate, CanDelete: c.ViewerCanDelete,
	}
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
	out := filesAnswer{threadsAnswer: threadsFrom(g), Files: []fileEntry{}}
	for _, f := range g.Files {
		out.Files = append(out.Files, fileEntry{
			Path: f.Path, From: from[f.Path], Status: fileStatus(f.ChangeType),
			Additions: f.Additions, Deletions: f.Deletions, Viewed: viewedState(f.ViewerViewedState),
		})
	}
	orderThreads(out.Files, out.Threads)
	tallyThreads(out.Files, out.Threads)
	return out
}

// threadsFrom is the `threads` answer for what GraphQL has: threads in path
// order, then line order (filesFrom puts them in file order after).
func threadsFrom(g *prFiles) threadsAnswer {
	out := threadsAnswer{Head: g.Head, PR: g.PR, Review: g.Review, Submitted: g.Submitted, Threads: []fileThread{}, More: g.More}
	for _, t := range g.Threads {
		out.Threads = append(out.Threads, shapeThread(t))
	}
	orderThreads(nil, out.Threads)
	return out
}

// ── the ops, on GitHub ────────────────────────────────────────────────────────

// files answers the `files` op. The old path of a rename comes from REST,
// which is also kept in the cache so a `diff` after it needs no request; if
// REST can't be had (or the head moved while it was read), From stays empty.
func (c *ghClient) files(ctx context.Context, r repoRef, number int) (filesAnswer, error) {
	before := time.Now()
	g, err := c.loadFiles(ctx, r, number, true)
	if err != nil {
		return filesAnswer{}, err
	}
	rest, err := c.restFilesAt(ctx, r, number, g.Head, before)
	if err != nil && ctx.Err() != nil {
		return filesAnswer{}, ctx.Err()
	}
	return filesFrom(g, rest), nil
}

// threads answers the `threads` op: no files, no REST, one GraphQL request
// per page of threads (most PRs need one).
func (c *ghClient) threads(ctx context.Context, r repoRef, number int) (threadsAnswer, error) {
	g, err := c.loadFiles(ctx, r, number, false)
	if err != nil {
		return threadsAnswer{}, err
	}
	return threadsFrom(g), nil
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
