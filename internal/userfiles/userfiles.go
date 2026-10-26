// Package userfiles is each signed-in account's own file space on the server:
// what pflow-native writes to the user's disk (file.save, export.* with a
// path), the web editor saves here instead, over HTTPS
// (cmd/webserver/files.go, docs/account-files.md).
//
// Files live under <root>/<owner-dir>/<name>. The owner directory is the hex
// encoding of the provider-qualified account id ("github:12345"), so it is
// injective, needs no escaping and never contains a separator; names come
// from a strict ASCII allowlist with a fixed set of extensions. Every file
// operation goes through an os.Root opened on the owner's directory, so even a
// name that slipped past the allowlist could not reach outside it.
//
// Writes are atomic (a temporary file renamed into place) and serialised per
// owner, so the limits (file size, file count, total bytes) hold under
// concurrent requests.
package userfiles

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// Owner is who a file space belongs to: the sign-in provider and that
// provider's stable subject id (GitHub's numeric user id, not the login, which
// can change; Google's "sub"). Owners from different providers never share a
// space, and adding a provider needs no migration.
type Owner struct {
	Provider string
	Subject  string
}

var providerRE = regexp.MustCompile(`^[a-z][a-z0-9]{1,15}$`)

// maxSubject keeps the owner directory name (two hex digits per byte of
// "provider:subject") under the 255-byte file name limit: 16 + 1 + 100 bytes
// is 234 hex digits.
const maxSubject = 100

// Key is the provider-qualified id, "github:12345". Provider names have no
// ':', so the key identifies the owner unambiguously.
func (o Owner) Key() string { return o.Provider + ":" + o.Subject }

// Validate refuses an owner whose key could not name a directory safely.
func (o Owner) Validate() error {
	if !providerRE.MatchString(o.Provider) {
		return fmt.Errorf("%w: provider %q", ErrBadOwner, o.Provider)
	}
	if o.Subject == "" || len(o.Subject) > maxSubject {
		return fmt.Errorf("%w: subject length %d", ErrBadOwner, len(o.Subject))
	}
	for i := 0; i < len(o.Subject); i++ {
		if c := o.Subject[i]; c <= ' ' || c > '~' {
			return fmt.Errorf("%w: subject has a byte outside printable ASCII", ErrBadOwner)
		}
	}
	return nil
}

// Dir is the owner's directory name under the root: hex of Key(). Never the
// raw key (it holds a ':' and, for a future provider, anything printable).
func (o Owner) Dir() string { return hex.EncodeToString([]byte(o.Key())) }

// Kind is what a file holds, from its extension. Each kind has a content check.
type Kind struct {
	Name string // net, svg, png, csv, jsonl, text
	MIME string
}

// Kinds by extension: the kinds pflow-native writes (docs/account-files.md).
var Kinds = map[string]Kind{
	".json":   {"net", "application/json"},
	".jsonld": {"net", "application/ld+json"},
	".svg":    {"svg", "image/svg+xml"},
	".png":    {"png", "image/png"},
	".csv":    {"csv", "text/csv; charset=utf-8"},
	".jsonl":  {"jsonl", "application/jsonl; charset=utf-8"},
	".txt":    {"text", "text/plain; charset=utf-8"},
}

// Extensions lists Kinds' keys, sorted (for error messages).
func Extensions() []string {
	out := make([]string, 0, len(Kinds))
	for e := range Kinds {
		out = append(out, e)
	}
	sort.Strings(out)
	return out
}

// MaxName is the longest file name accepted, in bytes (names are ASCII).
const MaxName = 100

// A name is ASCII letters, digits, '.', '_' and '-', starting with a letter
// or digit. No separators, no leading dot, no percent escapes, nothing
// outside ASCII (so no look-alike slashes), and it is used exactly as given:
// nothing is decoded.
var nameRE = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

