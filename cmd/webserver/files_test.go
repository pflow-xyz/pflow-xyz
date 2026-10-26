package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/pflow-xyz/pflow-xyz/internal/auth"
	"github.com/pflow-xyz/pflow-xyz/internal/userfiles"
)

// filesVerifier knows two GitHub accounts, plus alice under a renamed login.
type filesVerifier struct{ down bool }

func (v filesVerifier) Verify(_ context.Context, token string) (*auth.GitHubUserInfo, error) {
	if v.down {
		return nil, auth.ErrVerifierUnavailable
	}
	switch token {
	case "alice":
		return &auth.GitHubUserInfo{ID: "1001", GitHubID: "1001", UserName: "alice"}, nil
	case "alice-renamed":
		return &auth.GitHubUserInfo{ID: "1001", GitHubID: "1001", UserName: "alice-2"}, nil
	case "bob":
		return &auth.GitHubUserInfo{ID: "1002", GitHubID: "1002", UserName: "bob"}, nil
	}
	return nil, auth.ErrInvalidToken
}

// filesServer serves /api/files from a fresh directory; it returns the data
// directory the files live under, to check that nothing lands elsewhere.
func filesServer(t *testing.T, limits userfiles.Limits, v auth.Verifier) (*Server, string) {
	t.Helper()
	data := t.TempDir()
	return &Server{files: &fileService{store: userfiles.New(filepath.Join(data, "files"), limits), accounts: githubFileAccounts(v)}}, data
}

// onDisk lists every regular file under dir, relative and sorted.
func onDisk(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			rel, _ := filepath.Rel(dir, p)
			out = append(out, rel)
		}
		return nil
	})
	sort.Strings(out)
	return out
}

func filesBody(t *testing.T, rec *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("not JSON (%d): %s", rec.Code, rec.Body)
	}
	return out
}

const filesNet = `{"@context":"https://pflow.xyz/schema","@type":"PetriNet","places":{"p":{"initial":[1]}},"transitions":{},"arcs":[]}`

func TestFilesNeedSignIn(t *testing.T) {
	s, data := filesServer(t, userfiles.DefaultLimits, filesVerifier{})
	down, _ := filesServer(t, userfiles.DefaultLimits, filesVerifier{down: true})
	routes := [][2]string{{"GET", "/api/files"}, {"GET", "/api/files/a.json"}, {"PUT", "/api/files/a.json"}, {"DELETE", "/api/files/a.json"}}
	for _, rt := range routes {
		for _, token := range []string{"", "forged"} {
			rec := do(t, s, rt[0], rt[1], token, filesNet)
			if rec.Code != 401 || !strings.Contains(filesBody(t, rec)["error"].(string), "sign in to save") {
				t.Errorf("%s %s token %q: %d %s, want 401 saying to sign in to save", rt[0], rt[1], token, rec.Code, rec.Body)
			}
		}
		// GitHub cannot be asked: fail closed, never treat it as signed out or as anyone.
		if rec := do(t, down, rt[0], rt[1], "alice", filesNet); rec.Code != 503 {
			t.Errorf("%s %s with the verifier down: %d, want 503", rt[0], rt[1], rec.Code)
		}
	}
	if got := onDisk(t, data); len(got) != 0 {
		t.Fatalf("unauthenticated requests wrote %v", got)
	}
	if rec := do(t, &Server{}, "GET", "/api/files", "alice", ""); rec.Code != 503 {
		t.Fatalf("not configured: %d, want 503", rec.Code)
	}
}

