package main

import (
	"reflect"
	"strings"
	"testing"
)

func TestParsePatchRowsAndLineNumbers(t *testing.T) {
	patch := "@@ -7,4 +7,5 @@ func (s *Sync) run() {\n" +
		" keep\n" +
		"-old one\n" +
		"-old two\n" +
		"+new one\n" +
		"+new two\n" +
		"+new three\n" +
		" tail\n" +
		"@@ -40 +41 @@\n" +
		"-x\n" +
		"+y"
	rows, large := parsePatch(patch)
	want := []diffRow{
		{Kind: "hunk", Text: "@@ -7,4 +7,5 @@ func (s *Sync) run() {"},
		{Kind: "ctx", Old: 7, New: 7, Text: "keep"},
		{Kind: "del", Old: 8, Text: "old one"},
		{Kind: "del", Old: 9, Text: "old two"},
		{Kind: "add", New: 8, Text: "new one"},
		{Kind: "add", New: 9, Text: "new two"},
		{Kind: "add", New: 10, Text: "new three"},
		{Kind: "ctx", Old: 10, New: 11, Text: "tail"},
		{Kind: "hunk", Text: "@@ -40 +41 @@"},
		{Kind: "del", Old: 40, Text: "x"},
		{Kind: "add", New: 41, Text: "y"},
	}
	if large || !reflect.DeepEqual(rows, want) {
		t.Fatalf("large %v\n got %+v\nwant %+v", large, rows, want)
	}
}

func TestParsePatchAddedAndDeletedFiles(t *testing.T) {
	rows, _ := parsePatch("@@ -0,0 +1,2 @@\n+module A\n+end\n")
	want := []diffRow{{Kind: "hunk", Text: "@@ -0,0 +1,2 @@"}, {Kind: "add", New: 1, Text: "module A"}, {Kind: "add", New: 2, Text: "end"}}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("added: %+v", rows)
	}
	rows, _ = parsePatch("@@ -1,2 +0,0 @@\n-module A\n-end")
	want = []diffRow{{Kind: "hunk", Text: "@@ -1,2 +0,0 @@"}, {Kind: "del", Old: 1, Text: "module A"}, {Kind: "del", Old: 2, Text: "end"}}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("deleted: %+v", rows)
	}
}

func TestParsePatchNoNewlineAtEndOfFileIsANote(t *testing.T) {
	rows, _ := parsePatch("@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file")
	var kinds []string
	for _, r := range rows {
		kinds = append(kinds, r.Kind)
	}
	if !reflect.DeepEqual(kinds, []string{"hunk", "del", "note", "add", "note"}) {
		t.Fatalf("%v", kinds)
	}
	if rows[2].Text != `\ No newline at end of file` || rows[2].Old != 0 || rows[2].New != 0 {
		t.Fatalf("note row %+v", rows[2])
	}
	// A note takes no line number: the next add is still line 1.
	if rows[3].New != 1 {
		t.Fatalf("add after a note: %+v", rows[3])
	}
}

// A CRLF file's patch has \r before each \n: it must not reach the rows, and
// must not break the hunk header.
func TestParsePatchCRLF(t *testing.T) {
	rows, _ := parsePatch("@@ -1,2 +1,2 @@ section\r\n keep\r\n-a\r\n+b\r\n")
	want := []diffRow{
		{Kind: "hunk", Text: "@@ -1,2 +1,2 @@ section"},
		{Kind: "ctx", Old: 1, New: 1, Text: "keep"},
		{Kind: "del", Old: 2, Text: "a"},
		{Kind: "add", New: 2, Text: "b"},
	}
	if !reflect.DeepEqual(rows, want) {
		t.Fatalf("%+v", rows)
	}
}

func TestParsePatchHunkHeaderKeepsItsSectionName(t *testing.T) {
	rows, _ := parsePatch("@@ -10,3 +10,3 @@ class Foo < Bar\n a\n-b\n+c\n d")
	if rows[0].Text != "@@ -10,3 +10,3 @@ class Foo < Bar" || rows[1].Old != 10 || rows[1].New != 10 {
		t.Fatalf("%+v", rows[:2])
	}
}

// A blank context line can lose its space; it's still a context line.
func TestParsePatchBlankContextLine(t *testing.T) {
	rows, _ := parsePatch("@@ -1,3 +1,3 @@\n a\n\n-b\n+c")
	if rows[2].Kind != "ctx" || rows[2].Old != 2 || rows[2].New != 2 || rows[2].Text != "" {
		t.Fatalf("%+v", rows)
	}
	if rows[3].Old != 3 {
		t.Fatalf("del after blank: %+v", rows[3])
	}
}

