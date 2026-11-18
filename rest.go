package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// REST is only for what GraphQL doesn't have: each changed file's patch and
// a rename's old path (GET pulls/N/files). It always serves the PR's current
// head and doesn't say which, so callers check the head around it (see
// restFilesAt).

const (
	restPageSize = 100
	restMaxPages = 30       // REST's own cap is 3000 files
	restMaxBody  = 64 << 20 // one page of files, patches and all
)

// nextPage matches the Link header's rel="next". Only whether there is a
// next page is read from it; the URL isn't: the token never follows a URL
// GitHub hands back.
var nextPage = regexp.MustCompile(`<[^>]*>\s*;[^,]*\brel="?next"?`)

// restFileWire is a REST file as it comes: restFile, and what only the head
// check needs.
type restFileWire struct {
	restFile
	ContentsURL string `json:"contents_url"`
}

// restPage is one page of a PR's files. More says there's a page after it.
func (c *ghClient) restPage(ctx context.Context, r repoRef, number, page int) (files []restFileWire, more bool, err error) {
	token, err := c.auth(ctx)
	if err != nil {
		return nil, false, err
	}
	u := fmt.Sprintf("%s/repos/%s/%s/pulls/%d/files?per_page=%d&page=%d",
		restEndpointFn(c.host), url.PathEscape(r.Owner), url.PathEscape(r.Name), number, restPageSize, page)
	req, err := http.NewRequestWithContext(ctx, "GET", u, nil)
	if err != nil {
		return nil, false, err
	}
	req.Header.Set("Authorization", "bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "herdr-github")
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, false, fmt.Errorf("GitHub: %w", err)
	}
	defer resp.Body.Close()
	data, err := io.ReadAll(io.LimitReader(resp.Body, restMaxBody+1))
	if err != nil {
		return nil, false, fmt.Errorf("GitHub: %w", err)
	}
	if len(data) > restMaxBody {
		return nil, false, errors.New("GitHub: the files answer is too big")
	}
	switch {
	case resp.StatusCode == http.StatusUnauthorized:
		c.mu.Lock()
		c.token = ""
		c.mu.Unlock()
		return nil, false, &signedOutError{c.host}
	case resp.StatusCode != http.StatusOK:
		var msg struct {
			Message string `json:"message"`
		}
		if json.Unmarshal(data, &msg) == nil && msg.Message != "" {
			return nil, false, fmt.Errorf("GitHub: HTTP %d: %s", resp.StatusCode, clean(msg.Message, false))
		}
		return nil, false, fmt.Errorf("GitHub: HTTP %d", resp.StatusCode)
	}
	if err := json.Unmarshal(data, &files); err != nil {
		return nil, false, fmt.Errorf("GitHub: bad reply: %w", err)
	}
	return files, nextPage.MatchString(resp.Header.Get("Link")), nil
}

// restFetch reads every page of a PR's files, and checks each against head:
// a file's contents_url names the commit it was served at (?ref=), so a page
// from another head is refused with a staleError. A file with no ref (a
// removed one, or an Enterprise server that leaves it out) passes: the
// caller's reads of the head before and after are the guard then.
func (c *ghClient) restFetch(ctx context.Context, r repoRef, number int, head string) ([]restFile, error) {
	var out []restFile
	for page := 1; page <= restMaxPages; page++ {
		files, more, err := c.restPage(ctx, r, number, page)
		if err != nil {
			return nil, err
		}
		for _, f := range files {
			if ref := contentsRef(f); ref != "" && ref != head {
				return nil, &staleError{Head: ref}
			}
			out = append(out, f.restFile)
		}
		if !more {
			break
		}
	}
	return out, nil
}

// contentsRef is the commit a file's contents_url names, lowercased, or "".
// A ref that isn't a commit id (a branch name, say, from a server that puts
// one there) counts as none, so nothing GitHub's REST answer says that
// isn't a commit id is ever used: the head reads around the fetch are the
// guard then.
func contentsRef(f restFileWire) string {
	if f.Status == "removed" || f.ContentsURL == "" {
		return ""
	}
	u, err := url.Parse(f.ContentsURL)
	if err != nil {
		return ""
	}
	ref := strings.ToLower(u.Query().Get("ref"))
	if !headPattern.MatchString(ref) {
		return ""
	}
	return ref
}

// prHead is a PR's node ID and its head commit, the least it takes to
// guard a read or a write against new commits.
func (c *ghClient) prHead(ctx context.Context, r repoRef, number int) (id, head string, err error) {
	var res struct {
		Repository *struct {
			PullRequest *struct {
				ID         string `json:"id"`
				HeadRefOid string `json:"headRefOid"`
			} `json:"pullRequest"`
		} `json:"repository"`
	}
	err = c.graphql(ctx, `query($owner: String!, $name: String!, $n: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $n) { id headRefOid } }
}`, map[string]any{"owner": r.Owner, "name": r.Name, "n": number}, &res)
	if res.Repository == nil || res.Repository.PullRequest == nil {
		if err == nil || isPartial(err) {
			err = fmt.Errorf("%s#%d isn't there, or isn't yours to see", r, number)
		}
		return "", "", err
	}
	pr := res.Repository.PullRequest
	if !headPattern.MatchString(pr.HeadRefOid) {
		return "", "", fmt.Errorf("GitHub gave no head commit for %s#%d", r, number)
	}
	return pr.ID, pr.HeadRefOid, nil
}

// headPattern is a commit id: SHA-1 or SHA-256, lowercase hex. A head from a
// request is checked against it before it's used for anything.
var headPattern = regexp.MustCompile(`^([0-9a-f]{40}|[0-9a-f]{64})$`)
