package main

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// The demo's files and review threads: what REST and GraphQL would have said
// about a couple of the demo PRs, made up. A demo diff goes through the same
// code as a real one (diffFrom), from raw patches.

// demoHead is a demo PR's head commit: fixed, 40 hex, like a real one.
func demoHead(number int) string { return fmt.Sprintf("deadbeef%032x", number) }

// demoFile is a file as REST has it, and whether it's viewed to begin with.
type demoFile struct {
	restFile
	Viewed string
}

type demoPRFiles struct {
	files   []demoFile
	threads []fileThread
}

// patch builds a unified patch from hunks: each is its header's start lines
// and section name, then rows, each led by ' ', '+' or '-' (or a '\' note).
// The counts in the header are worked out from the rows.
type demoHunk struct {
	oldStart, newStart int
	section            string
	rows               []string
}

func demoPatch(hunks ...demoHunk) string {
	var out []string
	for _, h := range hunks {
		var o, n int
		for _, r := range h.rows {
			if r == "" {
				continue
			}
			switch r[0] {
			case ' ':
				o++
				n++
			case '-':
				o++
			case '+':
				n++
			}
		}
		head := fmt.Sprintf("@@ -%d,%d +%d,%d @@", h.oldStart, o, h.newStart, n)
		if h.section != "" {
			head += " " + h.section
		}
		out = append(out, head)
		out = append(out, h.rows...)
	}
	return strings.Join(out, "\n")
}

// demoRestFile is a file with a patch: changes are counted from it.
func demoRestFile(name, status, viewed, patch string) demoFile {
	rows, _ := parsePatch(patch)
	changes := 0
	for _, r := range rows {
		if r.Kind == "add" || r.Kind == "del" {
			changes++
		}
	}
	return demoFile{restFile{Filename: name, Status: status, Changes: changes, SHA: "5ca1ab1e" + fmt.Sprintf("%032x", len(name)), Patch: patch}, viewed}
}

func demoThread(id, path string, line int, resolved bool, comments ...threadComment) fileThread {
	return fileThread{ID: id, Path: path, Subject: "line", Line: line, Side: "right", OriginalLine: line, Resolved: resolved, Comments: comments}
}

