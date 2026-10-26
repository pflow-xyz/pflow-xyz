package userfiles

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

var (
	alice = Owner{Provider: "github", Subject: "1001"}
	bob   = Owner{Provider: "github", Subject: "1002"}
)

const net = `{"@context":"https://pflow.xyz/schema","places":{},"transitions":{},"arcs":[]}`

func TestCheckName(t *testing.T) {
	good := map[string]string{
		"sir.json": "net", "SIR-v2.jsonld": "net", "a.svg": "svg", "plot.png": "png", "r_1.csv": "csv",
		"labels.jsonl": "jsonl", "notes.txt": "text", "x.JSON": "net", "0.json": "net",
		strings.Repeat("a", MaxName-5) + ".json": "net",
	}
	for name, kind := range good {
		k, err := CheckName(name)
		if err != nil || k.Name != kind {
			t.Errorf("CheckName(%q) = %v, %v; want kind %s", name, k, err, kind)
		}
	}
	bad := []string{
		"", ".json", ".hidden.json", "../x.json", "..", "a/b.json", `a\b.json`, "/etc/passwd.txt",
		"a..json", "x.json.", "noext", "a.exe", "a.json/", "a%2fb.json", "%2e%2e.json", "a\x00.json",
		"a b.json", "café.json", "a∕b.json", "a／b.json", "a․json", "-x.json", "_x.json",
		strings.Repeat("a", MaxName-4) + ".json", "json", "a.json\n",
	}
	for _, name := range bad {
		if _, err := CheckName(name); !errors.Is(err, ErrBadName) {
			t.Errorf("CheckName(%q) = %v, want ErrBadName", name, err)
		}
	}
}

func TestOwnerDirIsInjectiveAndSafe(t *testing.T) {
	owners := []Owner{
		{"github", "12"}, {"github", "1"}, {"google", "12"}, {"github", "123"},
		{"git", "hub:12"}, {"github", "12:"}, {"google", "g-1/../x"},
	}
	seen := map[string]Owner{}
	for _, o := range owners {
		if err := o.Validate(); err != nil {
			t.Fatalf("%v: %v", o, err)
		}
		d := o.Dir()
		if strings.Trim(d, "0123456789abcdef") != "" || len(d) > 255 {
			t.Errorf("%v: dir %q is not short lower-case hex", o, d)
		}
		if prev, dup := seen[d]; dup {
			t.Errorf("%v and %v share dir %s", o, prev, d)
		}
		seen[d] = o
	}
	if (Owner{"github", "12"}).Dir() != "6769746875623a3132" {
		t.Errorf("dir is hex of the key: got %s", (Owner{"github", "12"}).Dir())
	}
	for _, o := range []Owner{{"", "1"}, {"GitHub", "1"}, {"a:b", "1"}, {"github", ""}, {"github", "a b"}, {"github", strings.Repeat("9", maxSubject+1)}, {"github", "é"}} {
		if err := o.Validate(); !errors.Is(err, ErrBadOwner) {
			t.Errorf("Validate(%q) = %v, want ErrBadOwner", o, err)
		}
	}
}

func TestWriteReadListDelete(t *testing.T) {
	root := t.TempDir()
	s := New(root, DefaultLimits)
	if files, u, err := s.List(alice); err != nil || len(files) != 0 || u.Files != 0 {
		t.Fatalf("empty list = %v %v %v", files, u, err)
	}
	if _, _, err := s.Read(alice, "sir.json"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("read before any write = %v", err)
	}
	info, created, u, err := s.Write(alice, "sir.json", []byte(net), false)
	if err != nil || !created || info.Size != int64(len(net)) || info.Kind != "net" || u.Files != 1 || u.Bytes != int64(len(net)) {
		t.Fatalf("write = %+v %v %+v %v", info, created, u, err)
	}
	if _, _, _, err := s.Write(alice, "sir.json", []byte(net), false); !errors.Is(err, ErrExists) {
		t.Fatalf("second write without overwrite = %v", err)
	}
	if _, created, u, err := s.Write(alice, "sir.json", []byte(`{"a":1}`), true); err != nil || created || u.Files != 1 || u.Bytes != 7 {
		t.Fatalf("overwrite = %v %+v %v", created, u, err)
	}
	data, _, err := s.Read(alice, "sir.json")
	if err != nil || string(data) != `{"a":1}` {
		t.Fatalf("read = %q %v", data, err)
	}
	// Bob shares nothing with Alice.
	if files, _, _ := s.List(bob); len(files) != 0 {
		t.Fatalf("bob sees %v", files)
	}
	if _, _, err := s.Read(bob, "sir.json"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bob reads alice's file: %v", err)
	}
	if _, err := s.Delete(bob, "sir.json"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("bob deletes alice's file: %v", err)
	}
	if u, err := s.Delete(alice, "sir.json"); err != nil || u.Files != 0 {
		t.Fatalf("delete = %+v %v", u, err)
	}
	if _, err := s.Delete(alice, "sir.json"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete = %v", err)
	}
	// On disk: <root>/<hex of github:1001>/, mode 0700, and nothing else.
	entries, _ := os.ReadDir(root)
	if len(entries) != 1 || entries[0].Name() != alice.Dir() {
		t.Fatalf("root holds %v, want only %s", entries, alice.Dir())
	}
	if fi, _ := os.Stat(filepath.Join(root, alice.Dir())); fi.Mode().Perm() != 0o700 {
		t.Errorf("owner dir mode %v, want 0700", fi.Mode().Perm())
	}
}