func TestFilesAreSegregatedPerAccount(t *testing.T) {
	s, data := filesServer(t, userfiles.DefaultLimits, filesVerifier{})
	if rec := do(t, s, "PUT", "/api/files/sir.json", "alice", filesNet); rec.Code != 201 {
		t.Fatalf("alice saves: %d %s", rec.Code, rec.Body)
	}
	// Bob sees none of it.
	if files := filesBody(t, do(t, s, "GET", "/api/files", "bob", ""))["files"].([]any); len(files) != 0 {
		t.Fatalf("bob lists %v", files)
	}
	if rec := do(t, s, "GET", "/api/files/sir.json", "bob", ""); rec.Code != 404 {
		t.Fatalf("bob reads alice's file: %d %s", rec.Code, rec.Body)
	}
	if rec := do(t, s, "DELETE", "/api/files/sir.json", "bob", ""); rec.Code != 404 {
		t.Fatalf("bob deletes alice's file: %d", rec.Code)
	}
	// Bob's save under the same name is his own file, with or without overwrite.
	if rec := do(t, s, "PUT", "/api/files/sir.json", "bob", `{"bob":true}`); rec.Code != 201 {
		t.Fatalf("bob saves the same name: %d %s", rec.Code, rec.Body)
	}
	if rec := do(t, s, "PUT", "/api/files/sir.json?overwrite=true", "bob", `{"bob":2}`); rec.Code != 200 {
		t.Fatalf("bob overwrites his own: %d %s", rec.Code, rec.Body)
	}
	if rec := do(t, s, "GET", "/api/files/sir.json", "alice", ""); rec.Code != 200 || rec.Body.String() != filesNet {
		t.Fatalf("alice's file changed: %d %s", rec.Code, rec.Body)
	}
	if rec := do(t, s, "DELETE", "/api/files/sir.json", "bob", ""); rec.Code != 200 {
		t.Fatalf("bob deletes his own: %d", rec.Code)
	}
	if rec := do(t, s, "GET", "/api/files/sir.json", "alice", ""); rec.Code != 200 {
		t.Fatalf("bob's delete removed alice's file: %d", rec.Code)
	}
	// One directory per account, named by the hex of "github:<id>".
	alice := userfiles.Owner{Provider: "github", Subject: "1001"}
	if got, want := onDisk(t, data), []string{filepath.Join("files", alice.Dir(), "sir.json")}; strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("on disk %v, want %v", got, want)
	}
}

func TestFilesAreKeyedByNumericID(t *testing.T) {
	s, _ := filesServer(t, userfiles.DefaultLimits, filesVerifier{})
	do(t, s, "PUT", "/api/files/a.json", "alice", filesNet)
	// A renamed GitHub login is the same account: the numeric id is the key.
	if rec := do(t, s, "GET", "/api/files/a.json", "alice-renamed", ""); rec.Code != 200 {
		t.Fatalf("renamed login lost its files: %d", rec.Code)
	}
}

func TestFilesRefuseUnsafeNames(t *testing.T) {
	s, data := filesServer(t, userfiles.DefaultLimits, filesVerifier{})
	raw := []string{
		"/api/files/../x.json", "/api/files/..%2fx.json", "/api/files/..%2Fx.json", "/api/files/%2e%2e%2fx.json",
		"/api/files/%2e%2e", "/api/files/..", "/api/files/a%2fb.json", "/api/files/a/b.json", "/api/files//etc/passwd.txt",
		"/api/files/%2Fetc%2Fpasswd.txt", "/api/files/a%5Cb.json", `/api/files/a\b.json`, "/api/files/a%00.json",
		"/api/files/.hidden.json", "/api/files/.json", "/api/files/" + strings.Repeat("a", 200) + ".json",
		"/api/files/caf%C3%A9.json", "/api/files/a%E2%88%95b.json", "/api/files/a%EF%BC%8Fb.json", "/api/files/a%20b.json",
		"/api/files/a..json", "/api/files/x.exe", "/api/files/noext", "/api/files/x.json%2500", "/api/files/x.json.",
		"/api/files/%61.json", "/api/%66iles/x.json",
	}
	tried := 0
	for _, target := range raw {
		u, err := url.ParseRequestURI(target)
		if err != nil {
			continue // net/http answers 400 before any handler sees it
		}
		tried++
		for _, method := range []string{"PUT", "GET", "DELETE"} {
			req := httptest.NewRequest(method, "/api/files/placeholder.json", strings.NewReader(filesNet))
			req.URL, req.RequestURI = u, target
			req.Header.Set("Authorization", "Bearer alice")
			rec := httptest.NewRecorder()
			s.ServeHTTP(rec, req)
			if rec.Code != 400 {
				t.Errorf("%s %s: %d %s, want 400", method, target, rec.Code, rec.Body)
			}
		}
	}
	if tried < len(raw)-2 {
		t.Fatalf("only %d of %d targets reached the server", tried, len(raw))
	}
	if got := onDisk(t, data); len(got) != 0 {
		t.Fatalf("unsafe names wrote %v", got)
	}
}

