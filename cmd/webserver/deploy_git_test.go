package main

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// These tests run the pipeline with the real execRunner against real git: a
// bare origin, a clone that stands for the box, commits signed with a throwaway
// SSH key, and a fake GitHub API. They are the tests that cannot be fooled by
// a scripted runner, because git itself decides what `fetch`, `verify-commit`
// and `merge --ff-only` mean. No network, no real repository, no real key.

type scratchRepos struct {
	t       *testing.T
	root    string
	origin  string // bare repository the box fetches from
	src     string // working clone commits are made in and pushed from
	box     string // the deployed checkout
	signers string
	key     string
}

func newScratchRepos(t *testing.T) *scratchRepos {
	t.Helper()
	for _, tool := range []string{"git", "ssh-keygen", "go"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skipf("%s is not installed", tool)
		}
	}
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_TERMINAL_PROMPT", "0")
	t.Setenv("GOTOOLCHAIN", "local")

	r := &scratchRepos{t: t, root: t.TempDir()}
	r.key = filepath.Join(r.root, "key")
	r.git(r.root, "init", "-q", "--bare", "-b", "main", "origin.git")
	r.origin = filepath.Join(r.root, "origin.git")
	r.run(r.root, "ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", r.key)
	pub, err := os.ReadFile(r.key + ".pub")
	if err != nil {
		t.Fatal(err)
	}
	f := strings.Fields(string(pub))
	r.signers = filepath.Join(r.root, "allowed_signers")
	if err := os.WriteFile(r.signers, []byte("deploy@example.invalid "+f[0]+" "+f[1]+"\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	r.src = filepath.Join(r.root, "src")
	r.git(r.root, "clone", "-q", r.origin, r.src)
	r.configure(r.src)
	r.write(r.src, "go.mod", "module scratch\n\ngo 1.21\n")
	r.write(r.src, "cmd/webserver/main.go", "package main\n\nfunc main() {}\n")
	r.write(r.src, "public/a.txt", "v1\n")
	r.write(r.src, "internal/static/keep", "")
	if _, ok := r.commit("one", true); !ok {
		t.Skip("this git cannot make SSH-signed commits")
	}
	r.git(r.src, "push", "-q", "origin", "main")

	r.box = filepath.Join(r.root, "box")
	r.git(r.root, "clone", "-q", r.origin, r.box)
	r.configure(r.box)
	return r
}

// configure gives a clone the box's verification setup: SSH signatures,
// checked against an allowed_signers file.
func (r *scratchRepos) configure(dir string) {
	for k, v := range map[string]string{
		"user.email":                 "deploy@example.invalid",
		"user.name":                  "deploy",
		"gpg.format":                 "ssh",
		"gpg.ssh.allowedSignersFile": r.signers,
		"user.signingkey":            r.key + ".pub",
	} {
		r.git(dir, "config", k, v)
	}
}

func (r *scratchRepos) run(dir string, args ...string) string {
	r.t.Helper()
	cmd := exec.Command(args[0], args[1:]...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		r.t.Fatalf("%v in %s: %v\n%s", args, dir, err, out)
	}
	return strings.TrimSpace(string(out))
}

func (r *scratchRepos) git(dir string, args ...string) string {
	r.t.Helper()
	return r.run(dir, append([]string{"git"}, args...)...)
}

func (r *scratchRepos) write(dir, rel, content string) {
	r.t.Helper()
	p := filepath.Join(dir, rel)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
		r.t.Fatal(err)
	}
}

// commit commits everything in src, signed or not, and returns the new sha. ok
// is false when signing was asked for and this git could not do it.
func (r *scratchRepos) commit(msg string, sign bool) (sha string, ok bool) {
	r.t.Helper()
	r.git(r.src, "add", "-A")
	args := []string{"commit", "-q", "--allow-empty", "-m", msg}
	if sign {
		args = append(args, "-S")
	} else {
		args = append(args, "--no-gpg-sign")
	}
	cmd := exec.Command("git", args...)
	cmd.Dir = r.src
	if out, err := cmd.CombinedOutput(); err != nil {
		if sign {
			return "", false
		}
		r.t.Fatalf("git commit: %v\n%s", err, out)
	}
	return r.git(r.src, "rev-parse", "HEAD"), true
}