// CheckName returns the kind of a valid name, or ErrBadName saying why not.
func CheckName(name string) (Kind, error) {
	switch {
	case name == "":
		return Kind{}, fmt.Errorf("%w: empty", ErrBadName)
	case len(name) > MaxName:
		return Kind{}, fmt.Errorf("%w: over %d characters", ErrBadName, MaxName)
	case !nameRE.MatchString(name):
		return Kind{}, fmt.Errorf("%w: use letters, digits, '.', '_' and '-', starting with a letter or digit", ErrBadName)
	case strings.Contains(name, ".."):
		return Kind{}, fmt.Errorf("%w: \"..\" is not allowed", ErrBadName)
	}
	ext := strings.ToLower(path.Ext(name))
	k, ok := Kinds[ext]
	if !ok || ext == name {
		return Kind{}, fmt.Errorf("%w: the extension must be one of %s", ErrBadName, strings.Join(Extensions(), " "))
	}
	return k, nil
}

var pngMagic = []byte("\x89PNG\r\n\x1a\n")

// CheckContent is the cheap check each kind gets: a net is JSON, a PNG has
// the PNG signature, the text kinds are UTF-8 (JSONL line by line JSON), and
// an SVG is UTF-8 with an <svg element.
func CheckContent(k Kind, data []byte) error {
	bad := func(format string, a ...any) error {
		return &ContentError{Msg: fmt.Sprintf(format, a...)}
	}
	switch k.Name {
	case "net":
		if !json.Valid(data) {
			return bad("a .json or .jsonld file must be JSON")
		}
	case "png":
		if !bytes.HasPrefix(data, pngMagic) {
			return bad("a .png file must be a PNG image")
		}
	case "svg":
		if !utf8.Valid(data) || !bytes.Contains(bytes.ToLower(data), []byte("<svg")) {
			return bad("a .svg file must be UTF-8 SVG markup")
		}
	case "jsonl":
		if !utf8.Valid(data) {
			return bad("a .jsonl file must be UTF-8")
		}
		for i, line := range bytes.Split(data, []byte("\n")) {
			if len(bytes.TrimSpace(line)) > 0 && !json.Valid(line) {
				return bad("a .jsonl file holds one JSON value per line; line %d is not JSON", i+1)
			}
		}
	default:
		if !utf8.Valid(data) {
			return bad("a %s file must be UTF-8 text", k.Name)
		}
	}
	return nil
}

// Limits are per owner.
type Limits struct {
	MaxFileBytes  int64 // one file
	MaxFiles      int   // files in the space
	MaxTotalBytes int64 // all files together
}

// DefaultLimits: 1 MiB a file (what /api/save and nginx's default body limit
// allow), 200 files, 20 MiB in all.
var DefaultLimits = Limits{MaxFileBytes: 1 << 20, MaxFiles: 200, MaxTotalBytes: 20 << 20}

// LimitsFromEnv reads PFLOW_FILES_MAX_FILE_BYTES, PFLOW_FILES_MAX_FILES and
// PFLOW_FILES_MAX_TOTAL_BYTES. A malformed value logs and keeps the default.
func LimitsFromEnv(getenv func(string) string) Limits {
	l := DefaultLimits
	read := func(name string, dst *int64) {
		v := getenv(name)
		if v == "" {
			return
		}
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n <= 0 {
			log.Printf("userfiles: ignoring %s=%q (not a positive integer); using %d", name, v, *dst)
			return
		}
		*dst = n
	}
	files := int64(l.MaxFiles)
	read("PFLOW_FILES_MAX_FILE_BYTES", &l.MaxFileBytes)
	read("PFLOW_FILES_MAX_FILES", &files)
	read("PFLOW_FILES_MAX_TOTAL_BYTES", &l.MaxTotalBytes)
	l.MaxFiles = int(files)
	return l
}

var (
	ErrBadOwner = errors.New("invalid owner")
	ErrBadName  = errors.New("invalid file name")
	ErrNotFound = errors.New("no such file")
	ErrExists   = errors.New("a file of that name exists")
	ErrTooLarge = errors.New("file too large")
)

// ContentError is content that does not match its extension.
type ContentError struct{ Msg string }

func (e *ContentError) Error() string { return e.Msg }

// LimitError is a write refused by the file-count or total-bytes limit.
type LimitError struct {
	What  string // "files" or "bytes"
	Limit int64
	Used  int64 // before this write
}

func (e *LimitError) Error() string {
	if e.What == "files" {
		return fmt.Sprintf("your account holds %d files, the most it can (delete one to save another)", e.Used)
	}
	return fmt.Sprintf("this would take your account past %d bytes (%d used)", e.Limit, e.Used)
}

