package main

import (
	"context"
	"errors"
	"fmt"
	"strings"
)

// The demo's review actions: GitHub's rules as the sandbox PR showed them,
// on made-up data that's kept between requests (each is its own process: see
// appDemo). Sam's pending review on #482 grows as it's polled, as if the
// gh-review skill were drafting it; one thread can't be resolved (a thread
// that only has pending comments, as on GitHub); #480 has a pending review on
// an older commit.
//
// A body of exactly "!unknown" answers as GitHub not answering would, and
// changes nothing; "!unknown-sent" does the same but makes the change, as a
// send that got through without an answer. That's the mod's unknown flow,
// without GitHub.

const (
	demoUnknown     = "!unknown"
	demoUnknownSent = "!unknown-sent"
)

// demoReview is the viewer's pending review in the demo. Its comments are the
// pending comments in its PR's threads.
type demoReview struct {
	ID     string `json:"id"`
	Body   string `json:"body"`
	Commit string `json:"commit"`
}

// demoReviewSave is a PR's review state as appDemo keeps it.
type demoReviewSave struct {
	Threads   []fileThread   `json:"threads"`
	Pending   *demoReview    `json:"pending"`
	NextID    int            `json:"nextId"`
	Drafted   int            `json:"drafted"`
	Submitted *submittedInfo `json:"submitted,omitempty"`
}

// demoSubmittedStates are the states a submitted review is in, by event.
var demoSubmittedStates = map[string]string{"COMMENT": "commented", "APPROVE": "approved", "REQUEST_CHANGES": "changes_requested"}

// demoDrafts arrive in Sam's pending review on #482, one per `threads` poll.
var demoDrafts = []newThread{
	{Path: "Sources/Sync/SyncEngine.swift", Line: 143, Side: "RIGHT", Body: "What happens when `proposal.base` is older than `note.baseRevision`? A test for that would settle it."},
	{Path: "Sources/Sync/Proposal.swift", Line: 14, Side: "RIGHT", Body: "Should this be optional, for servers that don't send it yet?"},
}

// demoOutcome is what a body asks of the demo: whether to make the change,
// and the error to answer after (an unknown outcome, or nil).
func demoOutcome(body string) (apply bool, err error) {
	switch body {
	case demoUnknown:
		return false, unknownErr("Demo: no answer from GitHub. It may have gone through.")
	case demoUnknownSent:
		return true, unknownErr("Demo: no answer from GitHub. It may have gone through.")
	}
	return true, nil
}

// refusedDemo is a refusal as GitHub words one.
func refusedDemo(msg string) error { return errors.New("GitHub: " + msg) }

// reviewData is a demo PR and its review state. Callers hold d.mu.
func (d *demoSource) reviewData(r repoRef, number int) (*prDetail, *demoPRFiles, error) {
	p := d.findRef(r, number)
	if p == nil {
		return nil, nil, fmt.Errorf("%s#%d isn't there", r, number)
	}
	data := d.filesData[p.key()]
	if data == nil {
		return nil, nil, fmt.Errorf("the demo has no files on %s#%d", r, number)
	}
	return p, data, nil
}

func (data *demoPRFiles) newID(prefix string, number int) string {
	data.nextID++
	return fmt.Sprintf("%s_demo_%d_n%d", prefix, number, data.nextID)
}

// pendingInfo is the viewer's pending review as the mod gets it, or nil.
func (data *demoPRFiles) pendingInfo() *reviewInfo {
	if data.review == nil {
		return nil
	}
	n := 0
	for _, t := range data.threads {
		for _, c := range t.Comments {
			if c.State == "pending" {
				n++
			}
		}
	}
	return &reviewInfo{ID: data.review.ID, Body: clean(data.review.Body, true), Comments: n, Commit: data.review.Commit}
}

// shownComment is a comment as the mod gets it: what Sam may do to it, and
// its text cleaned (it's kept as typed).
func (d *demoSource) shownComment(c threadComment) threadComment {
	c.Body = clean(c.Body, true)
	c.Mine = c.Author == d.me
	c.CanEdit, c.CanDelete = c.Mine, c.Mine
	return c
}

