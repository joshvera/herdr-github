package main

import (
	"context"
	"errors"
	"fmt"
	"time"
)

// The review actions on GitHub: one read of the PR and the viewer's pending
// review, and one mutation each, through mutate. Every payload asks for the
// same fields a read does (commentFields, threadFields, reviewFields), so
// what a mutation answers is the shape `files` gives.

const reviewStateQuery = `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $n) { id headRefOid viewerDidAuthor state ` + pendingReviews + ` }
  }
}`

// reviewState reads the PR, its head and the viewer's pending review. A
// partial answer is a failure: a pending review GitHub didn't answer for
// would read as none.
func (c *ghClient) reviewState(ctx context.Context, r repoRef, number int) (reviewState, error) {
	var res struct {
		Repository *struct {
			PullRequest *struct {
				ID              string `json:"id"`
				HeadRefOid      string `json:"headRefOid"`
				ViewerDidAuthor bool   `json:"viewerDidAuthor"`
				State           string `json:"state"`
				Reviews         struct {
					Nodes []gqlReview `json:"nodes"`
				} `json:"reviews"`
			} `json:"pullRequest"`
		} `json:"repository"`
	}
	if err := c.graphql(ctx, reviewStateQuery, map[string]any{"owner": r.Owner, "name": r.Name, "n": number}, &res); err != nil {
		return reviewState{}, err
	}
	if res.Repository == nil || res.Repository.PullRequest == nil {
		return reviewState{}, fmt.Errorf("%s#%d isn't there, or isn't yours to see", r, number)
	}
	pr := res.Repository.PullRequest
	if !headPattern.MatchString(pr.HeadRefOid) {
		return reviewState{}, fmt.Errorf("GitHub gave no head commit for %s#%d", r, number)
	}
	return reviewState{
		PR:     prInfo{ID: pr.ID, Mine: pr.ViewerDidAuthor, State: lowerOr(pr.State, "open")},
		Head:   pr.HeadRefOid,
		Review: pendingOf(pr.Reviews.Nodes),
	}, nil
}

// reviewDiff is a file's diff at head: from the cache, or the PR's REST
// files read (and kept) as `diff` reads them. Stale when GitHub has moved on.
func (c *ghClient) reviewDiff(ctx context.Context, r repoRef, number int, head, path string) (diffAnswer, error) {
	files, ok := readDiffCache(r, number, head)
	if !ok {
		var err error
		files, err = c.restFilesAt(ctx, r, number, head, time.Now())
		var st *staleError
		if errors.As(err, &st) {
			return diffAnswer{Head: st.Head, Path: path, State: diffStale, Rows: []diffRow{}}, nil
		}
		if err != nil {
			return diffAnswer{}, err
		}
	}
	return diffFrom(files, head, path)
}

// reviewOf is a payload's review, nil when it has none.
func reviewOf(g *gqlReview) *reviewInfo {
	if g == nil || g.ID == "" {
		return nil
	}
	return g.info()
}

func (c *ghClient) addThread(ctx context.Context, reviewID string, t newThread) (fileThread, *reviewInfo, error) {
	var p struct {
		Thread *struct {
			gqlThread
			// The review the new comment is in, on its own alias.
			Review struct {
				Nodes []struct {
					PullRequestReview *gqlReview `json:"pullRequestReview"`
				} `json:"nodes"`
			} `json:"review"`
		} `json:"thread"`
	}
	err := c.mutate(ctx, `mutation($review: ID!, $path: String!, $line: Int!, $side: DiffSide!, $body: String!) {
  addPullRequestReviewThread(input: {pullRequestReviewId: $review, path: $path, line: $line, side: $side, body: $body}) {
    thread {
          `+threadFields+`
          review: comments(first: 1) { nodes { pullRequestReview { `+reviewFields+` } } }
    }
  }
}`, map[string]any{"review": reviewID, "path": t.Path, "line": t.Line, "side": t.Side, "body": t.Body}, "addPullRequestReviewThread", &p)
	if err != nil {
		return fileThread{}, nil, err
	}
	if p.Thread == nil {
		return fileThread{}, nil, unknownErr("GitHub took the comment but didn't say its thread. It may have gone through.")
	}
	var rv *reviewInfo
	if nodes := p.Thread.Review.Nodes; len(nodes) > 0 {
		rv = reviewOf(nodes[0].PullRequestReview)
	}
	return shapeThread(p.Thread.gqlThread), rv, nil
}

