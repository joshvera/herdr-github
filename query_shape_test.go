package main

import (
	"regexp"
	"testing"
)

// A directive goes after a field's name and arguments, before its selection
// set: `reviews(first: 1) @include(if: $x) { ... }`. Placed after the closing
// brace, GitHub refuses the whole query ("Expected NAME, actual: DIR_SIGN"),
// which the fake server, not parsing GraphQL, never notices.
func TestQueriesPutDirectivesBeforeSelectionSets(t *testing.T) {
	afterBrace := regexp.MustCompile(`\}\s*@(include|skip)\b`)
	for name, q := range map[string]string{
		"filesQuery":       filesQuery,
		"reviewStateQuery": reviewStateQuery,
		"searchQuery":      searchQuery,
		"detailQuery":      detailQuery,
		"viewerReposQuery": viewerReposQuery,
	} {
		if loc := afterBrace.FindStringIndex(q); loc != nil {
			t.Errorf("%s has a directive after a selection set: %q", name, q[max(0, loc[0]-40):loc[1]])
		}
	}
}
