package main

import (
	"regexp"
	"strconv"
	"strings"
)

// A file's diff, as the Files changed view draws it: GitHub's unified patch
// turned into rows. Rows are parsed from the raw patch first, because
// sanitizing flattens line breaks, and only then is each row's text cleaned.

// Caps on one file's diff: past either, the state is "large".
const (
	maxDiffRows   = 5000
	maxDiffBytes  = 2 << 20 // of row text, once cleaned and tabs are spaces
	maxLineChars  = 4000
	tabStop       = 4
	lineCutMarker = "… (line truncated)"
	emptyBlobSHA  = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
)

// Diff states. Rows are empty unless it's ok.
const (
	diffOK     = "ok"
	diffBinary = "binary" // no text diff
	diffLarge  = "large"  // GitHub left the patch out, or it's past the caps
	diffEmpty  = "empty"  // a rename or mode change with no lines
	diffStale  = "stale"  // the PR's head isn't the one asked for
)

// diffRow is one line of a diff. Kind is hunk, add, del, ctx or note.
// Old and New are line numbers (0 where a row has none).
type diffRow struct {
	Kind string `json:"kind"`
	Old  int    `json:"old,omitempty"`
	New  int    `json:"new,omitempty"`
	Text string `json:"text"`
}

var hunkHeader = regexp.MustCompile(`^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@`)

// parsePatch turns a unified patch (GitHub's, with no file header) into
// rows. large is true when it's past the row or size caps.
func parsePatch(patch string) (rows []diffRow, large bool) {
	patch = strings.TrimSuffix(patch, "\n")
	if patch == "" {
		return nil, false
	}
	oldN, newN, size := 0, 0, 0
	inHunk := false
	for _, line := range strings.Split(patch, "\n") {
		var row diffRow
		switch {
		case strings.HasPrefix(line, "@@"):
			if m := hunkHeader.FindStringSubmatch(line); m != nil {
				oldN, _ = strconv.Atoi(m[1])
				newN, _ = strconv.Atoi(m[2])
			}
			inHunk = true
			row = diffRow{Kind: "hunk", Text: rowText(line)}
		case !inHunk:
			continue // nothing before the first hunk is a line of the file
		case strings.HasPrefix(line, "+"):
			row = diffRow{Kind: "add", New: newN, Text: rowText(line[1:])}
			newN++
		case strings.HasPrefix(line, "-"):
			row = diffRow{Kind: "del", Old: oldN, Text: rowText(line[1:])}
			oldN++
		case strings.HasPrefix(line, `\`):
			row = diffRow{Kind: "note", Text: rowText(line)}
		case strings.HasPrefix(line, " "), line == "", line == "\r":
			// An empty line is a context line whose space was trimmed away.
			row = diffRow{Kind: "ctx", Old: oldN, New: newN, Text: rowText(strings.TrimPrefix(line, " "))}
			oldN++
			newN++
		default:
			continue
		}
		size += len(row.Text)
		if len(rows) >= maxDiffRows || size > maxDiffBytes {
			return nil, true
		}
		rows = append(rows, row)
	}
	return rows, false
}

// rowText cleans one line (the one place a patch's text is cleaned), puts
// its tabs on 4-column stops and cuts it at maxLineChars. Cleaning first
// keeps tabs (keepBreaks) so they can be expanded; a line has no newlines.
func rowText(s string) string {
	s = clean(s, true)
	if strings.ContainsRune(s, '\t') {
		var b strings.Builder
		col := 0
		for _, r := range s {
			if r != '\t' {
				b.WriteRune(r)
				col++
				continue
			}
			n := tabStop - col%tabStop
			b.WriteString(strings.Repeat(" ", n))
			col += n
		}
		s = b.String()
	}
	if len(s) > maxLineChars { // bytes ≥ runes: only then is it worth counting runes
		if rs := []rune(s); len(rs) > maxLineChars {
			s = string(rs[:maxLineChars]) + lineCutMarker
		}
	}
	return s
}

// noPatchState says why a file has no patch. GitHub doesn't say, so it's
// read from what's left: a file with no changed lines is binary, unless it's
// a rename, copy or mode change (or an empty blob), which has nothing to show;
// one with changed lines but no patch was left out as too big.
func noPatchState(f restFile) string {
	switch {
	case f.Status == "unchanged", f.SHA == emptyBlobSHA:
		return diffEmpty
	case f.Changes > 0:
		return diffLarge
	case f.Status == "renamed", f.Status == "copied", f.Status == "changed":
		return diffEmpty
	}
	return diffBinary
}

// restFile is one file of REST's pulls/N/files, as the cache keeps it: the
// raw patch (never cleaned) and what the no-patch rule reads. Status is
// REST's (added removed modified renamed copied changed unchanged).
type restFile struct {
	Filename         string `json:"filename"`
	PreviousFilename string `json:"previous_filename,omitempty"`
	Status           string `json:"status"`
	Changes          int    `json:"changes"`
	SHA              string `json:"sha"`
	Patch            string `json:"patch,omitempty"`
}