// startReview: addPullRequestReview with commitOID and no event makes a
// pending review pinned to that commit, holding the thread if there's one.
func (c *ghClient) startReview(ctx context.Context, prID, commit string, t *newThread) (*reviewInfo, *threadComment, error) {
	vars := map[string]any{"pr": prID, "commit": commit, "threads": nil}
	if t != nil {
		vars["threads"] = []map[string]any{{"path": t.Path, "line": t.Line, "side": t.Side, "body": t.Body}}
	}
	var p struct {
		PullRequestReview *struct {
			gqlReview
			Added struct {
				Nodes []gqlComment `json:"nodes"`
			} `json:"added"`
		} `json:"pullRequestReview"`
	}
	err := c.mutate(ctx, `mutation($pr: ID!, $commit: GitObjectID!, $threads: [DraftPullRequestReviewThread]) {
  addPullRequestReview(input: {pullRequestId: $pr, commitOID: $commit, threads: $threads}) {
    pullRequestReview { `+reviewFields+` added: comments(first: 1) { nodes { `+commentFields+` } } }
  }
}`, vars, "addPullRequestReview", &p)
	if err != nil {
		return nil, nil, err
	}
	if p.PullRequestReview == nil || p.PullRequestReview.ID == "" {
		return nil, nil, unknownErr("GitHub made the review but didn't say its ID. It may have gone through.")
	}
	rv := p.PullRequestReview.info()
	if t == nil || len(p.PullRequestReview.Added.Nodes) == 0 {
		return rv, nil, nil
	}
	cm := shapeComment(p.PullRequestReview.Added.Nodes[0])
	return rv, &cm, nil
}

func (c *ghClient) addReply(ctx context.Context, reviewID, thread, body string) (threadComment, *reviewInfo, error) {
	var p struct {
		Comment *struct {
			gqlComment
			PullRequestReview *gqlReview `json:"pullRequestReview"`
		} `json:"comment"`
	}
	err := c.mutate(ctx, `mutation($review: ID!, $thread: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewId: $review, pullRequestReviewThreadId: $thread, body: $body}) {
    comment { `+commentFields+` pullRequestReview { `+reviewFields+` } }
  }
}`, map[string]any{"review": reviewID, "thread": thread, "body": body}, "addPullRequestReviewThreadReply", &p)
	if err != nil {
		return threadComment{}, nil, err
	}
	if p.Comment == nil || p.Comment.ID == "" {
		return threadComment{}, nil, unknownErr("GitHub took the reply but didn't say its ID. It may have gone through.")
	}
	return shapeComment(p.Comment.gqlComment), reviewOf(p.Comment.PullRequestReview), nil
}

func (c *ghClient) setResolved(ctx context.Context, thread string, resolved bool) (bool, error) {
	field := "unresolveReviewThread"
	if resolved {
		field = "resolveReviewThread"
	}
	var p struct {
		Thread *struct {
			IsResolved bool `json:"isResolved"`
		} `json:"thread"`
	}
	err := c.mutate(ctx, `mutation($id: ID!) { `+field+`(input: {threadId: $id}) { thread { isResolved } } }`,
		map[string]any{"id": thread}, field, &p)
	if err != nil {
		return false, err
	}
	if p.Thread == nil {
		return false, unknownErr("GitHub didn't say what the thread is now. It may have gone through.")
	}
	return p.Thread.IsResolved, nil
}

func (c *ghClient) editComment(ctx context.Context, comment, body string) (threadComment, error) {
	var p struct {
		Comment *gqlComment `json:"pullRequestReviewComment"`
	}
	err := c.mutate(ctx, `mutation($id: ID!, $body: String!) {
  updatePullRequestReviewComment(input: {pullRequestReviewCommentId: $id, body: $body}) {
    pullRequestReviewComment { `+commentFields+` }
  }
}`, map[string]any{"id": comment, "body": body}, "updatePullRequestReviewComment", &p)
	if err != nil {
		return threadComment{}, err
	}
	if p.Comment == nil || p.Comment.ID == "" {
		return threadComment{}, unknownErr("GitHub didn't say what the comment is now. It may have gone through.")
	}
	return shapeComment(*p.Comment), nil
}

func (c *ghClient) deleteComment(ctx context.Context, comment string) (*reviewInfo, bool, error) {
	var p struct {
		PullRequestReview *gqlReview `json:"pullRequestReview"`
	}
	err := c.mutate(ctx, `mutation($id: ID!) {
  deletePullRequestReviewComment(input: {id: $id}) { pullRequestReview { `+reviewFields+` } }
}`, map[string]any{"id": comment}, "deletePullRequestReviewComment", &p)
	if err != nil {
		return nil, false, err
	}
	rv := reviewOf(p.PullRequestReview)
	return rv, rv != nil && p.PullRequestReview.pending(), nil
}

