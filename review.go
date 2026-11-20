package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"
)

// The review actions on the Files changed tab: comment on a line, reply,
// resolve, edit and delete a comment, submit or discard the pending review.
// The rules (what's refused before anything is sent, and when) are here,
// once; GitHub and the demo each supply a reviewSource. Every new comment
// and reply goes into the viewer's pending review, so nothing new reaches
// anyone until it's submitted.

// reviewSource is what the review actions take from GitHub or the demo: one
// read of the PR and the viewer's pending review, a file's diff to check a
// line against, and one call per mutation (each one request, never
// repeated: see mutate.go).
type reviewSource interface {
	reviewState(ctx context.Context, r repoRef, number int) (reviewState, error)
	// reviewDiff is a file's diff at head, to check a line against: state
	// stale when the PR's head isn't head.
	reviewDiff(ctx context.Context, r repoRef, number int, head, path string) (diffAnswer, error)
	// addThread starts a thread in the pending review reviewID. The review
	// it answers is that review after, or nil if GitHub didn't say.
	addThread(ctx context.Context, r repoRef, number int, reviewID string, t newThread) (fileThread, *reviewInfo, error)
	// startReview creates the viewer's pending review on commit, holding t's
	// thread when t isn't nil (then the comment is its first comment, or nil
	// if GitHub didn't say).
	startReview(ctx context.Context, r repoRef, number int, prID, commit string, t *newThread) (*reviewInfo, *threadComment, error)
	// addReply replies in thread, into the pending review reviewID.
	addReply(ctx context.Context, r repoRef, number int, reviewID, thread, body string) (threadComment, *reviewInfo, error)
	setResolved(ctx context.Context, r repoRef, number int, thread string, resolved bool) (bool, error)
	editComment(ctx context.Context, r repoRef, number int, comment, body string) (threadComment, error)
	// deleteComment answers the review the comment was in, as it is after,
	// and whether that review is pending (nil, false if GitHub didn't say).
	deleteComment(ctx context.Context, r repoRef, number int, comment string) (*reviewInfo, bool, error)
	// submitReview submits the pending review reviewID; publishReview sends
	// a new review with no comments. Each answers the review's URL.
	submitReview(ctx context.Context, r repoRef, number int, reviewID, event, body string) (string, error)
	publishReview(ctx context.Context, r repoRef, number int, prID, event, body string) (string, error)
	discardReview(ctx context.Context, r repoRef, number int, reviewID string) error
}

// reviewState is what a review action reads before it acts: the PR, its
// head, and the viewer's pending review (nil when there's none).
type reviewState struct {
	PR     prInfo
	Head   string
	Review *reviewInfo
}

// newThread is a comment on one line, starting a thread. Side is LEFT (the
// old file) or RIGHT (the new one).
type newThread struct {
	Path string
	Line int
	Side string
	Body string
}

// maxBody is GitHub's limit on a comment's body, in characters.
const maxBody = 65536

const olderCommitMsg = "Your pending review was started on an older commit. Submit or discard it to comment on the new one."

// The answers, on ok. A review is null when there's none.
type (
	commentAnswer struct {
		OK      bool          `json:"ok"`
		Comment threadComment `json:"comment"`
		Review  *reviewInfo   `json:"review"`
		// Only when a pending review already existed: a new review's payload
		// has no thread, and the next poll places it.
		Thread *fileThread `json:"thread,omitempty"`
	}
	replyAnswer struct {
		OK      bool          `json:"ok"`
		Thread  string        `json:"thread"`
		Comment threadComment `json:"comment"`
		Review  *reviewInfo   `json:"review"`
	}
	resolveAnswer struct {
		OK       bool `json:"ok"`
		Resolved bool `json:"resolved"`
	}
	editAnswer struct {
		OK      bool          `json:"ok"`
		Comment threadComment `json:"comment"`
	}
	deleteAnswer struct {
		OK     bool        `json:"ok"`
		Review *reviewInfo `json:"review"`
	}
	submitAnswer struct {
		OK  bool   `json:"ok"`
		URL string `json:"url"`
	}
	discardAnswer struct {
		OK bool `json:"ok"`
	}
)