func TestFilesOverwriteSemantics(t *testing.T) {
	s, _ := filesServer(t, userfiles.DefaultLimits, filesVerifier{})
	rec := do(t, s, "PUT", "/api/files/n.json", "alice", filesNet)
	if b := filesBody(t, rec); rec.Code != 201 || b["created"] != true || b["name"] != "n.json" || b["kind"] != "net" {
		t.Fatalf("create: %d %v", rec.Code, b)
	}
	rec = do(t, s, "PUT", "/api/files/n.json", "alice", `{"second":1}`)
	if rec.Code != 409 || !strings.Contains(filesBody(t, rec)["error"].(string), "overwrite") {
		t.Fatalf("create over an existing name: %d %s, want 409 naming overwrite", rec.Code, rec.Body)
	}
	if rec := do(t, s, "PUT", "/api/files/n.json?overwrite=false", "alice", `{"second":1}`); rec.Code != 409 {
		t.Fatalf("overwrite=false: %d", rec.Code)
	}
	if got := do(t, s, "GET", "/api/files/n.json", "alice", "").Body.String(); got != filesNet {
		t.Fatalf("a refused save changed the file: %s", got)
	}
	rec = do(t, s, "PUT", "/api/files/n.json?overwrite=true", "alice", `{"second":1}`)
	if b := filesBody(t, rec); rec.Code != 200 || b["created"] != false {
		t.Fatalf("overwrite: %d %v", rec.Code, b)
	}
	if got := do(t, s, "GET", "/api/files/n.json", "alice", "").Body.String(); got != `{"second":1}` {
		t.Fatalf("after overwrite: %s", got)
	}
	if rec := do(t, s, "PUT", "/api/files/n.json?overwrite=yes", "alice", filesNet); rec.Code != 400 {
		t.Fatalf("overwrite=yes: %d, want 400", rec.Code)
	}
	if rec := do(t, s, "PUT", "/api/files/m.json?overwrite=1", "alice", filesNet); rec.Code != 201 {
		t.Fatalf("overwrite on a new name creates it: %d", rec.Code)
	}
}