// submitReview submits one pending review, by its ID.
func (c *ghClient) submitReview(ctx context.Context, reviewID, event, body string) (string, error) {
	var p struct {
		PullRequestReview *struct {
			URL string `json:"url"`
		} `json:"pullRequestReview"`
	}
	err := c.mutate(ctx, `mutation($id: ID!, $event: PullRequestReviewEvent!, $body: String) {
  submitPullRequestReview(input: {pullRequestReviewId: $id, event: $event, body: $body}) { pullRequestReview { url } }
}`, map[string]any{"id": reviewID, "event": event, "body": optional(body)}, "submitPullRequestReview", &p)
	if err != nil {
		return "", err
	}
	if p.PullRequestReview == nil {
		return "", nil
	}
	return p.PullRequestReview.URL, nil
}

// publishReview sends a review with no comments. GitHub refuses it while
// the viewer has a pending review (seen on the sandbox PR), so it can't
// publish comments nobody was shown.
func (c *ghClient) publishReview(ctx context.Context, prID, event, body string) (string, error) {
	var p struct {
		PullRequestReview *struct {
			URL string `json:"url"`
		} `json:"pullRequestReview"`
	}
	err := c.mutate(ctx, `mutation($pr: ID!, $event: PullRequestReviewEvent!, $body: String) {
  addPullRequestReview(input: {pullRequestId: $pr, event: $event, body: $body}) { pullRequestReview { url } }
}`, map[string]any{"pr": prID, "event": event, "body": optional(body)}, "addPullRequestReview", &p)
	if err != nil {
		return "", err
	}
	if p.PullRequestReview == nil {
		return "", nil
	}
	return p.PullRequestReview.URL, nil
}

func (c *ghClient) discardReview(ctx context.Context, reviewID string) error {
	var p struct {
		PullRequestReview *struct {
			ID string `json:"id"`
		} `json:"pullRequestReview"`
	}
	return c.mutate(ctx, `mutation($id: ID!) {
  deletePullRequestReview(input: {pullRequestReviewId: $id}) { pullRequestReview { id } }
}`, map[string]any{"id": reviewID}, "deletePullRequestReview", &p)
}

// optional is a GraphQL String that's null when empty.
func optional(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// ── githubSource ──────────────────────────────────────────────────────────────

func (s *githubSource) reviewState(ctx context.Context, r repoRef, number int) (reviewState, error) {
	return s.client(r.Host).reviewState(ctx, r, number)
}

func (s *githubSource) reviewDiff(ctx context.Context, r repoRef, number int, head, path string) (diffAnswer, error) {
	return s.client(r.Host).reviewDiff(ctx, r, number, head, path)
}

func (s *githubSource) addThread(ctx context.Context, r repoRef, _ int, reviewID string, t newThread) (fileThread, *reviewInfo, error) {
	return s.client(r.Host).addThread(ctx, reviewID, t)
}

func (s *githubSource) startReview(ctx context.Context, r repoRef, _ int, prID, commit string, t *newThread) (*reviewInfo, *threadComment, error) {
	return s.client(r.Host).startReview(ctx, prID, commit, t)
}

func (s *githubSource) addReply(ctx context.Context, r repoRef, _ int, reviewID, thread, body string) (threadComment, *reviewInfo, error) {
	return s.client(r.Host).addReply(ctx, reviewID, thread, body)
}

func (s *githubSource) setResolved(ctx context.Context, r repoRef, _ int, thread string, resolved bool) (bool, error) {
	return s.client(r.Host).setResolved(ctx, thread, resolved)
}

func (s *githubSource) editComment(ctx context.Context, r repoRef, _ int, comment, body string) (threadComment, error) {
	return s.client(r.Host).editComment(ctx, comment, body)
}

func (s *githubSource) deleteComment(ctx context.Context, r repoRef, _ int, comment string) (*reviewInfo, bool, error) {
	return s.client(r.Host).deleteComment(ctx, comment)
}

func (s *githubSource) submitReview(ctx context.Context, r repoRef, _ int, reviewID, event, body string) (string, error) {
	return s.client(r.Host).submitReview(ctx, reviewID, event, body)
}

func (s *githubSource) publishReview(ctx context.Context, r repoRef, _ int, prID, event, body string) (string, error) {
	return s.client(r.Host).publishReview(ctx, prID, event, body)
}

func (s *githubSource) discardReview(ctx context.Context, r repoRef, _ int, reviewID string) error {
	return s.client(r.Host).discardReview(ctx, reviewID)
}