// shownThread is a thread as the mod gets it. Anyone may reply; a thread is
// resolved and unresolved as GitHub allows: not while it only has pending
// comments.
func (d *demoSource) shownThread(t fileThread) fileThread {
	cs := make([]threadComment, 0, len(t.Comments))
	published := false
	for _, c := range t.Comments {
		cs = append(cs, d.shownComment(c))
		published = published || c.State != "pending"
	}
	t.Comments = cs
	t.CanReply = true
	t.CanResolve = !t.Resolved && published
	t.CanUnresolve = t.Resolved
	return t
}

// threadsOf is a demo PR's threads, the PR, and the viewer's pending review.
// Callers hold d.mu.
func (d *demoSource) threadsOf(p *prDetail) threadsAnswer {
	out := threadsAnswer{Head: p.HeadRefOid, PR: prInfo{ID: p.ID, Mine: p.author() == d.me, State: strings.ToLower(p.State)},
		Review: known[reviewInfo](nil), Submitted: known[submittedInfo](nil), Threads: []fileThread{}}
	data := d.filesData[p.key()]
	if data == nil {
		return out
	}
	for _, t := range data.threads {
		out.Threads = append(out.Threads, d.shownThread(t))
	}
	out.Review = known(data.pendingInfo())
	out.Submitted = known(data.submitted)
	return out
}

// threads answers the `threads` op on the demo. On #482, while Sam's review
// is pending, each poll brings the next of demoDrafts into it.
func (d *demoSource) threads(_ context.Context, r repoRef, number int) (threadsAnswer, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p := d.findRef(r, number)
	if p == nil {
		return threadsAnswer{}, fmt.Errorf("%s#%d isn't there", r, number)
	}
	if data := d.filesData[p.key()]; data != nil && number == 482 && data.review != nil && data.drafted < len(demoDrafts) {
		d.addDemoThread(p, data, demoDrafts[data.drafted])
		data.drafted++
	}
	out := d.threadsOf(p)
	orderThreads(nil, out.Threads)
	return out, nil
}

// addDemoThread adds a thread with one pending comment of Sam's.
func (d *demoSource) addDemoThread(p *prDetail, data *demoPRFiles, t newThread) fileThread {
	id := data.newID("PRRC", p.Number)
	c := threadComment{ID: id, Author: d.me, Body: t.Body, Created: nowFn().UnixMilli(), State: "pending", URL: p.URL + "#discussion_" + id}
	th := fileThread{
		ID: data.newID("PRRT", p.Number), Path: t.Path, Subject: "line", Line: t.Line, Side: strings.ToLower(t.Side),
		OriginalLine: t.Line, Comments: []threadComment{c},
	}
	data.threads = append(data.threads, th)
	d.changed = true
	return th
}

// findComment is where a comment is: its thread's and its own index.
func (data *demoPRFiles) findComment(id string) (int, int, bool) {
	for i, t := range data.threads {
		for j, c := range t.Comments {
			if c.ID == id {
				return i, j, true
			}
		}
	}
	return 0, 0, false
}

func (data *demoPRFiles) findThread(id string) (int, bool) {
	for i, t := range data.threads {
		if t.ID == id {
			return i, true
		}
	}
	return 0, false
}

// samePending refuses a review ID that isn't the pending review's, as
// GitHub does an ID it can't find.
func (data *demoPRFiles) samePending(id string) error {
	if data.review == nil || data.review.ID != id {
		return refusedDemo(fmt.Sprintf("Could not resolve to a node with the global id of '%s'", id))
	}
	return nil
}

func (d *demoSource) reviewState(_ context.Context, r repoRef, number int) (reviewState, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, data, err := d.reviewData(r, number)
	if err != nil {
		return reviewState{}, err
	}
	t := d.threadsOf(p)
	return reviewState{PR: t.PR, Head: p.HeadRefOid, Review: data.pendingInfo()}, nil
}

func (d *demoSource) reviewDiff(ctx context.Context, r repoRef, number int, head, path string) (diffAnswer, error) {
	return d.diff(ctx, r, number, head, path)
}