func TestFilesRoundTripAndList(t *testing.T) {
	s, _ := filesServer(t, userfiles.DefaultLimits, filesVerifier{})
	png := append([]byte("\x89PNG\r\n\x1a\n"), 0, 1, 2, 0xff, 0xfe, '\n', '\r')
	files := map[string]struct {
		body []byte
		mime string
	}{
		"net.jsonld": {[]byte(filesNet), "application/ld+json"},
		"net.svg":    {[]byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`), "image/svg+xml"},
		"shot.png":   {png, "image/png"},
		"run.csv":    {[]byte("time,S\n0,99\n"), "text/csv; charset=utf-8"},
		"log.jsonl":  {[]byte("{\"a\":1}\n{\"a\":2}\n"), "application/jsonl; charset=utf-8"},
		"notes.txt":  {[]byte("héllo\n"), "text/plain; charset=utf-8"},
	}
	for name, f := range files {
		if rec := do(t, s, "PUT", "/api/files/"+name, "alice", string(f.body)); rec.Code != 201 {
			t.Fatalf("PUT %s: %d %s", name, rec.Code, rec.Body)
		}
	}
	for name, f := range files {
		rec := do(t, s, "GET", "/api/files/"+name, "alice", "")
		if rec.Code != 200 || !bytes.Equal(rec.Body.Bytes(), f.body) {
			t.Errorf("GET %s: %d, body differs", name, rec.Code)
		}
		h := rec.Header()
		if h.Get("Content-Type") != f.mime || h.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(h.Get("Content-Security-Policy"), "sandbox") || h.Get("Cache-Control") != "no-store" {
			t.Errorf("GET %s headers: %v", name, h)
		}
	}
	b := filesBody(t, do(t, s, "GET", "/api/files", "alice", ""))
	list := b["files"].([]any)
	var names []string
	for _, x := range list {
		e := x.(map[string]any)
		names = append(names, e["name"].(string))
		if int(e["size"].(float64)) != len(files[e["name"].(string)].body) || e["modified"] == "" || e["kind"] == "" {
			t.Errorf("entry %v", e)
		}
	}
	if strings.Join(names, " ") != "log.jsonl net.jsonld net.svg notes.txt run.csv shot.png" {
		t.Errorf("list order/names: %v", names)
	}
	if u := b["usage"].(map[string]any); int(u["files"].(float64)) != 6 {
		t.Errorf("usage %v", u)
	}
	if l := b["limits"].(map[string]any); int64(l["max_file_bytes"].(float64)) != userfiles.DefaultLimits.MaxFileBytes {
		t.Errorf("limits %v", l)
	}
	// Content that does not match its extension is refused.
	for name, body := range map[string]string{"bad.json": "{nope", "bad.png": "GIF89a", "bad.svg": "<html/>", "bad.csv": "\xff"} {
		if rec := do(t, s, "PUT", "/api/files/"+name, "alice", body); rec.Code != 400 {
			t.Errorf("PUT %s %q: %d, want 400", name, body, rec.Code)
		}
	}
	if rec := do(t, s, "DELETE", "/api/files/run.csv", "alice", ""); rec.Code != 200 || filesBody(t, rec)["deleted"] != "run.csv" {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body)
	}
	if rec := do(t, s, "DELETE", "/api/files/run.csv", "alice", ""); rec.Code != 404 {
		t.Fatalf("delete again: %d", rec.Code)
	}
}

func TestFilesLimits(t *testing.T) {
	s, _ := filesServer(t, userfiles.Limits{MaxFileBytes: 32, MaxFiles: 2, MaxTotalBytes: 48}, filesVerifier{})
	rec := do(t, s, "PUT", "/api/files/big.txt", "alice", strings.Repeat("x", 33))
	if rec.Code != 413 || int(filesBody(t, rec)["limit"].(float64)) != 32 {
		t.Fatalf("over the file size: %d %s", rec.Code, rec.Body)
	}
	// A body longer than it says is cut at the limit too.
	req := httptest.NewRequest("PUT", "/api/files/big.txt", strings.NewReader(strings.Repeat("x", 100)))
	req.ContentLength = -1
	req.Header.Set("Authorization", "Bearer alice")
	rec = httptest.NewRecorder()
	s.ServeHTTP(rec, req)
	if rec.Code != 413 {
		t.Fatalf("chunked body over the limit: %d", rec.Code)
	}
	do(t, s, "PUT", "/api/files/a.txt", "alice", strings.Repeat("x", 30))
	rec = do(t, s, "PUT", "/api/files/b.txt", "alice", strings.Repeat("x", 20))
	if rec.Code != 507 || filesBody(t, rec)["what"] != "bytes" {
		t.Fatalf("over the total: %d %s", rec.Code, rec.Body)
	}
	do(t, s, "PUT", "/api/files/b.txt", "alice", "x")
	rec = do(t, s, "PUT", "/api/files/c.txt", "alice", "x")
	if rec.Code != 507 || filesBody(t, rec)["what"] != "files" {
		t.Fatalf("over the file count: %d %s", rec.Code, rec.Body)
	}
	if rec := do(t, s, "PUT", "/api/files/b.txt?overwrite=true", "alice", "yy"); rec.Code != 200 {
		t.Fatalf("overwrite at the count limit: %d %s", rec.Code, rec.Body)
	}
	if rec := do(t, s, "PUT", "/api/files/c.txt", "bob", "x"); rec.Code != 201 {
		t.Fatalf("bob has his own limits: %d", rec.Code)
	}
}

func TestFilesMethods(t *testing.T) {
	s, _ := filesServer(t, userfiles.DefaultLimits, filesVerifier{})
	for _, c := range []struct{ method, path, allow string }{
		{"POST", "/api/files", "GET"}, {"PUT", "/api/files", "GET"}, {"DELETE", "/api/files/", "GET"},
		{"POST", "/api/files/a.json", "GET, PUT, DELETE"}, {"PATCH", "/api/files/a.json", "GET, PUT, DELETE"},
		{"OPTIONS", "/api/files/a.json", "GET, PUT, DELETE"}, {"GE", "/api/files/a.json", "GET, PUT, DELETE"},
	} {
		rec := do(t, s, c.method, c.path, "alice", filesNet)
		if rec.Code != 405 || rec.Header().Get("Allow") != c.allow {
			t.Errorf("%s %s: %d Allow %q, want 405 Allow %q", c.method, c.path, rec.Code, rec.Header().Get("Allow"), c.allow)
		}
	}
}

func TestFilesRefuseCrossOrigin(t *testing.T) {
	s, data := filesServer(t, userfiles.DefaultLimits, filesVerifier{})
	for _, hdr := range [][]string{
		{"Origin", "https://evil.example"},
		{"Origin", "null"},
		{"Origin", "https://pflow.xyz.evil.example"},
		{"Sec-Fetch-Site", "cross-site"},
		{"Sec-Fetch-Site", "same-site", "Origin", "https://sub.pflow.xyz"},
		{"Sec-Fetch-Site", "cross-site", "Origin", "https://pflow.xyz"},
	} {
		for _, m := range []string{"PUT", "DELETE", "GET"} {
			req := httptest.NewRequest(m, "https://pflow.xyz/api/files/x.json", strings.NewReader(filesNet))
			req.Header.Set("Authorization", "Bearer alice")
			for i := 0; i+1 < len(hdr); i += 2 {
				req.Header.Set(hdr[i], hdr[i+1])
			}
			rec := httptest.NewRecorder()
			s.ServeHTTP(rec, req)
			if rec.Code != 403 {
				t.Errorf("%s with %v: %d, want 403", m, hdr, rec.Code)
			}
			if rec.Header().Get("Access-Control-Allow-Origin") != "" {
				t.Errorf("%s with %v sent CORS headers", m, hdr)
			}
		}
	}
	if got := onDisk(t, data); len(got) != 0 {
		t.Fatalf("cross-origin requests wrote %v", got)
	}
	// The page itself: same origin, by Origin or by Sec-Fetch-Site; and a
	// client that is not a page (no Origin at all) is judged by its token.
	for i, hdr := range [][]string{
		{"Origin", "https://pflow.xyz"},
		{"Sec-Fetch-Site", "same-origin", "Origin", "https://pflow.xyz"},
		{"Origin", "https://pflow.xyz", "X-Forwarded-Host", "pflow.xyz"},
		{},
	} {
		req := httptest.NewRequest("PUT", "https://pflow.xyz/api/files/ok"+string(rune('a'+i))+".json", strings.NewReader(filesNet))
		req.Header.Set("Authorization", "Bearer alice")
		for j := 0; j+1 < len(hdr); j += 2 {
			req.Header.Set(hdr[j], hdr[j+1])
		}
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated || rec.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Errorf("same-origin %v: %d %s", hdr, rec.Code, rec.Body)
		}
	}
}

func TestConfigureFilesUsesTheDataDir(t *testing.T) {
	data := t.TempDir()
	s := &Server{}
	s.configureFiles(data)
	if s.files == nil || s.files.accounts == nil {
		t.Fatal("not configured")
	}
	if _, err := os.Stat(filepath.Join(data, "files")); !os.IsNotExist(err) {
		t.Fatalf("nothing is created before the first save: %v", err)
	}
}

// TestFilesPageClientRoundTrip drives the page's own account-file commands
// (public/petri-commands.js, run by node with its fetch) against this handler,
// so the two sides of /api/files cannot drift apart.
func TestFilesPageClientRoundTrip(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not installed: the page side needs it")
	}
	s, data := filesServer(t, userfiles.DefaultLimits, filesVerifier{})
	srv := httptest.NewServer(s)
	defer srv.Close()
	abs, _ := filepath.Abs("../../public/petri-commands.js")
	quoted, _ := json.Marshal(abs)
	script := filepath.Join(t.TempDir(), "client.mjs")
	src := `import { Registry, createHeadlessHost } from ` + string(quoted) + `;
const base = process.argv[2];
const net = JSON.parse(process.argv[3]);
const out = {};
const code = async (p) => { try { await p; return "ok"; } catch (e) { return e.code + ": " + e.message; } };
const alice = new Registry(createHeadlessHost(net, { token: "alice", apiBase: base }));
out.save = await alice.execute("file.save", { name: "sir.json" });
out.again = await code(alice.execute("file.save", { name: "sir.json" }));
out.replace = await alice.execute("file.save", { name: "sir.json", overwrite: true });
out.svg = await alice.execute("file.write", { name: "net.svg", content: "<svg xmlns=\"http://www.w3.org/2000/svg\"/>" });
out.svgBack = (await alice.execute("file.get", { name: "net.svg" })).content;
const run = await alice.execute("sim.ode", { t_end: 1 });
out.csv = await alice.execute("export.artifact", { id: run.artifact, name: "run.csv" });
out.list = (await alice.execute("file.list")).files.map((f) => f.name + ":" + f.kind);
await alice.execute("file.new");
out.open = await alice.execute("file.open", { name: "sir.json" });
out.places = Object.keys(alice.host.getModel().places);
out.badName = await code(alice.execute("file.save", { name: "../x.json" }));
const bob = new Registry(createHeadlessHost(net, { token: "bob", apiBase: base }));
out.bobList = (await bob.execute("file.list")).files.length;
out.bobOpen = await code(bob.execute("file.open", { name: "sir.json" }));
out.signedOut = await code(new Registry(createHeadlessHost(net, { apiBase: base })).execute("file.list"));
out.forged = await code(new Registry(createHeadlessHost(net, { token: "forged", apiBase: base })).execute("file.list"));
out.deleted = await alice.execute("file.delete", { name: "net.svg" });
console.log(JSON.stringify(out));`
	if err := os.WriteFile(script, []byte(src), 0o644); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(node, script, srv.URL, filesNet)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		t.Fatalf("page client: %v\n%s", err, stderr.String())
	}
	var out struct {
		Save, Replace, Svg, Csv, Open map[string]any
		Again, SvgBack, BadName       string
		List, Places                  []string
		BobList                       int
		BobOpen, SignedOut, Forged    string
		Deleted                       map[string]any
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("page client output %q: %v", raw, err)
	}
	if out.Save["created"] != true || out.Replace["created"] != false || out.Svg["kind"] != "svg" || out.Csv["name"] != "run.csv" {
		t.Errorf("saves: %+v %+v %+v %+v", out.Save, out.Replace, out.Svg, out.Csv)
	}
	if !strings.HasPrefix(out.Again, "conflict: ") || !strings.Contains(out.Again, "overwrite") {
		t.Errorf("saving over a name: %q", out.Again)
	}
	if !strings.Contains(out.SvgBack, "<svg") {
		t.Errorf("svg read back: %q", out.SvgBack)
	}
	if strings.Join(out.List, " ") != "net.svg:svg run.csv:csv sir.json:net" {
		t.Errorf("list: %v", out.List)
	}
	if out.Open["name"] != "sir.json" || strings.Join(out.Places, ",") != "p" {
		t.Errorf("open: %+v places %v", out.Open, out.Places)
	}
	if !strings.HasPrefix(out.BadName, "invalid: ") {
		t.Errorf("bad name: %q", out.BadName)
	}
	if out.BobList != 0 || !strings.HasPrefix(out.BobOpen, "not_found: ") {
		t.Errorf("bob sees alice's files: %d %q", out.BobList, out.BobOpen)
	}
	for _, m := range []string{out.SignedOut, out.Forged} {
		if !strings.HasPrefix(m, "unauthenticated: ") || !strings.Contains(strings.ToLower(m), "sign in to save") {
			t.Errorf("signed out: %q", m)
		}
	}
	if out.Deleted["deleted"] != "net.svg" {
		t.Errorf("delete: %+v", out.Deleted)
	}
	alice := userfiles.Owner{Provider: "github", Subject: "1001"}
	want := []string{filepath.Join("files", alice.Dir(), "run.csv"), filepath.Join("files", alice.Dir(), "sir.json")}
	if got := onDisk(t, data); strings.Join(got, ",") != strings.Join(want, ",") {
		t.Errorf("on disk %v, want %v", got, want)
	}
}