// Info describes one file.
type Info struct {
	Name     string    `json:"name"`
	Size     int64     `json:"size"`
	Modified time.Time `json:"modified"`
	Kind     string    `json:"kind"`
}

// Usage is what an owner's space holds.
type Usage struct {
	Files int   `json:"files"`
	Bytes int64 `json:"bytes"`
}

// Store is the file spaces under one root directory.
type Store struct {
	root   string
	limits Limits

	mu    sync.Mutex
	locks map[string]*ownerLock
}

type ownerLock struct {
	sync.Mutex
	refs int
}

// New returns a store rooted at root (created on the first write).
func New(root string, limits Limits) *Store {
	return &Store{root: root, limits: limits, locks: map[string]*ownerLock{}}
}

// Limits returns the store's limits.
func (s *Store) Limits() Limits { return s.limits }

// lock serialises one owner's writes; the entry is dropped when unused, so
// the map holds only owners with a write in flight.
func (s *Store) lock(o Owner) func() {
	k := o.Key()
	s.mu.Lock()
	l := s.locks[k]
	if l == nil {
		l = &ownerLock{}
		s.locks[k] = l
	}
	l.refs++
	s.mu.Unlock()
	l.Lock()
	return func() {
		l.Unlock()
		s.mu.Lock()
		if l.refs--; l.refs == 0 {
			delete(s.locks, k)
		}
		s.mu.Unlock()
	}
}