func (d *demoSource) addThread(_ context.Context, r repoRef, number int, reviewID string, t newThread) (fileThread, *reviewInfo, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, data, err := d.reviewData(r, number)
	if err != nil {
		return fileThread{}, nil, err
	}
	if err := data.samePending(reviewID); err != nil {
		return fileThread{}, nil, err
	}
	apply, outcome := demoOutcome(t.Body)
	if !apply {
		return fileThread{}, nil, outcome
	}
	th := d.addDemoThread(p, data, t)
	return d.shownThread(th), data.pendingInfo(), outcome
}

func (d *demoSource) startReview(_ context.Context, r repoRef, number int, _, commit string, t *newThread) (*reviewInfo, *threadComment, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, data, err := d.reviewData(r, number)
	if err != nil {
		return nil, nil, err
	}
	if data.review != nil {
		return nil, nil, refusedDemo("User can only have one pending review per pull request")
	}
	apply, outcome := true, error(nil)
	if t != nil {
		apply, outcome = demoOutcome(t.Body)
	}
	if !apply {
		return nil, nil, outcome
	}
	data.review = &demoReview{ID: data.newID("PRR", number), Commit: commit}
	d.changed = true
	if t == nil {
		return data.pendingInfo(), nil, outcome
	}
	th := d.addDemoThread(p, data, *t)
	c := d.shownComment(th.Comments[0])
	return data.pendingInfo(), &c, outcome
}

func (d *demoSource) addReply(_ context.Context, r repoRef, number int, reviewID, thread, body string) (threadComment, *reviewInfo, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, data, err := d.reviewData(r, number)
	if err != nil {
		return threadComment{}, nil, err
	}
	if err := data.samePending(reviewID); err != nil {
		return threadComment{}, nil, err
	}
	i, ok := data.findThread(thread)
	if !ok {
		return threadComment{}, nil, refusedDemo(fmt.Sprintf("Could not resolve to a node with the global id of '%s'", thread))
	}
	apply, outcome := demoOutcome(body)
	if !apply {
		return threadComment{}, nil, outcome
	}
	id := data.newID("PRRC", number)
	c := threadComment{ID: id, Author: d.me, Body: body, Created: nowFn().UnixMilli(), State: "pending", URL: p.URL + "#discussion_" + id}
	data.threads[i].Comments = append(data.threads[i].Comments, c)
	d.changed = true
	return d.shownComment(c), data.pendingInfo(), outcome
}

func (d *demoSource) setResolved(_ context.Context, r repoRef, number int, thread string, resolved bool) (bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, data, err := d.reviewData(r, number)
	if err != nil {
		return false, err
	}
	i, ok := data.findThread(thread)
	if !ok {
		return false, refusedDemo(fmt.Sprintf("Could not resolve to a node with the global id of '%s'", thread))
	}
	shown := d.shownThread(data.threads[i])
	if (resolved && !shown.CanResolve) || (!resolved && !shown.CanUnresolve) {
		return false, refusedDemo("You can't change whether this conversation is resolved")
	}
	data.threads[i].Resolved = resolved
	d.changed = true
	return resolved, nil
}

func (d *demoSource) editComment(_ context.Context, r repoRef, number int, comment, body string) (threadComment, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, data, err := d.reviewData(r, number)
	if err != nil {
		return threadComment{}, err
	}
	i, j, ok := data.findComment(comment)
	if !ok {
		return threadComment{}, refusedDemo(fmt.Sprintf("Could not resolve to a node with the global id of '%s'", comment))
	}
	if data.threads[i].Comments[j].Author != d.me {
		return threadComment{}, refusedDemo("You don't have permission to edit this comment")
	}
	apply, outcome := demoOutcome(body)
	if !apply {
		return threadComment{}, outcome
	}
	data.threads[i].Comments[j].Body = body
	d.changed = true
	return d.shownComment(data.threads[i].Comments[j]), outcome
}

