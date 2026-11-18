package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// The diff cache keeps a PR's REST files (raw patches, never cleaned) under
// the head commit they were read at, in stateDir()/diffs/<key>-<head>.json,
// so the next process (every op is one) can answer a `diff` with no request.
//
// Several processes share it, so it avoids cache.go's pattern (a fixed .tmp
// name, a mutex that only guards one process): a file is written through
// os.CreateTemp in the same folder and renamed, which readers see whole or
// not at all. A missing or corrupt file is a miss, never an error. The clock
// here is real time and real mtimes, not nowFn.

// cacheMaxAge is how long any cache file lives.
const cacheMaxAge = 7 * 24 * time.Hour

type diffCacheFile struct {
	Key   string     `json:"key"` // the PR, as openedKey spells it: guards a slug collision
	Head  string     `json:"head"`
	Files []restFile `json:"files"`
}

func diffCacheDir() string { return filepath.Join(stateDir(), "diffs") }

// diffCacheKey is the PR as one path segment, lowercase.
func diffCacheKey(r repoRef, number int) string {
	return strings.ToLower(slug(r.Host + "_" + r.Owner + "_" + r.Name + "_" + strconv.Itoa(number)))
}

func diffCachePath(r repoRef, number int, head string) string {
	return filepath.Join(diffCacheDir(), diffCacheKey(r, number)+"-"+head+".json")
}

// readDiffCache is the PR's files as they were at head, if they were kept.
func readDiffCache(r repoRef, number int, head string) ([]restFile, bool) {
	if !headPattern.MatchString(head) {
		return nil, false
	}
	data, err := os.ReadFile(diffCachePath(r, number, head))
	if err != nil {
		return nil, false
	}
	var c diffCacheFile
	if json.Unmarshal(data, &c) != nil || c.Head != head || c.Key != openedKey(r, number) || c.Files == nil {
		return nil, false
	}
	return c.Files, true
}

// writeDiffCache keeps the PR's files under head, then prunes. before is when
// this process first read the head: a file for another head is deleted only
// if it's older than that, so a slow process for an old head can't delete the
// file a newer head's process wrote while it ran.
func writeDiffCache(r repoRef, number int, head string, files []restFile, before time.Time) error {
	if !headPattern.MatchString(head) {
		return nil
	}
	if files == nil {
		files = []restFile{}
	}
	data, err := json.Marshal(diffCacheFile{Key: openedKey(r, number), Head: head, Files: files})
	if err != nil {
		return err
	}
	dir := diffCacheDir()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "tmp-*")
	if err != nil {
		return err
	}
	_, werr := tmp.Write(data)
	cerr := tmp.Close()
	if err := firstErr(werr, cerr, os.Chmod(tmp.Name(), 0o600)); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), diffCachePath(r, number, head)); err != nil {
		os.Remove(tmp.Name())
		return err
	}
	pruneDiffCache(r, number, head, before, time.Now())
	return nil
}

func firstErr(errs ...error) error {
	for _, e := range errs {
		if e != nil {
			return e
		}
	}
	return nil
}

// pruneDiffCache deletes, best effort: this PR's files for other heads that
// are older than before, and any file at all older than a week. Other PRs' files
// are matched by exact name (<key>-<40 or 64 hex>.json), never a loose glob.
func pruneDiffCache(r repoRef, number int, keep string, before, now time.Time) {
	entries, err := os.ReadDir(diffCacheDir())
	if err != nil {
		return
	}
	mine := regexp.MustCompile(`^` + regexp.QuoteMeta(diffCacheKey(r, number)) + `-([0-9a-f]{40}|[0-9a-f]{64})\.json$`)
	for _, e := range entries {
		info, err := e.Info()
		if err != nil || !info.Mode().IsRegular() {
			continue
		}
		name, path := e.Name(), filepath.Join(diffCacheDir(), e.Name())
		switch m := mine.FindStringSubmatch(name); {
		case now.Sub(info.ModTime()) > cacheMaxAge:
			os.Remove(path)
		case m != nil && m[1] != keep && info.ModTime().Before(before):
			os.Remove(path)
		}
	}
}

// restFilesAt is the PR's REST files at head: from the cache, or fetched,
// checked and kept. head is what the caller just read from GitHub. Nothing
// is kept unless the head is the same before the first page and after the
// last (and every file's ref agrees): otherwise it's a *staleError, since
// the pages may belong to either commit.
func (c *ghClient) restFilesAt(ctx context.Context, r repoRef, number int, head string, before time.Time) ([]restFile, error) {
	if files, ok := readDiffCache(r, number, head); ok {
		return files, nil
	}
	files, err := c.restFetch(ctx, r, number, head)
	if err != nil {
		return nil, err
	}
	_, after, err := c.prHead(ctx, r, number)
	if err != nil {
		return nil, err
	}
	if after != head {
		return nil, &staleError{Head: after}
	}
	_ = writeDiffCache(r, number, head, files, before) // a cache that can't be written is only slower
	return files, nil
}