// open returns a Root on the owner's directory, creating it (0700) when
// create is set. Without create, a missing directory is (nil, nil).
func (s *Store) open(o Owner, create bool) (*os.Root, error) {
	if err := o.Validate(); err != nil {
		return nil, err
	}
	if create {
		if err := os.MkdirAll(s.root, 0o700); err != nil {
			return nil, err
		}
	}
	top, err := os.OpenRoot(s.root)
	if errors.Is(err, fs.ErrNotExist) && !create {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	defer top.Close()
	if create {
		if err := top.Mkdir(o.Dir(), 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
			return nil, err
		}
	}
	r, err := top.OpenRoot(o.Dir())
	if errors.Is(err, fs.ErrNotExist) && !create {
		return nil, nil
	}
	return r, err
}

// staleTemp is how old a leftover temporary file (a write cut off by a crash)
// must be before a scan removes it.
const staleTemp = time.Hour

// scan lists the owner's files: regular files with valid names, sorted.
// Anything else (a temporary file, a symlink) is skipped and never counted.
func scan(r *os.Root, cleanTemps bool) ([]Info, Usage, error) {
	dir, err := r.Open(".")
	if err != nil {
		return nil, Usage{}, err
	}
	entries, err := dir.ReadDir(-1)
	dir.Close()
	if err != nil {
		return nil, Usage{}, err
	}
	var out []Info
	var u Usage
	for _, e := range entries {
		name := e.Name()
		if cleanTemps && strings.HasPrefix(name, ".tmp-") {
			if fi, err := e.Info(); err == nil && time.Since(fi.ModTime()) > staleTemp {
				r.Remove(name)
			}
			continue
		}
		k, err := CheckName(name)
		if err != nil || !e.Type().IsRegular() {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, Info{Name: name, Size: fi.Size(), Modified: fi.ModTime().UTC(), Kind: k.Name})
		u.Files++
		u.Bytes += fi.Size()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, u, nil
}

// List returns the owner's files, sorted by name, and their usage. An owner
// who never saved has none.
func (s *Store) List(o Owner) ([]Info, Usage, error) {
	r, err := s.open(o, false)
	if err != nil || r == nil {
		return []Info{}, Usage{}, err
	}
	defer r.Close()
	files, u, err := scan(r, false)
	if files == nil {
		files = []Info{}
	}
	return files, u, err
}

// Read returns one file's bytes. ErrNotFound when the owner has no such file.
func (s *Store) Read(o Owner, name string) ([]byte, Info, error) {
	k, err := CheckName(name)
	if err != nil {
		return nil, Info{}, err
	}
	r, err := s.open(o, false)
	if err != nil {
		return nil, Info{}, err
	}
	if r == nil {
		return nil, Info{}, ErrNotFound
	}
	defer r.Close()
	fi, err := r.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) || (err == nil && !fi.Mode().IsRegular()) {
		return nil, Info{}, ErrNotFound
	}
	if err != nil {
		return nil, Info{}, err
	}
	data, err := r.ReadFile(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, Info{}, ErrNotFound
	}
	if err != nil {
		return nil, Info{}, err
	}
	return data, Info{Name: name, Size: int64(len(data)), Modified: fi.ModTime().UTC(), Kind: k.Name}, nil
}

// Write stores data as name. A name that exists is refused with ErrExists
// unless overwrite is set. created reports whether the file is new.
func (s *Store) Write(o Owner, name string, data []byte, overwrite bool) (info Info, created bool, u Usage, err error) {
	k, err := CheckName(name)
	if err != nil {
		return Info{}, false, Usage{}, err
	}
	if int64(len(data)) > s.limits.MaxFileBytes {
		return Info{}, false, Usage{}, ErrTooLarge
	}
	if err := CheckContent(k, data); err != nil {
		return Info{}, false, Usage{}, err
	}
	if err := o.Validate(); err != nil {
		return Info{}, false, Usage{}, err
	}
	unlock := s.lock(o)
	defer unlock()
	r, err := s.open(o, true)
	if err != nil {
		return Info{}, false, Usage{}, err
	}
	defer r.Close()
	files, u, err := scan(r, true)
	if err != nil {
		return Info{}, false, Usage{}, err
	}
	var old *Info
	for i := range files {
		if files[i].Name == name {
			old = &files[i]
		}
	}
	if old == nil {
		// Something scan skipped (a symlink, a directory) is not a file of
		// ours to replace.
		if _, err := r.Lstat(name); err == nil {
			return Info{}, false, u, fmt.Errorf("%s exists and is not a regular file", name)
		} else if !errors.Is(err, fs.ErrNotExist) {
			return Info{}, false, u, err
		}
	}
	switch {
	case old != nil && !overwrite:
		return Info{}, false, u, ErrExists
	case old == nil && u.Files >= s.limits.MaxFiles:
		return Info{}, false, u, &LimitError{What: "files", Limit: int64(s.limits.MaxFiles), Used: int64(u.Files)}
	}
	total := u.Bytes + int64(len(data))
	if old != nil {
		total -= old.Size
	}
	if total > s.limits.MaxTotalBytes {
		return Info{}, false, u, &LimitError{What: "bytes", Limit: s.limits.MaxTotalBytes, Used: u.Bytes}
	}

	var rnd [8]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return Info{}, false, u, err
	}
	tmp := ".tmp-" + hex.EncodeToString(rnd[:])
	f, err := r.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return Info{}, false, u, err
	}
	_, werr := f.Write(data)
	if werr == nil {
		werr = f.Sync()
	}
	if cerr := f.Close(); werr == nil {
		werr = cerr
	}
	if werr == nil {
		werr = r.Rename(tmp, name)
	}
	if werr != nil {
		r.Remove(tmp)
		return Info{}, false, u, werr
	}
	fi, err := r.Lstat(name)
	if err != nil {
		return Info{}, false, u, err
	}
	u.Bytes = total
	if old == nil {
		u.Files++
	}
	return Info{Name: name, Size: fi.Size(), Modified: fi.ModTime().UTC(), Kind: k.Name}, old == nil, u, nil
}

// Delete removes one file. ErrNotFound when the owner has no such file.
func (s *Store) Delete(o Owner, name string) (Usage, error) {
	if _, err := CheckName(name); err != nil {
		return Usage{}, err
	}
	if err := o.Validate(); err != nil {
		return Usage{}, err
	}
	unlock := s.lock(o)
	defer unlock()
	r, err := s.open(o, false)
	if err != nil {
		return Usage{}, err
	}
	if r == nil {
		return Usage{}, ErrNotFound
	}
	defer r.Close()
	fi, err := r.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) || (err == nil && !fi.Mode().IsRegular()) {
		return Usage{}, ErrNotFound
	}
	if err != nil {
		return Usage{}, err
	}
	if err := r.Remove(name); err != nil {
		return Usage{}, err
	}
	_, u, err := scan(r, false)
	return u, err
}