// deleteComment answers as GitHub's payload does: the review the comment was
// in, which for the last pending comment is a pending review with none left
// (and gone, as GitHub deletes it).
func (d *demoSource) deleteComment(_ context.Context, r repoRef, number int, comment string) (*reviewInfo, bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, data, err := d.reviewData(r, number)
	if err != nil {
		return nil, false, err
	}
	i, j, ok := data.findComment(comment)
	if !ok {
		return nil, false, refusedDemo(fmt.Sprintf("Could not resolve to a node with the global id of '%s'", comment))
	}
	c := data.threads[i].Comments[j]
	if c.Author != d.me {
		return nil, false, refusedDemo("You don't have permission to delete this comment")
	}
	d.changed = true
	t := &data.threads[i]
	t.Comments = append(t.Comments[:j:j], t.Comments[j+1:]...)
	if len(t.Comments) == 0 {
		data.threads = append(data.threads[:i:i], data.threads[i+1:]...)
	}
	if c.State != "pending" {
		return nil, false, nil
	}
	after := data.pendingInfo()
	if after != nil && after.Comments == 0 {
		data.review = nil
	}
	return after, true, nil
}

// approveOwn refuses what GitHub refuses on your own PR.
func (d *demoSource) approveOwn(p *prDetail, event string) error {
	if p.author() != d.me {
		return nil
	}
	switch event {
	case "APPROVE":
		return refusedDemo("Can not approve your own pull request")
	case "REQUEST_CHANGES":
		return refusedDemo("Can not request changes on your own pull request")
	}
	return nil
}

func (d *demoSource) submitReview(_ context.Context, r repoRef, number int, reviewID, event, body string) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, data, err := d.reviewData(r, number)
	if err != nil {
		return "", err
	}
	if err := data.samePending(reviewID); err != nil {
		return "", err
	}
	if err := d.approveOwn(p, event); err != nil {
		return "", err
	}
	apply, outcome := demoOutcome(body)
	if !apply {
		return "", outcome
	}
	for i := range data.threads {
		for j := range data.threads[i].Comments {
			if c := &data.threads[i].Comments[j]; c.State == "pending" {
				c.State = "submitted"
			}
		}
	}
	data.review = nil
	data.submitted = &submittedInfo{ID: reviewID, State: demoSubmittedStates[event], At: nowFn().UnixMilli()}
	d.changed = true
	return p.URL + "#pullrequestreview-" + reviewID, outcome
}

func (d *demoSource) publishReview(_ context.Context, r repoRef, number int, _, event, body string) (string, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p, data, err := d.reviewData(r, number)
	if err != nil {
		return "", err
	}
	if data.review != nil {
		return "", refusedDemo("User can only have one pending review per pull request")
	}
	if err := d.approveOwn(p, event); err != nil {
		return "", err
	}
	apply, outcome := demoOutcome(body)
	if !apply {
		return "", outcome
	}
	id := data.newID("PRR", number)
	data.submitted = &submittedInfo{ID: id, State: demoSubmittedStates[event], At: nowFn().UnixMilli()}
	d.changed = true
	return p.URL + "#pullrequestreview-" + id, outcome
}

func (d *demoSource) discardReview(_ context.Context, r repoRef, number int, reviewID string) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	_, data, err := d.reviewData(r, number)
	if err != nil {
		return err
	}
	if err := data.samePending(reviewID); err != nil {
		return err
	}
	kept := data.threads[:0:0]
	for _, t := range data.threads {
		cs := []threadComment{}
		for _, c := range t.Comments {
			if c.State != "pending" {
				cs = append(cs, c)
			}
		}
		if len(cs) > 0 {
			t.Comments = cs
			kept = append(kept, t)
		}
	}
	data.threads = kept
	data.review = nil
	d.changed = true
	return nil
}

// saveReview and loadReview carry a PR's review state through app-demo.json.
func (data *demoPRFiles) saveReview() *demoReviewSave {
	return &demoReviewSave{Threads: data.threads, Pending: data.review, NextID: data.nextID, Drafted: data.drafted, Submitted: data.submitted}
}

func (data *demoPRFiles) loadReview(s *demoReviewSave) {
	data.threads = s.Threads
	if data.threads == nil {
		data.threads = []fileThread{}
	}
	data.review, data.nextID, data.drafted, data.submitted = s.Pending, s.NextID, s.Drafted, s.Submitted
}