// Tab stops count from after the marker, so a tab at the start of a line is
// four spaces whatever the marker was.
func TestParsePatchExpandsTabsFromAfterTheMarker(t *testing.T) {
	rows, _ := parsePatch("@@ -1 +1 @@\n+\tx\n+ab\tc\n+abcd\te\n ctx\tz")
	got := []string{rows[1].Text, rows[2].Text, rows[3].Text, rows[4].Text}
	want := []string{"    x", "ab  c", "abcd    e", "ctx z"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestParsePatchCutsLongLinesWithAMarker(t *testing.T) {
	long := strings.Repeat("é", maxLineChars+10)
	rows, _ := parsePatch("@@ -1 +1 @@\n+" + long + "\n+" + strings.Repeat("a", maxLineChars))
	if got := []rune(rows[1].Text); len(got) != maxLineChars+len([]rune(lineCutMarker)) || !strings.HasSuffix(rows[1].Text, lineCutMarker) {
		t.Fatalf("cut line is %d runes, ends %q", len(got), rows[1].Text[len(rows[1].Text)-20:])
	}
	if strings.Contains(rows[2].Text, "truncated") {
		t.Fatal("a line of exactly the limit is not cut")
	}
}

// Escape sequences are cleaned out of rows, and the tab count isn't thrown
// off by what was dropped.
func TestParsePatchCleansEachRow(t *testing.T) {
	rows, _ := parsePatch("@@ -1 +1 @@\n+\x1b]52;c;ZXZpbA==\x07ok\x1b[31m\tx")
	if rows[1].Text != "ok  x" {
		t.Fatalf("row text %q", rows[1].Text)
	}
	if strings.ContainsRune(rows[1].Text, 0x1b) {
		t.Fatal("an escape got through")
	}
}

func TestParsePatchPastTheRowCapIsLarge(t *testing.T) {
	var b strings.Builder
	b.WriteString("@@ -0,0 +1,5001 @@")
	for i := 0; i < maxDiffRows; i++ {
		b.WriteString("\n+x")
	}
	rows, large := parsePatch(b.String())
	if !large || rows != nil {
		t.Fatalf("%d rows, large %v", len(rows), large)
	}
	// Exactly at the cap is fine: the hunk header is one of the rows.
	rows, large = parsePatch(b.String()[:len(b.String())-3])
	if large || len(rows) != maxDiffRows {
		t.Fatalf("at the cap: %d rows, large %v", len(rows), large)
	}
}

func TestParsePatchPastTheSizeCapIsLarge(t *testing.T) {
	line := "\n+" + strings.Repeat("y", 3000)
	patch := "@@ -0,0 +1,900 @@" + strings.Repeat(line, 900) // ~2.7 MB
	if rows, large := parsePatch(patch); !large || rows != nil {
		t.Fatalf("%d rows, large %v", len(rows), large)
	}
}

func TestNoPatchRule(t *testing.T) {
	cases := []struct {
		name string
		f    restFile
		want string
	}{
		{"binary added", restFile{Status: "added", SHA: "abc"}, diffBinary},
		{"binary modified", restFile{Status: "modified", SHA: "abc"}, diffBinary},
		{"binary removed", restFile{Status: "removed", SHA: "abc"}, diffBinary},
		{"pure rename", restFile{Status: "renamed", SHA: "abc"}, diffEmpty},
		{"pure copy", restFile{Status: "copied", SHA: "abc"}, diffEmpty},
		{"mode change", restFile{Status: "changed", SHA: "abc"}, diffEmpty},
		{"unchanged", restFile{Status: "unchanged", SHA: "abc"}, diffEmpty},
		{"empty file added", restFile{Status: "added", SHA: emptyBlobSHA}, diffEmpty},
		{"empty file deleted", restFile{Status: "removed", SHA: emptyBlobSHA}, diffEmpty},
		{"left out as too big", restFile{Status: "modified", Changes: 40000, SHA: "abc"}, diffLarge},
		{"renamed and edited, patch left out", restFile{Status: "renamed", Changes: 12, SHA: "abc"}, diffLarge},
	}
	for _, c := range cases {
		if got := noPatchState(c.f); got != c.want {
			t.Errorf("%s: %s, want %s", c.name, got, c.want)
		}
	}
}