func TestContentChecks(t *testing.T) {
	s := New(t.TempDir(), DefaultLimits)
	png := "\x89PNG\r\n\x1a\nrest"
	cases := []struct {
		name, data string
		ok         bool
	}{
		{"a.json", net, true}, {"a.json", "{not json", false}, {"a.jsonld", "", false},
		{"a.png", png, true}, {"a.png", "GIF89a", false},
		{"a.svg", `<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>`, true}, {"a.svg", "<html></html>", false},
		{"a.csv", "a,b\n1,2\n", true}, {"a.csv", "a,\xff\n", false},
		{"a.jsonl", "{\"mk\":[1]}\n\n{\"mk\":[2]}\n", true}, {"a.jsonl", "{\"mk\":[1]}\nnope\n", false},
		{"a.txt", "", true}, {"a.txt", "\xc3\x28", false},
	}
	for _, c := range cases {
		_, _, _, err := s.Write(alice, c.name, []byte(c.data), true)
		var ce *ContentError
		if c.ok && err != nil {
			t.Errorf("%s %q: %v", c.name, c.data, err)
		}
		if !c.ok && !errors.As(err, &ce) {
			t.Errorf("%s %q: got %v, want a ContentError", c.name, c.data, err)
		}
	}
}

func TestLimits(t *testing.T) {
	s := New(t.TempDir(), Limits{MaxFileBytes: 20, MaxFiles: 2, MaxTotalBytes: 30})
	write := func(name, data string, overwrite bool) error {
		_, _, _, err := s.Write(alice, name, []byte(data), overwrite)
		return err
	}
	if err := write("big.txt", strings.Repeat("x", 21), false); !errors.Is(err, ErrTooLarge) {
		t.Fatalf("21 bytes over a 20-byte limit: %v", err)
	}
	if err := write("a.txt", strings.Repeat("x", 20), false); err != nil {
		t.Fatal(err)
	}
	var le *LimitError
	if err := write("b.txt", strings.Repeat("x", 11), false); !errors.As(err, &le) || le.What != "bytes" || le.Used != 20 {
		t.Fatalf("31 of 30 bytes: %v", err)
	}
	if err := write("b.txt", strings.Repeat("x", 10), false); err != nil {
		t.Fatal(err)
	}
	if err := write("c.txt", "x", false); !errors.As(err, &le) || le.What != "files" || le.Used != 2 {
		t.Fatalf("a third file: %v", err)
	}
	// At the count limit, replacing a file is still fine, and shrinking frees bytes.
	if err := write("a.txt", "x", true); err != nil {
		t.Fatalf("overwrite at the file limit: %v", err)
	}
	if err := write("b.txt", strings.Repeat("x", 20), true); err != nil {
		t.Fatalf("overwrite within the byte limit: %v", err)
	}
	if _, u, _ := s.List(alice); u.Files != 2 || u.Bytes != 21 {
		t.Fatalf("usage %+v", u)
	}
	// The limits are per owner.
	if _, _, _, err := s.Write(bob, "c.txt", []byte("x"), false); err != nil {
		t.Fatalf("bob is not limited by alice's files: %v", err)
	}
}

func TestConcurrentWritesRespectTheLimit(t *testing.T) {
	root := t.TempDir()
	s := New(root, Limits{MaxFileBytes: 100, MaxFiles: 5, MaxTotalBytes: 1000})
	var wg sync.WaitGroup
	var mu sync.Mutex
	ok := 0
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			if _, _, _, err := s.Write(alice, fmt.Sprintf("f%d.txt", i), []byte("hello"), false); err == nil {
				mu.Lock()
				ok++
				mu.Unlock()
			}
		}(i)
	}
	wg.Wait()
	files, u, _ := s.List(alice)
	if ok != 5 || len(files) != 5 || u.Files != 5 {
		t.Fatalf("%d writes succeeded, %d files listed; want 5", ok, len(files))
	}
	entries, _ := os.ReadDir(filepath.Join(root, alice.Dir()))
	if len(entries) != 5 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
	if len(s.locks) != 0 {
		t.Fatalf("owner locks leaked: %d", len(s.locks))
	}
}

