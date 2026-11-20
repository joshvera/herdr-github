package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testMutation = `mutation($id: ID!) { resolveReviewThread(input: {threadId: $id}) { thread { isResolved } } }`

// mutationFake serves every GraphQL request with respond, and counts them.
func mutationFake(t *testing.T, respond http.HandlerFunc) *int32 {
	t.Helper()
	var n int32
	fakeGitHub(t, func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(&n, 1)
		decodeReq(t, r)
		respond(w, r)
	})
	return &n
}

func writeJSON(body string, code int) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}
}

// hangUp reads the request, then drops the connection without answering.
func hangUp(t *testing.T) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hj, ok := w.(http.Hijacker)
		if !ok {
			t.Fatal("can't hijack")
		}
		conn, _, err := hj.Hijack()
		if err != nil {
			t.Fatal(err)
		}
		_ = conn.Close()
	}
}

type resolvedPayload struct {
	Thread struct {
		IsResolved bool `json:"isResolved"`
	} `json:"thread"`
}

func runTestMutation(ctx context.Context) (resolvedPayload, error) {
	var out resolvedPayload
	err := newClient("github.com").mutate(ctx, testMutation, map[string]any{"id": "T"}, "resolveReviewThread", &out)
	return out, err
}

func TestMutateOK(t *testing.T) {
	n := mutationFake(t, writeJSON(`{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}}}`, 200))
	out, err := runTestMutation(ctxBG())
	if err != nil || !out.Thread.IsResolved {
		t.Fatalf("%+v %v", out, err)
	}
	if atomic.LoadInt32(n) != 1 {
		t.Fatalf("%d requests", atomic.LoadInt32(n))
	}
}

// GitHub's refusal of a mutation (seen on the sandbox PR): the field is null
// and every error's type is a refusal. Refused, and said as GitHub said it.
func TestMutateRefusals(t *testing.T) {
	for name, h := range map[string]http.HandlerFunc{
		"unprocessable": writeJSON(`{"data":{"resolveReviewThread":null},"errors":[{"type":"UNPROCESSABLE","path":["resolveReviewThread"],"message":"Line could not be resolved"}]}`, 200),
		"not found":     writeJSON(`{"data":{"resolveReviewThread":null},"errors":[{"type":"NOT_FOUND","message":"Could not resolve to a node"}]}`, 200),
		"validation":    writeJSON(`{"data":{"resolveReviewThread":null},"errors":[{"type":"VALIDATION","message":"The commitOID is not part of the pull request"}]}`, 200),
		"forbidden":     writeJSON(`{"data":{"resolveReviewThread":null},"errors":[{"type":"FORBIDDEN","message":"nope"}]}`, 200),
		"rate limited":  writeJSON(`{"data":null,"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}`, 200),
		"403":           writeJSON(`{"message":"You have exceeded a secondary rate limit"}`, 403),
		"429":           writeJSON(`{"message":"slow down"}`, 429),
		"other 4xx":     writeJSON(`{"message":"Problems parsing JSON"}`, 400),
	} {
		t.Run(name, func(t *testing.T) {
			n := mutationFake(t, h)
			_, err := runTestMutation(ctxBG())
			if err == nil || isUnknown(err) {
				t.Fatalf("want refused, got %v (unknown %v)", err, isUnknown(err))
			}
			if e := appError(err); e["unknown"] != nil {
				t.Fatalf("answer %v", e)
			}
			if atomic.LoadInt32(n) != 1 {
				t.Fatalf("%d requests: a refusal is never sent again", atomic.LoadInt32(n))
			}
		})
	}
}

func TestMutateRefusalSaysWhatGitHubSaid(t *testing.T) {
	mutationFake(t, writeJSON(`{"data":{"resolveReviewThread":null},"errors":[{"type":"UNPROCESSABLE","message":"Line could not be resolved\u001b[2J"}]}`, 200))
	_, err := runTestMutation(ctxBG())
	if err == nil || err.Error() != "GitHub: Line could not be resolved" {
		t.Fatalf("%v", err)
	}
}

// Signed out is a refusal too, and the token is asked for again next time.
func TestMutateUnauthorizedIsSignedOut(t *testing.T) {
	n := mutationFake(t, writeJSON(`{"message":"Bad credentials"}`, 401))
	_, err := runTestMutation(ctxBG())
	if !errors.Is(err, errSignedOut) || isUnknown(err) || atomic.LoadInt32(n) != 1 {
		t.Fatalf("%v, %d requests", err, atomic.LoadInt32(n))
	}
}