// signedPush commits public/a.txt = content, signed, and pushes main.
func (r *scratchRepos) signedPush(content string) string {
	r.t.Helper()
	r.write(r.src, "public/a.txt", content)
	sha, ok := r.commit("c "+content, true)
	if !ok {
		r.t.Fatal("signing failed")
	}
	r.git(r.src, "push", "-q", "origin", "refs/heads/main:refs/heads/main")
	return sha
}

func (r *scratchRepos) boxHead() string { return r.git(r.box, "rev-parse", "HEAD") }

// deployerFor builds a deployer that runs real commands in the box and asks api
// about CI. The restart is only counted.
func (r *scratchRepos) deployerFor(api *gateServer, restarts *atomic.Int32) *deployer {
	env := map[string]string{
		"DEPLOY_REPO":       "pflow-xyz/pflow-xyz",
		"DEPLOY_GITHUB_API": api.srv.URL,
		"DEPLOY_CI_POLL":    "20ms",
	}
	d := newDeployer()
	d.getenv = func(k string) string { return env[k] }
	d.httpc = api.srv.Client()
	d.restart = func() { restarts.Add(1) }
	d.projectDir = func() string { return r.box }
	d.configure(filepath.Join(r.root, "data"))
	return d
}

// deploy submits one webhook-style deploy and waits for it and its restart
// decision.
func (r *scratchRepos) deploy(d *deployer) (*deployJob, deployStatus) {
	r.t.Helper()
	job, queued := d.submit("webhook", "", false)
	if queued {
		r.t.Fatal("a deploy was already running")
	}
	select {
	case <-job.done:
	case <-time.After(2 * time.Minute):
		r.t.Fatalf("deploy hung:\n%s", job.out.String())
	}
	d.loops.Wait()
	return job, d.snapshot()
}

// ciAnswers is a fake GitHub whose answer the test switches.
type ciAnswers struct {
	mode  atomic.Value // "success" | "failure" | "pending" | "slow"
	calls atomic.Int32
}

func (c *ciAnswers) server(t *testing.T) *gateServer {
	c.mode.Store("success")
	return newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		c.calls.Add(1)
		if !strings.Contains(r.URL.Path, "/commits/") || !strings.HasSuffix(r.URL.Path, "/check-runs") {
			t.Errorf("unexpected API path %s", r.URL.Path)
		}
		switch c.mode.Load().(string) {
		case "failure":
			writeRuns(w, runJSON(1, "test", "completed", "failure"))
		case "pending":
			writeRuns(w, runJSON(1, "test", "in_progress", ""))
		case "slow":
			if c.calls.Load() < 3 {
				writeRuns(w, runJSON(1, "test", "in_progress", ""))
				return
			}
			writeRuns(w, runJSON(1, "test", "completed", "success"))
		default:
			writeRuns(w, runJSON(1, "test", "completed", "success"))
		}
	})
}

// A tag named main must not steer the deploy. `git fetch origin main` resolves
// the name as a tag before a branch, so with a tag of that name the old command
// fetched (and the pipeline verified, gated, merged and built) a commit that is
// not on main.
func TestRealGitATagNamedMainDoesNotRedirectTheDeploy(t *testing.T) {
	r := newScratchRepos(t)
	base := r.boxHead()

	// A signed commit that is on a side branch only, tagged "main".
	r.git(r.src, "switch", "-q", "-c", "side")
	r.write(r.src, "public/a.txt", "side\n")
	side, _ := r.commit("side", true)
	r.git(r.src, "push", "-q", "origin", "side")
	r.git(r.src, "tag", "main", side)
	r.git(r.src, "push", "-q", "origin", "refs/tags/main")
	r.git(r.src, "switch", "-q", "main")
	tip := r.signedPush("real\n")

	// Premise: this is the trap. Git, asked for "main", answers with the tag.
	r.git(r.root, "clone", "-q", r.origin, "probe")
	r.git(filepath.Join(r.root, "probe"), "fetch", "-q", "origin", "main")
	if got := r.git(filepath.Join(r.root, "probe"), "rev-parse", "FETCH_HEAD^{commit}"); got != side {
		t.Fatalf("the premise failed: a bare `git fetch origin main` gave %s, not the tag's %s", got, side)
	}

	api := &ciAnswers{}
	var restarts atomic.Int32
	d := r.deployerFor(api.server(t), &restarts)
	job, st := r.deploy(d)
	if job.err != nil || st.State != deploySucceeded {
		t.Fatalf("deploy: err=%v status=%+v\n%s", job.err, st, job.out.String())
	}
	if st.SHA != tip || r.boxHead() != tip {
		t.Errorf("deployed %s and the box is at %s; want the branch tip %s (the tag's commit is %s, the old head %s)",
			st.SHA, r.boxHead(), tip, side, base)
	}
	if !strings.Contains(job.out.String(), fetchCmd) {
		t.Errorf("output lacks %q:\n%s", fetchCmd, job.out.String())
	}
}