func TestSymlinksAreNotFollowedOrCounted(t *testing.T) {
	root := t.TempDir()
	outside := filepath.Join(t.TempDir(), "secret.txt")
	os.WriteFile(outside, []byte("secret"), 0o600)
	s := New(root, DefaultLimits)
	if _, _, _, err := s.Write(alice, "real.txt", []byte("mine"), false); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Join(root, alice.Dir())
	if err := os.Symlink(outside, filepath.Join(dir, "evil.txt")); err != nil {
		t.Skip("no symlinks here:", err)
	}
	if files, _, _ := s.List(alice); len(files) != 1 || files[0].Name != "real.txt" {
		t.Fatalf("list = %v, want only real.txt", files)
	}
	if _, _, err := s.Read(alice, "evil.txt"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("read through a symlink: %v", err)
	}
	if _, _, _, err := s.Write(alice, "evil.txt", []byte("x"), true); err == nil {
		t.Fatal("overwrote a symlink")
	}
	if _, err := s.Delete(alice, "evil.txt"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("delete a symlink: %v", err)
	}
	if b, _ := os.ReadFile(outside); string(b) != "secret" {
		t.Fatalf("the file outside changed: %q", b)
	}
}

func TestLimitsFromEnv(t *testing.T) {
	env := map[string]string{"PFLOW_FILES_MAX_FILE_BYTES": "2048", "PFLOW_FILES_MAX_FILES": "nope", "PFLOW_FILES_MAX_TOTAL_BYTES": "-1"}
	l := LimitsFromEnv(func(k string) string { return env[k] })
	if l.MaxFileBytes != 2048 || l.MaxFiles != DefaultLimits.MaxFiles || l.MaxTotalBytes != DefaultLimits.MaxTotalBytes {
		t.Fatalf("limits = %+v", l)
	}
}

func TestStoreWideLimit(t *testing.T) {
	root := t.TempDir()
	lim := Limits{MaxFileBytes: 100, MaxFiles: 10, MaxTotalBytes: 100, MaxRootBytes: 50}
	s := New(root, lim)
	if _, _, _, err := s.Write(alice, "a.txt", []byte(strings.Repeat("x", 30)), false); err != nil {
		t.Fatal(err)
	}
	// bob is well inside his own limits, but every account together is not.
	var le *LimitError
	if _, _, _, err := s.Write(bob, "b.txt", []byte(strings.Repeat("x", 21)), false); !errors.As(err, &le) || le.What != "server" || le.Used != 30 {
		t.Fatalf("51 of 50 bytes across accounts: %v", err)
	}
	if _, _, _, err := s.Write(bob, "b.txt", []byte(strings.Repeat("x", 20)), false); err != nil {
		t.Fatalf("exactly at the store-wide limit: %v", err)
	}
	// Deleting and shrinking give bytes back.
	if _, err := s.Delete(alice, "a.txt"); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := s.Write(alice, "a.txt", []byte(strings.Repeat("x", 30)), false); err != nil {
		t.Fatalf("after a delete: %v", err)
	}
	if _, _, _, err := s.Write(bob, "b.txt", []byte("x"), true); err != nil {
		t.Fatal(err)
	}
	if _, _, _, err := s.Write(alice, "c.txt", []byte(strings.Repeat("x", 19)), false); err != nil {
		t.Fatalf("after shrinking b.txt: %v", err)
	}

	// A new Store over the same directory counts what is already there.
	s2 := New(root, lim)
	if _, _, _, err := s2.Write(bob, "d.txt", []byte("x"), false); !errors.As(err, &le) || le.What != "server" || le.Used != 50 {
		t.Fatalf("a restarted store must count the files on disk: %v", err)
	}
}

func TestStoreWideLimitUnderConcurrency(t *testing.T) {
	root := t.TempDir()
	s := New(root, Limits{MaxFileBytes: 100, MaxFiles: 10, MaxTotalBytes: 100, MaxRootBytes: 50})
	var wg sync.WaitGroup
	for i := 0; i < 40; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			o := Owner{Provider: "github", Subject: fmt.Sprint(2000 + i)}
			s.Write(o, "f.txt", []byte("0123456789"), false)
		}(i)
	}
	wg.Wait()
	used, err := s.diskUsage()
	if err != nil || used != 50 {
		t.Fatalf("on disk %d bytes (%v); want exactly the 50-byte limit", used, err)
	}
	if s.rootUsed != used {
		t.Fatalf("running total %d, disk %d", s.rootUsed, used)
	}
}

func TestStoreWideLimitFromEnv(t *testing.T) {
	if DefaultLimits.MaxRootBytes <= 0 {
		t.Fatal("the default must cap the store")
	}
	l := LimitsFromEnv(func(k string) string {
		return map[string]string{"PFLOW_FILES_MAX_ROOT_BYTES": "4096"}[k]
	})
	if l.MaxRootBytes != 4096 {
		t.Fatalf("limits = %+v", l)
	}
	if l := LimitsFromEnv(func(k string) string { return map[string]string{"PFLOW_FILES_MAX_ROOT_BYTES": "0"}[k] }); l.MaxRootBytes != DefaultLimits.MaxRootBytes {
		t.Fatalf("0 from the environment must not lift the cap: %+v", l)
	}
}