// Once the request is written, anything short of GitHub's refusal is
// unknown: it may have been done.
func TestMutateUnknowns(t *testing.T) {
	for name, h := range map[string]http.HandlerFunc{
		"500":                 writeJSON(`{"message":"Server Error"}`, 500),
		"502 not json":        writeJSON(`<html>bad gateway</html>`, 502),
		"errors with data":    writeJSON(`{"data":{"resolveReviewThread":{"thread":{"isResolved":true}}},"errors":[{"type":"FORBIDDEN","message":"partly"}]}`, 200),
		"untyped error":       writeJSON(`{"data":{"resolveReviewThread":null},"errors":[{"message":"Something went wrong"}]}`, 200),
		"unknown type":        writeJSON(`{"data":{"resolveReviewThread":null},"errors":[{"type":"INTERNAL","message":"x"}]}`, 200),
		"one refusal of two":  writeJSON(`{"data":{"resolveReviewThread":null},"errors":[{"type":"NOT_FOUND","message":"x"},{"message":"timeout"}]}`, 200),
		"not json":            writeJSON(`{"data":`, 200),
		"no result":           writeJSON(`{"data":{"resolveReviewThread":null}}`, 200),
		"dropped after write": hangUp(t),
		"cut off": func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Length", "500")
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{"data":{"resolveRe`))
			w.(http.Flusher).Flush()
			hangUp(t)(w, r)
		},
	} {
		t.Run(name, func(t *testing.T) {
			n := mutationFake(t, h)
			_, err := runTestMutation(ctxBG())
			if !isUnknown(err) {
				t.Fatalf("want unknown, got %v", err)
			}
			if e := appError(err); e["unknown"] != true || e["error"] == "" {
				t.Fatalf("answer %v", e)
			}
			if atomic.LoadInt32(n) != 1 {
				t.Fatalf("%d requests: nothing is sent again", atomic.LoadInt32(n))
			}
		})
	}
}

// A mutation whose payload isn't read (merge, setDraft, deleteRef...) is
// still unknown when GitHub answers without it: no errors isn't a yes.
func TestMutateNoResultIsUnknownWhenThePayloadIsntRead(t *testing.T) {
	for name, body := range map[string]string{
		"null":    `{"data":{"resolveReviewThread":null}}`,
		"missing": `{"data":{}}`,
	} {
		t.Run(name, func(t *testing.T) {
			n := mutationFake(t, writeJSON(body, 200))
			err := newClient("github.com").mutate(ctxBG(), testMutation, map[string]any{"id": "T"}, "resolveReviewThread", nil)
			if !isUnknown(err) {
				t.Fatalf("want unknown, got %v", err)
			}
			if atomic.LoadInt32(n) != 1 {
				t.Fatalf("%d requests: nothing is sent again", atomic.LoadInt32(n))
			}
		})
	}
}

// The deadline falls while GitHub has the request: unknown.
func TestMutateDeadlineAfterWriteIsUnknown(t *testing.T) {
	old := minTimeToSend
	minTimeToSend = 0
	t.Cleanup(func() { minTimeToSend = old })
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	n := mutationFake(t, func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	})
	ctx, cancel := context.WithTimeout(ctxBG(), 200*time.Millisecond)
	defer cancel()
	_, err := runTestMutation(ctx)
	if !isUnknown(err) || atomic.LoadInt32(n) != 1 {
		t.Fatalf("%v, %d requests", err, atomic.LoadInt32(n))
	}
}

// Too little time left to send: refused, and nothing reaches GitHub.
func TestMutateRefusesWithTooLittleTimeLeft(t *testing.T) {
	n := mutationFake(t, writeJSON(`{}`, 200))
	ctx, cancel := context.WithTimeout(ctxBG(), minTimeToSend-time.Second)
	defer cancel()
	_, err := runTestMutation(ctx)
	if !errors.Is(err, errTookTooLong) || isUnknown(err) || err.Error() != "Took too long to prepare. Nothing was sent." {
		t.Fatalf("%v", err)
	}
	done, cancel2 := context.WithCancel(ctxBG())
	cancel2()
	if _, err := runTestMutation(done); !errors.Is(err, errTookTooLong) {
		t.Fatalf("a done context: %v", err)
	}
	if atomic.LoadInt32(n) != 0 {
		t.Fatalf("%d requests", atomic.LoadInt32(n))
	}
}

// A failure before the request is written is refused: nothing left.
func TestMutateUnreachableIsRefused(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	url := srv.URL
	srv.Close()
	oldE, oldT := endpointFn, tokenFn
	endpointFn = func(string) string { return url }
	tokenFn = func(context.Context, string) (string, error) { return "tok", nil }
	t.Cleanup(func() { endpointFn, tokenFn = oldE, oldT })
	_, err := runTestMutation(ctxBG())
	if err == nil || isUnknown(err) || !strings.Contains(err.Error(), "Nothing was sent") {
		t.Fatalf("%v", err)
	}
}

// No token: refused before anything is sent.
func TestMutateWithoutATokenIsRefused(t *testing.T) {
	n := mutationFake(t, writeJSON(`{}`, 200))
	tokenFn = func(context.Context, string) (string, error) { return "", &signedOutError{"github.com"} }
	_, err := runTestMutation(ctxBG())
	if !errors.Is(err, errSignedOut) || isUnknown(err) || atomic.LoadInt32(n) != 0 {
		t.Fatalf("%v, %d requests", err, atomic.LoadInt32(n))
	}
}

// The existing acts answer unknown too, through runApp.
func TestOpActUnknownSaysSo(t *testing.T) {
	cacheFixture(t)
	var mutations int32
	fakeGitHub(t, func(w http.ResponseWriter, r *http.Request) {
		req := decodeReq(t, r)
		if strings.HasPrefix(strings.TrimSpace(req.Query), "mutation") {
			atomic.AddInt32(&mutations, 1)
			http.Error(w, "boom", http.StatusBadGateway)
			return
		}
		reply(w, map[string]any{"repository": map[string]any{"pullRequest": map[string]any{"id": "PR_x", "headRefOid": headA}}})
	})
	got := opRun(t, actReq("viewed", headA, "a.rb"))
	if got["unknown"] != true || got["error"] == nil || got["ok"] != nil {
		t.Fatalf("%v", got)
	}
	if atomic.LoadInt32(&mutations) != 1 {
		t.Fatalf("%d mutations", atomic.LoadInt32(&mutations))
	}
}