// The whole pipeline against real git: a signed tip with green CI is built; a
// red one is refused and leaves the checkout alone; a pending one is waited
// for.
func TestRealGitPipeline(t *testing.T) {
	r := newScratchRepos(t)
	api := &ciAnswers{}
	var restarts atomic.Int32
	d := r.deployerFor(api.server(t), &restarts)

	c2 := r.signedPush("v2\n")
	job, st := r.deploy(d)
	if job.err != nil || st.State != deploySucceeded || r.boxHead() != c2 || st.SHA != c2 || st.CIGate != "passed" {
		t.Fatalf("signed tip, green CI: err=%v status=%+v head=%s want %s\n%s", job.err, st, r.boxHead(), c2, job.out.String())
	}
	if b, _ := os.ReadFile(filepath.Join(r.box, "internal/static/public/a.txt")); string(b) != "v2\n" {
		t.Errorf("public/ was not copied: %q", b)
	}
	if _, err := os.Stat(filepath.Join(r.box, "bin/webserver")); err != nil {
		t.Errorf("no binary built: %v", err)
	}
	if restarts.Load() != 1 {
		t.Errorf("restarts = %d, want 1", restarts.Load())
	}

	// An unsigned tip: git verify-commit prints nothing and exits 1. Refused as
	// unsigned, before CI is even asked, with the checkout where it was.
	r.write(r.src, "public/a.txt", "unsigned\n")
	if _, ok := r.commit("unsigned", false); !ok {
		t.Fatal("commit failed")
	}
	r.git(r.src, "push", "-q", "origin", "refs/heads/main:refs/heads/main")
	before := api.calls.Load()
	job, st = r.deploy(d)
	if st.State != deployRefused || r.boxHead() != c2 || !strings.Contains(st.Error, "carries no signature") ||
		strings.Contains(st.Error, "no output") || api.calls.Load() != before {
		t.Fatalf("unsigned tip: status=%+v head=%s\n%s", st, r.boxHead(), job.out.String())
	}

	// Red CI on a signed tip: refused, the checkout is where it was.
	r.signedPush("v3\n")
	api.mode.Store("failure")
	job, st = r.deploy(d)
	if st.State != deployRefused || r.boxHead() != c2 || st.CIGate != "refused" || !strings.Contains(st.Error, "failure") {
		t.Fatalf("red CI: status=%+v head=%s\n%s", st, r.boxHead(), job.out.String())
	}
	if restarts.Load() != 1 {
		t.Errorf("a refused deploy restarted the service")
	}

	// CI turns green after a few polls: deployed.
	api.mode.Store("slow")
	api.calls.Store(0)
	job, st = r.deploy(d)
	tip := r.git(r.src, "rev-parse", "HEAD")
	if job.err != nil || st.State != deploySucceeded || r.boxHead() != tip {
		t.Fatalf("slow CI: err=%v status=%+v head=%s want %s\n%s", job.err, st, r.boxHead(), tip, job.out.String())
	}
	if api.calls.Load() < 3 {
		t.Errorf("polls = %d: the gate did not wait", api.calls.Load())
	}
}
