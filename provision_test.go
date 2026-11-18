package main

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// provisionScript is the shell script the app mod runs on a machine to fetch
// its herdr-github, read out of main.js so the test runs what ships.
func provisionScript(t *testing.T) string {
	t.Helper()
	js, err := os.ReadFile("app/mods/github/main.js")
	if err != nil {
		t.Fatal(err)
	}
	_, rest, ok := strings.Cut(string(js), "const PROVISION = String.raw`")
	if !ok {
		t.Fatal("main.js has no PROVISION script")
	}
	script, _, ok := strings.Cut(rest, "`;")
	if !ok {
		t.Fatal("main.js's PROVISION script never ends")
	}
	return script
}

// fakeRelease is a machine with a stand-in curl that serves a release from a
// directory instead of the network, logging each URL it was asked for.
type fakeRelease struct {
	home     string
	release  string
	archive  string
	requests string
	env      []string
}

func newFakeRelease(t *testing.T) fakeRelease {
	t.Helper()
	var arch string
	switch runtime.GOARCH {
	case "arm64", "amd64":
		arch = runtime.GOARCH
	default:
		t.Skipf("no release for %s", runtime.GOARCH)
	}
	if runtime.GOOS != "darwin" && runtime.GOOS != "linux" {
		t.Skipf("no release for %s", runtime.GOOS)
	}
	dir := t.TempDir()
	f := fakeRelease{
		home:     filepath.Join(dir, "home"),
		release:  filepath.Join(dir, "release"),
		archive:  fmt.Sprintf("herdr-github_%s_%s_%s.tar.gz", appVersion, runtime.GOOS, arch),
		requests: filepath.Join(dir, "requests"),
	}
	stub := filepath.Join(dir, "stub")
	for _, d := range []string{f.home, f.release, stub} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	curl := fmt.Sprintf(`#!/bin/sh
url=""; out=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift ;; https://*) url="$1" ;; esac; shift; done
echo "$url" >> %q
cp %q/"$(basename "$url")" "$out"
`, f.requests, f.release)
	if err := os.WriteFile(filepath.Join(stub, "curl"), []byte(curl), 0o755); err != nil {
		t.Fatal(err)
	}
	f.env = append(os.Environ(), "HOME="+f.home, "PATH="+stub+string(os.PathListSeparator)+os.Getenv("PATH"))
	return f
}

// publish puts the release's archive and its checksums.txt in place; the
// checksum is of the archive as built, or of `claimed` when it's given.
func (f fakeRelease) publish(t *testing.T, binary string, claimed []byte) {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: "herdr-github", Mode: 0o755, Size: int64(len(binary))}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write([]byte(binary)); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	if claimed == nil {
		claimed = buf.Bytes()
	}
	sums := fmt.Sprintf("%x  %s\n", sha256.Sum256(claimed), f.archive)
	if err := os.WriteFile(filepath.Join(f.release, f.archive), buf.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.release, "checksums.txt"), []byte(sums), 0o644); err != nil {
		t.Fatal(err)
	}
}

func (f fakeRelease) run(t *testing.T) (string, error) {
	t.Helper()
	cmd := exec.Command("sh", "-c", provisionScript(t), "sh", appVersion)
	cmd.Env = f.env
	out, err := cmd.Output()
	return string(out), err
}

func (f fakeRelease) asked(t *testing.T) []string {
	t.Helper()
	b, err := os.ReadFile(f.requests)
	if err != nil {
		t.Fatal(err)
	}
	return strings.Fields(string(b))
}

// A machine gets the fork's build: downloaded from the fork's releases, into a
// folder of its own, and never mistaken for an upstream build of the same
// version already on disk.
func TestProvisionInstallsTheForksRelease(t *testing.T) {
	f := newFakeRelease(t)
	f.publish(t, "#!/bin/sh\necho the fork\n", nil)

	upstream := filepath.Join(f.home, ".local/share/herdr-github/app", appVersion)
	if err := os.MkdirAll(upstream, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(upstream, "herdr-github"), []byte("#!/bin/sh\necho upstream\n"), 0o755); err != nil {
		t.Fatal(err)
	}

	got, err := f.run(t)
	if err != nil {
		t.Fatalf("provisioning a good release failed: %v", err)
	}
	want := filepath.Join(f.home, ".local/share/herdr-github/app", "joshvera-"+appVersion, "herdr-github")
	if got != want {
		t.Fatalf("binary at %q, want %q (an upstream build of the same version must not stand in for it)", got, want)
	}
	out, err := exec.Command(got).Output()
	if err != nil || strings.TrimSpace(string(out)) != "the fork" {
		t.Fatalf("installed binary says %q (%v), want the fork's", out, err)
	}

	base := "https://github.com/joshvera/herdr-github/releases/download/v" + appVersion + "/"
	for _, url := range f.asked(t) {
		if !strings.HasPrefix(url, base) {
			t.Errorf("downloaded %s, want it under %s", url, base)
		}
	}
	if len(f.asked(t)) != 2 {
		t.Errorf("asked for %v, want the archive and checksums.txt", f.asked(t))
	}
}

// An archive that doesn't match the release's checksums is never installed.
func TestProvisionRefusesAnArchiveThatMissesItsChecksum(t *testing.T) {
	f := newFakeRelease(t)
	f.publish(t, "#!/bin/sh\necho tampered\n", []byte("what the release says it shipped"))

	if got, err := f.run(t); err == nil {
		t.Fatalf("provisioned a tampered release: %q", got)
	}
	installed := filepath.Join(f.home, ".local/share/herdr-github/app", "joshvera-"+appVersion)
	if _, err := os.Stat(installed); !os.IsNotExist(err) {
		t.Fatalf("a tampered binary was left in %s (%v)", installed, err)
	}
}