// reviewEvents are submit's events, as the mod and GitHub spell them.
var reviewEvents = map[string]string{"comment": "COMMENT", "approve": "APPROVE", "request_changes": "REQUEST_CHANGES"}

// diffSides are a comment's sides, as GitHub spells them; the mod may send
// either case (files says left and right).
var diffSides = map[string]string{"left": "LEFT", "right": "RIGHT"}

// appReviewOp answers a review action, and says whether the request was one.
func appReviewOp(ctx context.Context, src reviewSource, req appRequest, r repoRef) (any, bool, error) {
	if req.Op != "act" {
		return nil, false, nil
	}
	n := req.PR.Number
	var out any
	var err error
	switch req.Do {
	case "comment":
		out, err = doComment(ctx, src, r, n, req)
	case "reply":
		out, err = doReply(ctx, src, r, n, req)
	case "resolve", "unresolve":
		out, err = doResolve(ctx, src, r, n, req)
	case "edit":
		out, err = doEdit(ctx, src, r, n, req)
	case "delete":
		out, err = doDelete(ctx, src, r, n, req)
	case "submit":
		out, err = doSubmit(ctx, src, r, n, req)
	case "discard":
		out, err = doDiscard(ctx, src, r, n, req)
	default:
		return nil, false, nil
	}
	if err != nil {
		return nil, true, err
	}
	return out, true, nil
}

// checkBody refuses a body that's empty, only whitespace, or too long. It's
// sent as typed otherwise.
func checkBody(body string) error {
	if strings.TrimSpace(body) == "" {
		return errors.New("The comment is empty. Nothing was sent.")
	}
	if n := utf8.RuneCountInString(body); n > maxBody {
		return fmt.Errorf("The comment is %d characters, and GitHub takes at most 65,536. Nothing was sent.", n)
	}
	return nil
}

// readState is the read before a mutation. If it fails, nothing was sent,
// and the error says so (still a *staleError or signed out underneath).
func readState(ctx context.Context, src reviewSource, r repoRef, n int) (reviewState, error) {
	st, err := src.reviewState(ctx, r, n)
	if err != nil {
		return st, fmt.Errorf("couldn't read the pull request first: %w. Nothing was sent", err)
	}
	return st, nil
}

func need(what, v string) error {
	if v == "" {
		return fmt.Errorf("that needs a %s. Nothing was sent.", what)
	}
	return nil
}

// doComment starts a thread on a line of the diff the viewer is looking at,
// in the pending review: only at the PR's head, only on a row of that
// file's diff there, and only when the pending review (if any) is on that
// head too.
func doComment(ctx context.Context, src reviewSource, r repoRef, n int, req appRequest) (any, error) {
	if err := checkBody(req.Body); err != nil {
		return nil, err
	}
	if err := checkHeadAndPath(appRequest{Op: "comment", Head: req.Head, Path: req.Path}); err != nil {
		return nil, err
	}
	side, ok := diffSides[strings.ToLower(req.Side)]
	if !ok || req.Line <= 0 {
		return nil, fmt.Errorf("a comment needs a line and a side (left or right), not %d %q. Nothing was sent.", req.Line, req.Side)
	}
	st, err := readState(ctx, src, r, n)
	if err != nil {
		return nil, err
	}
	if st.Head != req.Head {
		return nil, &staleError{Head: st.Head}
	}
	if st.Review != nil && st.Review.Commit != st.Head {
		return nil, withReview(errors.New(olderCommitMsg), st.Review)
	}
	d, err := src.reviewDiff(ctx, r, n, st.Head, req.Path)
	if err != nil {
		return nil, fmt.Errorf("couldn't read %s's diff to check the line: %w. Nothing was sent", req.Path, err)
	}
	switch {
	case d.State == diffStale:
		return nil, &staleError{Head: d.Head}
	case d.State != diffOK:
		return nil, fmt.Errorf("%s has no lines to comment on here (%s). Nothing was sent.", req.Path, d.State)
	case !hasRow(d.Rows, req.Line, side):
		return nil, fmt.Errorf("line %d (%s side) isn't in %s's diff. Nothing was sent.", req.Line, sideWord(side), req.Path)
	}
	t := newThread{Path: req.Path, Line: req.Line, Side: side, Body: req.Body}
	if st.Review != nil {
		th, rv, err := src.addThread(ctx, r, n, st.Review.ID, t)
		if err != nil {
			return nil, err
		}
		if len(th.Comments) == 0 {
			return nil, unknownErr("GitHub took the comment but didn't say its ID. It may have gone through.")
		}
		if rv == nil {
			rv = st.Review
		}
		return commentAnswer{OK: true, Comment: th.Comments[len(th.Comments)-1], Review: rv, Thread: &th}, nil
	}
	// No pending review: one request makes it, pinned to the head, holding
	// the thread. No check-then-act.
	rv, c, err := src.startReview(ctx, r, n, st.PR.ID, st.Head, &t)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, withReview(unknownErr("GitHub took the comment but didn't say its ID. It may have gone through."), rv)
	}
	return commentAnswer{OK: true, Comment: *c, Review: rv}, nil
}