func (d *demoSource) addDemoFiles(h func(float64) time.Time) {
	c := func(id, author, body string, ago float64, state string) threadComment {
		return threadComment{ID: "PRRC_demo_" + id, Author: author, Body: body, Created: h(ago).UnixMilli(), State: state, URL: "https://github.com/halcyon/notes-app/pull/482#discussion_r" + id}
	}

	engine := demoRestFile("Sources/Sync/SyncEngine.swift", "modified", "dismissed", demoPatch(
		demoHunk{138, 138, "final class SyncEngine {", []string{
			"         let remote = try await server.fetch(note.id)",
			"         guard remote.revision != note.revision else { return }",
			"-        // Last write wins.",
			"-        note.body = remote.body",
			"+        // Ask the server what both sides changed, then merge.",
			"+        let proposal = try await server.propose(note.id, base: note.baseRevision,",
			"+                                                timeout: .seconds(20))",
			"+        let merged = ThreeWay.merge(base: proposal.base, ours: note.body, theirs: proposal.theirs)",
			"+        note.body = merged.text",
			"+        note.conflicts = merged.conflicts",
			"         try store.save(note)",
			"     }",
		}},
		demoHunk{201, 207, "", []string{
			"     private func log(_ note: Note) {",
			"-        logger.info(\"synced \\(note.id)\")",
			"+        logger.info(\"synced \\(note.id), \\(note.conflicts) conflicts\")",
			"     }",
		}},
	))
	threeWay := demoRestFile("Sources/Sync/ThreeWay.swift", "added", "unviewed", demoPatch(demoHunk{0, 1, "", []string{
		"+import Foundation",
		"+",
		"+/// Three-way merge of note text, line by line.",
		"+enum ThreeWay {",
		"+    struct Result {",
		"+        var text: String",
		"+        var conflicts: Int",
		"+    }",
		"+",
		"+    static func merge(base: String, ours: String, theirs: String) -> Result {",
		"+        let b = base.lines, o = ours.lines, t = theirs.lines",
		"+        var out: [String] = []",
		"+        var conflicts = 0",
		"+        for i in 0..<max(b.count, o.count, t.count) {",
		"+            let (bl, ol, tl) = (b[safe: i], o[safe: i], t[safe: i])",
		"+            if ol == tl || tl == bl { out.append(ol ?? \"\") }",
		"+            else if ol == bl { out.append(tl ?? \"\") }",
		"+            else { out.append(contentsOf: markers(ol, tl)); conflicts += 1 }",
		"+        }",
		"+        return Result(text: out.joined(separator: \"\\n\"), conflicts: conflicts)",
		"+    }",
		"+}",
	}}))
	markers := demoRestFile("Sources/Sync/ConflictMarkers.swift", "renamed", "viewed", demoPatch(demoHunk{3, 3, "enum ConflictMarkers {", []string{
		"     static let open = \"<<<<<<< this device\"",
		"-    static let close = \">>>>>>> server\"",
		"+    static let close = \">>>>>>> other device\"",
		" }",
	}}))
	markers.PreviousFilename = "Sources/Sync/Markers.swift"
	proposal := demoRestFile("Sources/Sync/Proposal.swift", "modified", "unviewed", demoPatch(demoHunk{12, 12, "struct Proposal: Decodable {", []string{
		"     let base: String",
		"     let theirs: String",
		"+    let baseRevision: Int",
		" }",
	}}))
	legacy := demoRestFile("Sources/Sync/LegacyMerge.swift", "removed", "unviewed", demoPatch(demoHunk{1, 0, "", []string{
		"-// Superseded by ThreeWay.",
		"-func legacyMerge(_ a: String, _ b: String) -> String {",
		"-    return b",
		"-}",
	}}))
	note := demoRestFile("Sources/Models/Note.swift", "modified", "viewed", demoPatch(demoHunk{20, 20, "struct Note {", []string{
		"     var body: String",
		"+    var baseRevision: Int",
		"+    var conflicts = 0",
		"     var revision: Int",
	}}))
	tests := demoRestFile("Tests/SyncTests/ThreeWayTests.swift", "added", "unviewed", demoPatch(demoHunk{0, 1, "", []string{
		"+import XCTest",
		"+",
		"+final class ThreeWayTests: XCTestCase {",
		"+    func testBothSidesEditDifferentLines() {",
		"+        let r = ThreeWay.merge(base: \"a\\nb\", ours: \"A\\nb\", theirs: \"a\\nB\")",
		"+        XCTAssertEqual(r.text, \"A\\nB\")",
		"+        XCTAssertEqual(r.conflicts, 0)",
		"+    }",
		"+}",
		"\\ No newline at end of file",
	}}))
	png := demoFile{restFile{Filename: "Tests/SyncTests/Fixtures/conflict.png", Status: "added", SHA: "9a1b2c3d9a1b2c3d9a1b2c3d9a1b2c3d9a1b2c3d"}, "unviewed"}
	pkg := demoRestFile("Package.swift", "modified", "unviewed", demoPatch(demoHunk{9, 9, "", []string{
		"     targets: [",
		"-        .target(name: \"Sync\"),",
		"+        .target(name: \"Sync\", dependencies: [\"Models\"]),",
		"     ]",
	}}))

	hunk := demoPatch(demoHunk{29, 29, "struct Proposal: Decodable {", []string{"     let base: String", "-    let revision: Int", "+    let baseRevision: Int"}})
	outdated := demoThread("PRRT_demo_4", proposal.Filename, 0, false, c("4", "jonas", "The proposal should carry the base revision, or the client can't tell a stale one.", 6, "submitted"))
	outdated.Outdated, outdated.OriginalLine, outdated.Hunk = true, 31, hunk
	onFile := demoThread("PRRT_demo_5", png.Filename, 0, false, c("5", "priya", "Can we shrink this fixture? It's 600 KB for two lines of text.", 5, "submitted"))
	onFile.Subject, onFile.OriginalLine = "file", 0

	d.filesData["github.com/halcyon/notes-app#482"] = &demoPRFiles{
		files: []demoFile{pkg, note, markers, legacy, proposal, engine, threeWay, png, tests},
		threads: []fileThread{
			demoThread("PRRT_demo_1", engine.Filename, 142, false,
				c("1", "jonas", "Should this timeout be shorter than the request's own? Otherwise we never see it fire.", 20, "submitted"),
				c("2", "sam", "Good catch: it's 20s vs 30s now.", 4, "submitted")),
			demoThread("PRRT_demo_2", threeWay.Filename, 12, true,
				c("3", "priya", "Nit: `merged` reads better than `out`.", 8, "submitted"),
				c("6", "sam", "Done.", 7, "submitted")),
			demoThread("PRRT_demo_3", threeWay.Filename, 18, false,
				c("7", "sam", "Maybe worth a property test for this branch?", 0.2, "pending")),
			outdated,
			onFile,
		},
	}

	typo := demoRestFile("Sources/Onboarding/Welcome.swift", "modified", "unviewed", demoPatch(demoHunk{14, 14, "struct Welcome: View {", []string{
		"     var body: some View {",
		"-        Text(\"Recieve your notes anywhere\")",
		"+        Text(\"Receive your notes anywhere\")",
		"     }",
	}}))
	d.filesData["github.com/halcyon/notes-app#480"] = &demoPRFiles{files: []demoFile{typo}}

	for key, data := range d.filesData {
		d.viewed[key] = map[string]string{}
		for _, f := range data.files {
			d.viewed[key][f.Filename] = f.Viewed
		}
	}
}

