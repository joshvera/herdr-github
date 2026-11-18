package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptrace"
	"strings"
	"sync/atomic"
	"time"
)

// A mutation changes something on GitHub, so it has a path of its own, apart
// from graphql(): one HTTP request, never repeated, and an outcome that is
// one of three things.
//
//	ok       GitHub answered with what was asked for.
//	refused  GitHub said it didn't do it, or nothing was sent.
//	unknown  It was sent, and what GitHub did with it isn't known.
//
// The line between refused and unknown is whether the request was written:
// httptrace says when it was. Before that, any failure is refused (nothing
// left this machine). After it, any failure is unknown, unless GitHub's own
// answer says it refused.
//
// The transport may still try a request again on a new connection when it
// knows nothing of the first try was written (net/http's nothingWrittenError,
// HTTP/2's refused stream): GitHub never saw the first, so that isn't a
// second mutation.

// mutationDeadline bounds a whole act: the token, any reads, and the
// mutation. The mod waits longer than this, so the binary always answers.
// minTimeToSend is how much of it must be left to send the mutation at all.
// Both are vars so tests can shrink them.
var (
	mutationDeadline = 20 * time.Second
	minTimeToSend    = 8 * time.Second
)

// errTookTooLong: too little of the deadline was left to send safely.
var errTookTooLong = errors.New("Took too long to prepare. Nothing was sent.")

// actError is an act's answer when it didn't go as asked: a refusal, or an
// outcome that isn't known. What it carries beyond the message goes into the
// answer next to "error" (see appError).
type actError struct {
	err     error
	unknown bool // sent, and what GitHub did with it isn't known
	// review is the viewer's pending review as it is now, sent only when
	// hasReview is set (a nil review is then an explicit null).
	review    *reviewInfo
	hasReview bool
	changed   bool // submit, discard: the review isn't the one the dialog showed
}

func (e *actError) Error() string { return e.err.Error() }
func (e *actError) Unwrap() error { return e.err }

// unknownErr is an outcome that isn't known: it may have gone through.
func unknownErr(format string, args ...any) error {
	return &actError{err: fmt.Errorf(format, args...), unknown: true}
}

// isUnknown says whether err is an outcome that isn't known.
func isUnknown(err error) bool {
	var a *actError
	return errors.As(err, &a) && a.unknown
}

// withReview adds the pending review to an act's error answer, keeping
// whether it's unknown.
func withReview(err error, review *reviewInfo) error {
	a := &actError{err: err}
	var inner *actError
	if errors.As(err, &inner) {
		c := *inner
		a = &c
	}
	a.review, a.hasReview = review, true
	return a
}

// refusalTypes are GraphQL error types that mean GitHub didn't do it.
var refusalTypes = map[string]bool{
	"UNPROCESSABLE": true, "NOT_FOUND": true, "VALIDATION": true, "FORBIDDEN": true,
	"RATE_LIMITED": true, "INSUFFICIENT_SCOPES": true,
}

// checkTimeLeft refuses to send with less than minTimeToSend of the
// deadline left, or once ctx is done. A ctx with no deadline (the TUI's) is
// only checked for being done.
func checkTimeLeft(ctx context.Context) error {
	if ctx.Err() != nil {
		return errTookTooLong
	}
	if dl, ok := ctx.Deadline(); ok && time.Until(dl) < minTimeToSend {
		return errTookTooLong
	}
	return nil
}

// mutate runs one mutation whose top-level field is field, and decodes that
// field's payload into out (when out isn't nil), cleaned as graphql() cleans.
// Its error is refused unless isUnknown says otherwise.
func (c *ghClient) mutate(ctx context.Context, query string, vars map[string]any, field string, out any) error {
	token, err := c.auth(ctx)
	if err != nil {
		return err
	}
	body, err := json.Marshal(map[string]any{"query": query, "variables": vars})
	if err != nil {
		return err
	}
	if err := checkTimeLeft(ctx); err != nil {
		return err
	}
	var wrote atomic.Bool
	trace := &httptrace.ClientTrace{
		// Called once the request is written, or failed while being written:
		// either way GitHub may have it from here on.
		WroteRequest: func(httptrace.WroteRequestInfo) { wrote.Store(true) },
	}
	req, err := http.NewRequestWithContext(httptrace.WithClientTrace(ctx, trace), "POST", endpointFn(c.host), bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "herdr-github")
	resp, err := c.http.Do(req)
	if err != nil {
		if wrote.Load() {
			return unknownErr("No answer from GitHub (%s). It may have gone through.", clean(err.Error(), false))
		}
		return fmt.Errorf("Couldn't reach GitHub (%s). Nothing was sent.", clean(err.Error(), false))
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return unknownErr("GitHub's answer was cut off (%s). It may have gone through.", clean(err.Error(), false))
	}
	switch code := resp.StatusCode; {
	case code == http.StatusUnauthorized:
		c.mu.Lock()
		c.token = ""
		c.mu.Unlock()
		return &signedOutError{c.host}
	case code == http.StatusForbidden, code == http.StatusTooManyRequests:
		return fmt.Errorf("GitHub refused it (HTTP %d%s). Nothing was done.", code, restMessage(data))
	case code >= 500:
		return unknownErr("GitHub had an error (HTTP %d). It may have gone through.", code)
	case code >= 400:
		return fmt.Errorf("GitHub refused it (HTTP %d%s). Nothing was done.", code, restMessage(data))
	case code != http.StatusOK:
		return unknownErr("GitHub answered HTTP %d. It may have gone through.", code)
	}
	var reply struct {
		Data   map[string]json.RawMessage `json:"data"`
		Errors []gqlError                 `json:"errors"`
	}
	if err := json.Unmarshal(data, &reply); err != nil {
		return unknownErr("GitHub's answer didn't make sense. It may have gone through.")
	}
	payload := reply.Data[field]
	applied := len(payload) > 0 && string(payload) != "null"
	if len(reply.Errors) > 0 {
		msgs := make([]string, 0, len(reply.Errors))
		refused := true
		for _, e := range reply.Errors {
			msgs = append(msgs, clean(e.Message, false))
			refused = refused && refusalTypes[e.Type]
		}
		msg := "GitHub: " + strings.Join(msgs, "; ")
		if refused && !applied {
			return errors.New(msg)
		}
		// Errors with a result, or errors of a kind that doesn't say it
		// wasn't done: it may have been.
		return &actError{err: errors.New(msg), unknown: true}
	}
	if out == nil {
		return nil
	}
	if !applied {
		return unknownErr("GitHub answered without the result. It may have gone through.")
	}
	if err := json.Unmarshal(payload, out); err != nil {
		return unknownErr("GitHub's answer didn't make sense (%s). It may have gone through.", clean(err.Error(), false))
	}
	sanitize(out)
	return nil
}

// restMessage is ": <message>" from a REST-style error body, or "".
func restMessage(data []byte) string {
	var m struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(data, &m) == nil && m.Message != "" {
		return ": " + clean(m.Message, false)
	}
	return ""
}