// hasRow says whether the diff has a row for line on side: the old file's
// line for LEFT (a removed or unchanged line), the new file's for RIGHT (an
// added or unchanged one).
func hasRow(rows []diffRow, line int, side string) bool {
	for _, row := range rows {
		switch {
		case side == "LEFT" && (row.Kind == "del" || row.Kind == "ctx") && row.Old == line:
			return true
		case side == "RIGHT" && (row.Kind == "add" || row.Kind == "ctx") && row.New == line:
			return true
		}
	}
	return false
}

func sideWord(side string) string {
	if side == "LEFT" {
		return "old"
	}
	return "new"
}

// doReply replies in a thread, into the pending review. Its ID is always
// passed: without one, and with no pending review, GitHub publishes the
// reply at once. With no pending review it takes two mutations: an empty
// pending review on the head, then the reply into it (a draft thread can't
// be a reply).
func doReply(ctx context.Context, src reviewSource, r repoRef, n int, req appRequest) (any, error) {
	if err := checkBody(req.Body); err != nil {
		return nil, err
	}
	if err := need("thread", req.Thread); err != nil {
		return nil, err
	}
	st, err := readState(ctx, src, r, n)
	if err != nil {
		return nil, err
	}
	rv := st.Review
	if rv == nil {
		rv, _, err = src.startReview(ctx, r, n, st.PR.ID, st.Head, nil)
		if isUnknown(err) {
			return nil, &actError{err: fmt.Errorf("No answer. An empty pending review may have been created. (%w)", err), unknown: true}
		}
		if err != nil {
			return nil, err
		}
		c, after, err := src.addReply(ctx, r, n, rv.ID, req.Thread, req.Body)
		if err != nil {
			return nil, withReview(fmt.Errorf("%w (An empty pending review was left behind.)", err), rv)
		}
		if after != nil {
			rv = after
		}
		return replyAnswer{OK: true, Thread: req.Thread, Comment: c, Review: rv}, nil
	}
	c, after, err := src.addReply(ctx, r, n, rv.ID, req.Thread, req.Body)
	if err != nil {
		return nil, err
	}
	if after != nil {
		rv = after
	}
	return replyAnswer{OK: true, Thread: req.Thread, Comment: c, Review: rv}, nil
}

// doResolve resolves or unresolves a thread: visible to others at once.
func doResolve(ctx context.Context, src reviewSource, r repoRef, n int, req appRequest) (any, error) {
	if err := need("thread", req.Thread); err != nil {
		return nil, err
	}
	resolved, err := src.setResolved(ctx, r, n, req.Thread, req.Do == "resolve")
	if err != nil {
		return nil, err
	}
	return resolveAnswer{OK: true, Resolved: resolved}, nil
}

// doEdit replaces a comment's body. A published comment's edit shows at once.
func doEdit(ctx context.Context, src reviewSource, r repoRef, n int, req appRequest) (any, error) {
	if err := checkBody(req.Body); err != nil {
		return nil, err
	}
	if err := need("comment", req.Comment); err != nil {
		return nil, err
	}
	c, err := src.editComment(ctx, r, n, req.Comment, req.Body)
	if err != nil {
		return nil, err
	}
	return editAnswer{OK: true, Comment: c}, nil
}