func (d *demoSource) findRef(r repoRef, number int) *prDetail {
	for _, p := range d.prs {
		if strings.ToLower(p.key()) == openedKey(r, number) {
			return p
		}
	}
	return nil
}

var demoStatuses = map[string]string{"added": "added", "removed": "deleted", "modified": "modified", "renamed": "renamed", "copied": "copied", "changed": "changed"}

func (d *demoSource) files(_ context.Context, r repoRef, number int) (filesAnswer, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p := d.findRef(r, number)
	if p == nil {
		return filesAnswer{}, fmt.Errorf("%s#%d isn't there", r, number)
	}
	out := filesAnswer{Head: p.HeadRefOid, Files: []fileEntry{}, Threads: []fileThread{}}
	data := d.filesData[p.key()]
	if data == nil {
		return out, nil
	}
	for _, f := range data.files {
		e := fileEntry{Path: f.Filename, From: f.PreviousFilename, Status: demoStatuses[f.Status], Viewed: d.viewed[p.key()][f.Filename]}
		rows, _ := parsePatch(f.Patch)
		for _, row := range rows {
			switch row.Kind {
			case "add":
				e.Additions++
			case "del":
				e.Deletions++
			}
		}
		out.Files = append(out.Files, e)
	}
	for _, t := range data.threads {
		t.Comments = append([]threadComment{}, t.Comments...)
		out.Threads = append(out.Threads, t)
	}
	orderThreads(out.Files, out.Threads)
	tallyThreads(out.Files, out.Threads)
	return out, nil
}

func (d *demoSource) diff(_ context.Context, r repoRef, number int, head, path string) (diffAnswer, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	p := d.findRef(r, number)
	if p == nil {
		return diffAnswer{}, fmt.Errorf("%s#%d isn't there", r, number)
	}
	if head != p.HeadRefOid {
		return diffAnswer{Head: p.HeadRefOid, Path: path, State: diffStale, Rows: []diffRow{}}, nil
	}
	var files []restFile
	if data := d.filesData[p.key()]; data != nil {
		for _, f := range data.files {
			files = append(files, f.restFile)
		}
	}
	return diffFrom(files, head, path)
}

func (d *demoSource) setViewed(_ context.Context, r repoRef, number int, head, path string, viewed bool) error {
	d.mu.Lock()
	defer d.mu.Unlock()
	p := d.findRef(r, number)
	if p == nil {
		return fmt.Errorf("%s#%d isn't there", r, number)
	}
	if head != p.HeadRefOid {
		return &staleError{Head: p.HeadRefOid}
	}
	if _, ok := d.viewed[p.key()][path]; !ok {
		return fmt.Errorf("%q isn't one of this pull request's changed files", path)
	}
	state := "unviewed"
	if viewed {
		state = "viewed"
	}
	d.viewed[p.key()][path] = state
	return nil
}