// doDelete deletes a comment, and answers the pending review after. GitHub
// deletes a pending review when its last comment goes (its payload still
// says pending, with 0 comments), so that's null. A published comment's
// review isn't the pending one: that stays as read before.
func doDelete(ctx context.Context, src reviewSource, r repoRef, n int, req appRequest) (any, error) {
	if err := need("comment", req.Comment); err != nil {
		return nil, err
	}
	st, err := readState(ctx, src, r, n)
	if err != nil {
		return nil, err
	}
	rv, pending, err := src.deleteComment(ctx, r, n, req.Comment)
	if err != nil {
		return nil, err
	}
	after := st.Review
	if pending && rv != nil {
		after = rv
		if rv.Comments == 0 {
			after = nil
		}
	}
	return deleteAnswer{OK: true, Review: after}, nil
}

// sameReview refuses unless the viewer's pending review is still the one
// the dialog showed, with the count it showed. A count can't see one comment
// deleted and another added: that's the accepted risk (A6).
func sameReview(now *reviewInfo, id string, count int) error {
	var why string
	switch {
	case now == nil:
		why = "Your pending review changed (it's no longer pending)."
	case now.ID != id:
		why = fmt.Sprintf("Your pending review changed (it's a new one now, %d comments).", now.Comments)
	case now.Comments != count:
		why = fmt.Sprintf("Your pending review changed (now %d comments).", now.Comments)
	default:
		return nil
	}
	return &actError{err: errors.New(why + " Nothing was sent."), review: now, hasReview: true, changed: true}
}

// doSubmit submits the pending review the dialog showed, or with no
// reviewId (no pending comments) sends a new review with no comments.
func doSubmit(ctx context.Context, src reviewSource, r repoRef, n int, req appRequest) (any, error) {
	event, ok := reviewEvents[req.Event]
	if !ok {
		return nil, fmt.Errorf("can't submit a review as %q. Nothing was sent.", req.Event)
	}
	if n := utf8.RuneCountInString(req.Body); n > maxBody {
		return nil, fmt.Errorf("The review's text is %d characters, and GitHub takes at most 65,536. Nothing was sent.", n)
	}
	if req.ReviewID != "" && req.Count == nil {
		return nil, errors.New("submit needs the count of comments the dialog showed. Nothing was sent.")
	}
	noComments := req.ReviewID == "" || *req.Count == 0
	if event == "COMMENT" && noComments && strings.TrimSpace(req.Body) == "" {
		return nil, errors.New("A comment review needs some text or a pending comment. Nothing was sent.")
	}
	st, err := readState(ctx, src, r, n)
	if err != nil {
		return nil, err
	}
	var url string
	if req.ReviewID != "" {
		if err := sameReview(st.Review, req.ReviewID, *req.Count); err != nil {
			return nil, err
		}
		// Never the pullRequestId form of submitPullRequestReview: that
		// submits any pending review, not the one shown.
		url, err = src.submitReview(ctx, r, n, req.ReviewID, event, req.Body)
	} else {
		if st.Review != nil {
			return nil, &actError{
				err:    fmt.Errorf("You have a pending review now (%d comments). Nothing was sent.", st.Review.Comments),
				review: st.Review, hasReview: true, changed: true,
			}
		}
		url, err = src.publishReview(ctx, r, n, st.PR.ID, event, req.Body)
	}
	if err != nil {
		return nil, err
	}
	return submitAnswer{OK: true, URL: url}, nil
}

// doDiscard deletes the pending review the dialog showed, with its comments.
func doDiscard(ctx context.Context, src reviewSource, r repoRef, n int, req appRequest) (any, error) {
	if err := need("review", req.ReviewID); err != nil {
		return nil, err
	}
	if req.Count == nil {
		return nil, errors.New("discard needs the count of comments the dialog showed. Nothing was sent.")
	}
	st, err := readState(ctx, src, r, n)
	if err != nil {
		return nil, err
	}
	if err := sameReview(st.Review, req.ReviewID, *req.Count); err != nil {
		return nil, err
	}
	if err := src.discardReview(ctx, r, n, req.ReviewID); err != nil {
		return nil, err
	}
	return discardAnswer{OK: true}, nil
}
