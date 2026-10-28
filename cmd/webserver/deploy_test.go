package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestVerifyHMAC(t *testing.T) {
	secret := "s3cret"
	body := []byte(`{"ref":"refs/heads/main"}`)
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	good := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	if !verifyHMAC(secret, body, good) {
		t.Error("a correct signature must verify")
	}
	for name, sig := range map[string]string{
		"empty":         "",
		"no prefix":     good[len("sha256="):],
		"sha1 prefix":   "sha1=" + good[len("sha256="):],
		"not hex":       "sha256=zz",
		"wrong digest":  "sha256=" + strings.Repeat("0", 64),
		"truncated":     good[:len(good)-2],
		"upper-cased x": strings.Replace(good, "sha256=", "SHA256=", 1),
	} {
		if verifyHMAC(secret, body, sig) {
			t.Errorf("%s: must not verify", name)
		}
	}
	if verifyHMAC("other", body, good) {
		t.Error("a different secret must not verify")
	}
	if verifyHMAC(secret, append(body, ' '), good) {
		t.Error("a different body must not verify")
	}
}

// The exact text that stopped the deploy on 2026-10-28 (service log, 15:39:41Z
// and 19:03:31Z), and the same failure as git prints it on a Mac, which is the
// output the local proof in docs/deploy.md captured.
const (
	incidentLog = `==> verify signature
    cd /home/ubuntu/Workspace/pflow-xyz && git verify-commit origin/main
gpg: Signature made Wed Oct 28 14:02:55 2026 CDT
gpg:                using RSA key B5690EEEBB952194
gpg: Can't check signature: No public key
`
	webFlowSHA = "57f6caf8289c7b80f2f2705be5611db863d2d615"
)

func TestExplainVerifyFailureNamesTheWebFlowKeyAndTheRemedy(t *testing.T) {
	msg := explainVerifyFailure(webFlowSHA, incidentLog)
	for _, want := range []string{
		webFlowSHA,                 // the tip
		"RSA key B5690EEEBB952194", // the signer, as gpg printed it
		"web-flow",                 // whose key it is
		webFlowImportCmd,           // the remedy, verbatim
		webFlowFingerprint,         // what to check the import against
		"gpg --fingerprint B5690EEEBB952194",
		"does not trust it by itself", // the code does not make the trust decision
	} {
		if !strings.Contains(msg, want) {
			t.Errorf("message lacks %q:\n%s", want, msg)
		}
	}
	if !strings.HasPrefix(msg, "refusing to deploy "+webFlowSHA+": ") {
		t.Errorf("message should lead with the refusal and the sha: %s", msg)
	}
	d := diagnoseVerify(incidentLog)
	if d.Kind != "no-public-key" || d.KeyAlgo != "RSA" || d.KeyID != "B5690EEEBB952194" || !d.WebFlow {
		t.Errorf("diagnosis = %+v", d)
	}
}

func TestExplainVerifyFailureOtherKinds(t *testing.T) {
	sha := strings.Repeat("ab", 20)
	cases := []struct {
		name, out string
		kind      string
		contains  []string
		lacks     []string
	}{
		{
			name: "no public key, not web-flow",
			out:  "gpg: Signature made Tue Oct 27 09:00:00 2026 UTC\ngpg:                using EDDSA key 0123456789ABCDEF0123456789ABCDEF01234567\ngpg: Can't check signature: No public key\n",
			kind: "no-public-key", contains: []string{"EDDSA key 0123456789ABCDEF0123456789ABCDEF01234567", "no public key", "import its public key"},
			lacks: []string{"web-flow"},
		},
		{
			name: "older gpg wording and short key ids",
			out:  "gpg: Signature made Tue 27 Oct 2026 09:00:00 AM UTC using RSA key ID BB952194\ngpg: Can't check signature: public key not found\n",
			kind: "no-public-key", contains: []string{"RSA key BB952194", "web-flow"}, // 8 hex digits: still GitHub's key
		},
		{
			name: "machine readable status line only",
			out:  "[GNUPG:] ERRSIG 4AEE18F83AFDEB23 1 8 00 1700000000 9 -\n[GNUPG:] NO_PUBKEY 4AEE18F83AFDEB23\n",
			kind: "no-public-key", contains: []string{"key 4AEE18F83AFDEB23"}, lacks: []string{"web-flow"},
		},
		{
			name: "bad signature",
			out:  "gpg: Signature made Tue Oct 27 09:00:00 2026 UTC\ngpg:                using RSA key B5690EEEBB952194\ngpg: BAD signature from \"GitHub <noreply@github.com>\" [unknown]\n",
			kind: "bad-signature", contains: []string{"BAD", "B5690EEEBB952194"}, lacks: []string{webFlowImportCmd},
		},
		{
			name: "unsigned commit",
			out:  "error: no signature found\n",
			kind: "unsigned", contains: []string{"not signed"},
		},
		{
			name: "ssh signature from an unlisted key",
			out:  "Good \"git\" signature with ED25519 key SHA256:abc\nNo principal matched.\n",
			kind: "ssh-untrusted", contains: []string{"allowed_signers"},
		},
		{
			name: "ssh verification not configured",
			out:  "error: gpg.ssh.allowedSignersFile needs to be configured and exist for ssh signature verification\n",
			kind: "ssh-untrusted", contains: []string{"allowed_signers"},
		},
		{
			name: "something unforeseen",
			out:  "fatal: bad object deadbeef\nmore\nlast line\n",
			kind: "unknown", contains: []string{"git verify-commit failed", "last line"},
		},
		{
			name: "no output at all",
			out:  "",
			kind: "unknown", contains: []string{"no output"},
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if d := diagnoseVerify(c.out); d.Kind != c.kind {
				t.Errorf("kind = %q, want %q", d.Kind, c.kind)
			}
			msg := explainVerifyFailure(sha, c.out)
			if !strings.Contains(msg, sha) {
				t.Errorf("message must name the sha: %s", msg)
			}
			for _, w := range c.contains {
				if !strings.Contains(msg, w) {
					t.Errorf("message lacks %q: %s", w, msg)
				}
			}
			for _, w := range c.lacks {
				if strings.Contains(msg, w) {
					t.Errorf("message must not contain %q: %s", w, msg)
				}
			}
		})
	}
}

func TestIsWebFlowKey(t *testing.T) {
	for id, want := range map[string]bool{
		"B5690EEEBB952194":              true,
		"b5690eeebb952194":              true,
		webFlowFingerprint:              true,
		"BB952194":                      true,
		"2194":                          false, // too short to name a key
		"4AEE18F83AFDEB23":              false, // web-flow's expired 2017 key: not the one that signs now
		"B5690EEEBB952195":              false,
		"":                              false,
		"0000" + webFlowFingerprint[4:]: false,
		"B5690EEEBB952194B5690EEEBB952194B5690EEE": false,
	} {
		if got := isWebFlowKey(id); got != want {
			t.Errorf("isWebFlowKey(%q) = %v, want %v", id, got, want)
		}
	}
}

// ---- Pipeline harness ------------------------------------------------------

type cmdResult struct {
	out string
	err error
}

// deployHarness runs a deployer against a scripted git/go and a fake GitHub:
// no process is started, no network is touched, no repository changes.
type deployHarness struct {
	t   *testing.T
	d   *deployer
	clk *fakeClock
	api *gateServer

	sha    string
	remote string
	env    map[string]string
	gate   func(n int, w http.ResponseWriter, r *http.Request)

	mu       sync.Mutex
	events   []string // commands and API calls, in order
	fail     map[string]cmdResult
	panicOn  string
	live     int
	maxLive  int
	restarts atomic.Int32

	// blockFetch, when non-nil, parks the first "git fetch" until released.
	blockFetch chan struct{}
	fetchSeen  chan struct{}
	blockOnce  sync.Once
}

const harnessSHA = "8d30d96a1b2c3d4e5f60718293a4b5c6d7e8f901"

func newHarness(t *testing.T) *deployHarness {
	t.Helper()
	h := &deployHarness{
		t:      t,
		sha:    harnessSHA,
		remote: "git@github.com:pflow-xyz/pflow-xyz.git\n",
		env:    map[string]string{},
		fail:   map[string]cmdResult{},
		clk:    newFakeClock(),
	}
	h.gate = func(n int, w http.ResponseWriter, r *http.Request) {
		writeRuns(w, runJSON(7, "test", "completed", "success"))
	}
	h.api = newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		h.record(fmt.Sprintf("GET check-runs %s", strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/repos/pflow-xyz/pflow-xyz/commits/"), "/check-runs")))
		h.gate(n, w, r)
	})
	h.d = &deployer{
		getenv: func(k string) string { return h.env[k] },
		run:    h.runner,
		httpc:  h.api.srv.Client(),
		now:    h.clk.Now,
		sleep:  h.clk.Sleep,
		restart: func() {
			h.restarts.Add(1)
		},
		projectDir: func() string { return "/srv/pflow-xyz" },
		status:     deployStatus{State: deployIdle},
	}
	h.env["DEPLOY_GITHUB_API"] = h.api.srv.URL
	return h
}

func (h *deployHarness) record(e string) {
	h.mu.Lock()
	h.events = append(h.events, e)
	h.mu.Unlock()
}

func (h *deployHarness) log() []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]string(nil), h.events...)
}

func (h *deployHarness) runner(ctx context.Context, dir string, args ...string) ([]byte, error) {
	line := strings.Join(args, " ")
	h.mu.Lock()
	h.events = append(h.events, line)
	h.live++
	if h.live > h.maxLive {
		h.maxLive = h.live
	}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		h.live--
		h.mu.Unlock()
	}()

	if dir != "/srv/pflow-xyz" {
		h.t.Errorf("command ran in %q, want the project dir: %s", dir, line)
	}
	if h.blockFetch != nil && line == "git fetch origin main" {
		h.blockOnce.Do(func() {
			close(h.fetchSeen)
			<-h.blockFetch
		})
	}
	if h.panicOn != "" && strings.HasPrefix(line, h.panicOn) {
		panic("scripted panic in " + line)
	}
	for prefix, res := range h.fail {
		if strings.HasPrefix(line, prefix) {
			return []byte(res.out), res.err
		}
	}
	switch {
	case line == "git rev-parse --verify FETCH_HEAD^{commit}":
		return []byte(h.sha + "\n"), nil
	case line == "git remote get-url origin":
		return []byte(h.remote), nil
	}
	return nil, nil
}

// wait blocks until every loop has finished, including its restart decision.
func (h *deployHarness) wait() {
	h.t.Helper()
	done := make(chan struct{})
	go func() { h.d.loops.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		h.t.Fatal("deployer did not go idle")
	}
}

// deploy submits one webhook-style deploy and waits for everything to settle.
func (h *deployHarness) deploy(skipCI bool) *deployJob {
	h.t.Helper()
	job, queued := h.d.submit("webhook", "announced-sha", skipCI)
	if queued {
		h.t.Fatal("expected the deploy to start at once")
	}
	h.wait()
	return job
}

func (h *deployHarness) status() deployStatus { return h.d.snapshot() }

// fullRun is the command sequence of a deploy that succeeds (the gate's polling
// shows as one "GET check-runs"; see collapse).
func fullRun(sha string) []string {
	return []string{
		"git fetch origin main",
		"git rev-parse --verify FETCH_HEAD^{commit}",
		"git verify-commit " + sha,
		"git remote get-url origin", // only after the signature has passed
		"GET check-runs " + sha,
		"git merge --ff-only " + sha,
		"bash -c rm -rf internal/static/public && cp -r public internal/static/",
		"go build -o bin/webserver ./cmd/webserver",
	}
}

func TestDeployRunsFetchVerifyGateMergeCopyBuildInThatOrder(t *testing.T) {
	h := newHarness(t)
	job := h.deploy(false)
	if job.err != nil {
		t.Fatalf("deploy failed: %v\n%s", job.err, job.out.String())
	}
	if got, want := h.log(), fullRun(harnessSHA); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("sequence:\n%s\nwant:\n%s", strings.Join(got, "\n"), strings.Join(want, "\n"))
	}
	// The pinned sha is the one used everywhere; the moving ref is never named.
	for _, e := range h.log() {
		if strings.Contains(e, "origin/main") {
			t.Errorf("%q names the moving ref; every step after the fetch must use the pinned sha", e)
		}
	}
	st := h.status()
	if st.State != deploySucceeded || st.SHA != harnessSHA || st.CIGate != "passed" || st.Trigger != "webhook" ||
		st.AnnouncedSHA != "announced-sha" || st.Step != "done" || st.Error != "" ||
		!strings.Contains(st.CIRunURL, "/actions/runs/70/job/7") ||
		st.LastSuccess.SHA != harnessSHA || st.StartedAt.IsZero() || st.FinishedAt.IsZero() {
		t.Errorf("status = %+v", st)
	}
	if !strings.Contains(st.OutputTail, "Build complete") {
		t.Errorf("output tail = %q", st.OutputTail)
	}
	if h.restarts.Load() != 1 {
		t.Errorf("restarts = %d, want 1", h.restarts.Load())
	}
}

func TestDeployStopsAtTheFirstFailureAndNothingLaterRuns(t *testing.T) {
	boom := errors.New("exit status 1")
	cases := []struct {
		name    string
		arrange func(h *deployHarness)
		ran     int // how many of fullRun's steps ran (polls collapsed)
		state   string
		errHas  string
	}{
		{"fetch fails", func(h *deployHarness) { h.fail["git fetch"] = cmdResult{"fatal: unable to access\n", boom} }, 1, deployFailed, "git fetch"},
		{"tip cannot be pinned", func(h *deployHarness) { h.fail["git rev-parse"] = cmdResult{"fatal: bad revision\n", boom} }, 2, deployFailed, "pin fetched tip"},
		{"tip is not a sha", func(h *deployHarness) { h.sha = "not-a-sha" }, 2, deployFailed, "unexpected output"},
		{"signature fails (web-flow)", func(h *deployHarness) {
			h.sha = webFlowSHA
			h.fail["git verify-commit"] = cmdResult{incidentLog, boom}
		}, 3, deployRefused, "web-flow"},
		{"remote unreadable", func(h *deployHarness) { h.fail["git remote"] = cmdResult{"fatal: no such remote\n", boom} }, 4, deployRefused, "DEPLOY_REPO"},
		{"CI is red", func(h *deployHarness) {
			h.gate = func(n int, w http.ResponseWriter, r *http.Request) {
				writeRuns(w, runJSON(7, "test", "completed", "failure"))
			}
		}, 5, deployRefused, `concluded "failure"`},
		{"CI never registers", func(h *deployHarness) {
			h.gate = func(n int, w http.ResponseWriter, r *http.Request) { writeRuns(w) }
		}, 5, deployRefused, "no check run named"},
		{"GitHub is down", func(h *deployHarness) {
			h.gate = func(n int, w http.ResponseWriter, r *http.Request) { http.Error(w, "down", 503) }
		}, 5, deployRefused, "gave up"},
		{"merge fails", func(h *deployHarness) { h.fail["git merge"] = cmdResult{"fatal: Not possible to fast-forward\n", boom} }, 6, deployFailed, "fast-forward"},
		{"copy fails", func(h *deployHarness) { h.fail["bash"] = cmdResult{"cp: error\n", boom} }, 7, deployFailed, "copy public assets"},
		{"build fails", func(h *deployHarness) { h.fail["go build"] = cmdResult{"./x.go:1: syntax error\n", boom} }, 8, deployFailed, "go build"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			c.arrange(h)
			job := h.deploy(false)
			if job.err == nil {
				t.Fatalf("expected a failure\n%s", job.out.String())
			}
			want := fullRun(h.sha)
			got := collapse(h.log())
			if len(got) != c.ran {
				t.Errorf("ran %d steps, want %d:\n%s", len(got), c.ran, strings.Join(got, "\n"))
			}
			for i := range got {
				if i < len(want) && got[i] != want[i] {
					t.Errorf("step %d = %q, want %q", i, got[i], want[i])
				}
			}
			for _, e := range got {
				if c.ran < 6 && strings.HasPrefix(e, "git merge") {
					t.Errorf("a refused deploy must not touch the checkout, yet ran %q", e)
				}
			}
			st := h.status()
			if st.State != c.state {
				t.Errorf("state = %q, want %q (error %q)", st.State, c.state, st.Error)
			}
			if !strings.Contains(st.Error, c.errHas) {
				t.Errorf("error %q lacks %q", st.Error, c.errHas)
			}
			if st.FinishedAt.IsZero() || st.OutputTail == "" {
				t.Errorf("a failed attempt still records when it ended and what it printed: %+v", st)
			}
			if (c.state == deployRefused) != (asRefusalOrNil(job.err) != nil) {
				t.Errorf("refusal typing: state %q but err %T", c.state, job.err)
			}
			if h.restarts.Load() != 0 {
				t.Errorf("a deploy that did not build must not restart the service")
			}
			if st.LastSuccess.SHA != "" {
				t.Errorf("last_success must stay empty when nothing succeeded: %+v", st.LastSuccess)
			}
		})
	}
}

// collapse folds a run of identical consecutive entries (the gate's polls).
func collapse(log []string) []string {
	var out []string
	for _, e := range log {
		if len(out) == 0 || out[len(out)-1] != e {
			out = append(out, e)
		}
	}
	return out
}

func asRefusalOrNil(err error) *deployRefusal {
	var r *deployRefusal
	if errors.As(err, &r) {
		return r
	}
	return nil
}

func TestRefusedGateIsRecordedInTheStatus(t *testing.T) {
	h := newHarness(t)
	h.gate = func(n int, w http.ResponseWriter, r *http.Request) {
		writeRuns(w, runJSON(7, "test", "completed", "failure"))
	}
	h.deploy(false)
	st := h.status()
	if st.CIGate != "refused" || !strings.Contains(st.CIRunURL, "/actions/runs/70/job/7") || st.Step != "ci-gate" {
		t.Errorf("status = %+v", st)
	}
	if !strings.Contains(st.OutputTail, "ci-gate:") {
		t.Errorf("the decision should be in the deploy output:\n%s", st.OutputTail)
	}
}

func TestSignatureCheckIsNotAffectedByTheGateSettings(t *testing.T) {
	for name, arrange := range map[string]func(h *deployHarness, skip *bool){
		"skip_ci=1":           func(h *deployHarness, skip *bool) { *skip = true },
		"DEPLOY_REQUIRE_CI=0": func(h *deployHarness, skip *bool) { h.env["DEPLOY_REQUIRE_CI"] = "0" },
		"both":                func(h *deployHarness, skip *bool) { *skip = true; h.env["DEPLOY_REQUIRE_CI"] = "0" },
	} {
		t.Run(name, func(t *testing.T) {
			h := newHarness(t)
			h.sha = webFlowSHA
			h.fail["git verify-commit"] = cmdResult{incidentLog, errors.New("exit status 1")}
			skip := false
			arrange(h, &skip)
			job := h.deploy(skip)
			asRefusal(t, job.err)
			got := h.log()
			if want := []string{"git fetch origin main", "git rev-parse --verify FETCH_HEAD^{commit}", "git verify-commit " + webFlowSHA}; strings.Join(got, "|") != strings.Join(want, "|") {
				t.Errorf("sequence = %q", got)
			}
			if h.status().State != deployRefused {
				t.Errorf("state = %q", h.status().State)
			}
		})
	}
}

func TestSkipCISkipsOnlyTheGate(t *testing.T) {
	h := newHarness(t)
	// A red build: without skip_ci this deploy would be refused.
	h.gate = func(n int, w http.ResponseWriter, r *http.Request) {
		writeRuns(w, runJSON(7, "test", "completed", "failure"))
	}
	job := h.deploy(true)
	if job.err != nil {
		t.Fatalf("skip_ci deploy failed: %v", job.err)
	}
	want := []string{
		"git fetch origin main",
		"git rev-parse --verify FETCH_HEAD^{commit}",
		"git verify-commit " + harnessSHA, // still verified
		"git merge --ff-only " + harnessSHA,
		"bash -c rm -rf internal/static/public && cp -r public internal/static/",
		"go build -o bin/webserver ./cmd/webserver",
	}
	if got := h.log(); strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("sequence:\n%s", strings.Join(got, "\n"))
	}
	if h.api.hitCount() != 0 {
		t.Errorf("the API was queried %d times despite skip_ci", h.api.hitCount())
	}
	st := h.status()
	if st.CIGate != "skipped" || st.State != deploySucceeded {
		t.Errorf("status = %+v", st)
	}
	if !strings.Contains(job.out.String(), "SKIPPED by skip_ci=1") {
		t.Errorf("the skip must be loud in the output:\n%s", job.out.String())
	}
}

func TestRequireCIOffDisablesTheGateForTheBox(t *testing.T) {
	h := newHarness(t)
	h.env["DEPLOY_REQUIRE_CI"] = "0"
	h.gate = func(n int, w http.ResponseWriter, r *http.Request) {
		writeRuns(w, runJSON(7, "test", "completed", "failure"))
	}
	job := h.deploy(false)
	if job.err != nil {
		t.Fatal(job.err)
	}
	if h.api.hitCount() != 0 {
		t.Errorf("API queried %d times with the gate off", h.api.hitCount())
	}
	st := h.status()
	if st.CIGate != "disabled" || !strings.Contains(job.out.String(), "DISABLED by DEPLOY_REQUIRE_CI=0") {
		t.Errorf("status %+v\n%s", st, job.out.String())
	}
}

func TestGateConfigurationReachesTheGate(t *testing.T) {
	h := newHarness(t)
	h.env["DEPLOY_REPO"] = "pflow-xyz/pflow-xyz"
	h.env["DEPLOY_CI_CHECK"] = "build"
	h.env["DEPLOY_GITHUB_TOKEN"] = "tok"
	h.gate = func(n int, w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("check_name") != "build" || r.Header.Get("Authorization") != "Bearer tok" {
			t.Errorf("request = %s %v", r.URL, r.Header)
		}
		writeRuns(w, runJSON(7, "build", "completed", "success"))
	}
	job := h.deploy(false)
	if job.err != nil {
		t.Fatal(job.err)
	}
	for _, e := range h.log() {
		if strings.HasPrefix(e, "git remote") {
			t.Errorf("DEPLOY_REPO is set; the remote must not be consulted (ran %q)", e)
		}
	}
}

func TestOriginRemoteURLIsNeverEchoed(t *testing.T) {
	h := newHarness(t)
	h.remote = "https://deploy:ghp_SECRETTOKEN@github.com/pflow-xyz/pflow-xyz.git\n"
	dir := t.TempDir()
	h.d.configure(dir)
	job := h.deploy(false)
	if job.err != nil {
		t.Fatal(job.err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "deploy-status.json"))
	if err != nil {
		t.Fatal(err)
	}
	for name, text := range map[string]string{"deploy output": job.out.String(), "status file": string(b), "status": fmt.Sprint(h.status())} {
		if strings.Contains(text, "SECRETTOKEN") {
			t.Errorf("%s leaks the remote's credentials", name)
		}
	}
}

func TestConfigWarningsReachTheOutput(t *testing.T) {
	h := newHarness(t)
	h.env["DEPLOY_CI_POLL"] = "often"
	job := h.deploy(false)
	if !strings.Contains(job.out.String(), `warning: DEPLOY_CI_POLL="often"`) {
		t.Errorf("output:\n%s", job.out.String())
	}
}

// ---- Single flight ---------------------------------------------------------

func TestOneDeployAtATimeAndABurstQueuesExactlyOneFollowUp(t *testing.T) {
	h := newHarness(t)
	h.blockFetch, h.fetchSeen = make(chan struct{}), make(chan struct{})

	a, queued := h.d.submit("webhook", "sha-a", false)
	if queued {
		t.Fatal("the first request must start a run")
	}
	<-h.fetchSeen // A is inside its first command and holds the single flight

	b, qb := h.d.submit("webhook", "sha-b", false)
	c, qc := h.d.submit("webhook", "sha-c", false)
	d, qd := h.d.submit("webhook", "sha-d", false)
	if !qb || !qc || !qd {
		t.Fatalf("requests during a run must queue (got %v %v %v)", qb, qc, qd)
	}
	if b != c || c != d || b == a {
		t.Fatal("a burst must share one follow-up job, distinct from the running one")
	}
	if st := h.d.snapshot(); !st.Queued || st.State != deployRunning {
		t.Errorf("status during the run = %+v", st)
	}
	if n := countPrefix(h.log(), "git fetch"); n != 1 {
		t.Fatalf("%d fetches while A runs: the queued requests must not have started anything", n)
	}

	close(h.blockFetch)
	h.wait()

	if a.err != nil || b.err != nil {
		t.Fatalf("errors: %v / %v", a.err, b.err)
	}
	if n := countPrefix(h.log(), "git fetch"); n != 2 {
		t.Errorf("fetches = %d, want 2 (the run and one follow-up)", n)
	}
	h.mu.Lock()
	maxLive := h.maxLive
	h.mu.Unlock()
	if maxLive != 1 {
		t.Errorf("%d commands ran at once; deploys must never overlap", maxLive)
	}
	if h.restarts.Load() != 1 {
		t.Errorf("restarts = %d: the box restarts once, after the queue is empty", h.restarts.Load())
	}
	st := h.status()
	if st.AnnouncedSHA != "sha-d" || st.Queued {
		t.Errorf("the follow-up should carry the latest push, got %+v", st)
	}
}

func countPrefix(log []string, prefix string) int {
	n := 0
	for _, e := range log {
		if strings.HasPrefix(e, prefix) {
			n++
		}
	}
	return n
}

func TestQueuedRequestsSkipTheGateOnlyIfAllOfThemAsk(t *testing.T) {
	cases := []struct {
		name  string
		first []bool
		want  bool
	}{
		{"all skip", []bool{true, true}, true},
		{"webhook after a manual skip", []bool{true, false}, false},
		{"manual skip after a webhook", []bool{false, true}, false},
		{"none skip", []bool{false, false}, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			h := newHarness(t)
			h.blockFetch, h.fetchSeen = make(chan struct{}), make(chan struct{})
			h.d.submit("webhook", "a", false)
			<-h.fetchSeen
			var next *deployJob
			for _, s := range c.first {
				next, _ = h.d.submit("admin", "", s)
			}
			if next.skipCI != c.want {
				t.Errorf("follow-up skipCI = %v, want %v", next.skipCI, c.want)
			}
			close(h.blockFetch)
			h.wait()
		})
	}
}

func TestADeployAfterIdleStartsImmediately(t *testing.T) {
	h := newHarness(t)
	h.deploy(false)
	h.deploy(false) // would fail the "expected the deploy to start at once" check if it queued
	if n := countPrefix(h.log(), "git fetch"); n != 2 {
		t.Errorf("fetches = %d", n)
	}
	if h.restarts.Load() != 2 {
		t.Errorf("restarts = %d", h.restarts.Load())
	}
}

func TestAFailedFollowUpStillRestartsForTheRunThatBuilt(t *testing.T) {
	h := newHarness(t)
	h.blockFetch, h.fetchSeen = make(chan struct{}), make(chan struct{})
	h.d.submit("webhook", "a", false)
	<-h.fetchSeen
	// The follow-up will be refused by CI; the first run already built.
	calls := 0
	h.gate = func(n int, w http.ResponseWriter, r *http.Request) {
		calls++
		if calls == 1 {
			writeRuns(w, runJSON(7, "test", "completed", "success"))
			return
		}
		writeRuns(w, runJSON(8, "test", "completed", "failure"))
	}
	next, _ := h.d.submit("webhook", "b", false)
	close(h.blockFetch)
	h.wait()
	if asRefusalOrNil(next.err) == nil {
		t.Fatalf("follow-up err = %v", next.err)
	}
	if h.restarts.Load() != 1 {
		t.Errorf("restarts = %d: the first run's binary is on disk and should go live", h.restarts.Load())
	}
	st := h.status()
	if st.State != deployRefused || st.LastSuccess.SHA != harnessSHA {
		t.Errorf("last attempt refused, last success kept: %+v", st)
	}
}

func TestAPanicInThePipelineIsAFailureNotACrash(t *testing.T) {
	h := newHarness(t)
	h.panicOn = "git verify-commit"
	job := h.deploy(false)
	if job.err == nil || !strings.Contains(job.err.Error(), "panicked") {
		t.Fatalf("err = %v", job.err)
	}
	if st := h.status(); st.State != deployFailed {
		t.Errorf("state = %q", st.State)
	}
	h.panicOn = ""
	if job := h.deploy(false); job.err != nil {
		t.Errorf("the deployer must recover and run the next deploy: %v", job.err)
	}
}

// ---- Status file -----------------------------------------------------------

func TestStatusFileRecordsEveryAttemptAndSurvivesARestart(t *testing.T) {
	dir := t.TempDir()
	h := newHarness(t)
	h.d.configure(dir)
	path := filepath.Join(dir, "deploy-status.json")

	if job := h.deploy(false); job.err != nil {
		t.Fatal(job.err)
	}
	var onDisk deployStatus
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &onDisk); err != nil {
		t.Fatalf("status file is not JSON: %v\n%s", err, b)
	}
	if onDisk.State != deploySucceeded || onDisk.SHA != harnessSHA || onDisk.LastSuccess.SHA != harnessSHA || onDisk.OutputTail == "" {
		t.Errorf("file = %+v", onDisk)
	}
	if fi, _ := os.Stat(path); fi == nil || fi.Mode().Perm() != 0o600 {
		t.Errorf("status file mode = %v", fi)
	}
	if _, err := os.Stat(path + ".tmp"); err == nil {
		t.Error("temp file left behind")
	}

	// A refused attempt replaces the last attempt but not the last success.
	h.sha = webFlowSHA
	h.fail["git verify-commit"] = cmdResult{incidentLog, errors.New("exit status 1")}
	h.deploy(false)

	// "Restart": a new process reads the file.
	h2 := newHarness(t)
	h2.d.configure(dir)
	st := h2.status()
	if st.State != deployRefused || st.SHA != webFlowSHA || st.LastSuccess.SHA != harnessSHA || !strings.Contains(st.Error, "web-flow") {
		t.Errorf("reloaded status = %+v", st)
	}
}

func TestInterruptedRunIsReportedAsFailedAfterARestart(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "deploy-status.json"), []byte(`{"state":"running","sha":"abc","queued":true}`), 0o600)
	h := newHarness(t)
	h.d.configure(dir)
	st := h.status()
	if st.State != deployFailed || !strings.Contains(st.Error, "interrupted") || st.SHA != "abc" || st.Queued {
		t.Errorf("status = %+v", st)
	}
}

func TestUnreadableStatusFileIsIgnored(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "deploy-status.json"), []byte(`{not json`), 0o600)
	h := newHarness(t)
	h.d.configure(dir)
	if st := h.status(); st.State != deployIdle {
		t.Errorf("state = %q", st.State)
	}
	if job := h.deploy(false); job.err != nil { // and it is overwritten by the next attempt
		t.Fatal(job.err)
	}
	var st deployStatus
	b, _ := os.ReadFile(filepath.Join(dir, "deploy-status.json"))
	if err := json.Unmarshal(b, &st); err != nil || st.State != deploySucceeded {
		t.Errorf("file = %s (%v)", b, err)
	}
}

func TestStatusWithoutADataDirIsMemoryOnly(t *testing.T) {
	h := newHarness(t)
	h.d.configure("")
	if job := h.deploy(false); job.err != nil {
		t.Fatal(job.err)
	}
	if st := h.status(); st.State != deploySucceeded {
		t.Errorf("state = %q", st.State)
	}
}

// ---- Handlers --------------------------------------------------------------

func signedWebhook(secret, body string) *http.Request {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(body))
	r := httptest.NewRequest("POST", "/webhook/github", strings.NewReader(body))
	r.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	return r
}

func TestWebhookHandler(t *testing.T) {
	t.Setenv("DEPLOY_SECRET", "s3cret")
	h := newHarness(t)
	mainPush := `{"ref":"refs/heads/main","after":"` + harnessSHA + `"}`

	serve := func(r *http.Request) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.d.handleWebhook(w, r)
		return w
	}

	if w := serve(httptest.NewRequest("POST", "/webhook/github", strings.NewReader(mainPush))); w.Code != http.StatusForbidden {
		t.Errorf("unsigned delivery: %d", w.Code)
	}
	bad := signedWebhook("wrong", mainPush)
	if w := serve(bad); w.Code != http.StatusForbidden {
		t.Errorf("badly signed delivery: %d", w.Code)
	}
	if w := serve(signedWebhook("s3cret", `{"ref":"refs/heads/feature"}`)); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), "ignored") {
		t.Errorf("other branch: %d %q", w.Code, w.Body)
	}
	if w := serve(signedWebhook("s3cret", `{"zen":"ping"}`)); w.Code != http.StatusOK {
		t.Errorf("ping: %d", w.Code)
	}
	if w := serve(signedWebhook("s3cret", `not json`)); w.Code != http.StatusBadRequest {
		t.Errorf("bad json: %d", w.Code)
	}
	if h.d.snapshot().State != deployIdle || len(h.log()) != 0 {
		t.Fatalf("none of the above may start a deploy: %v", h.log())
	}

	h.blockFetch, h.fetchSeen = make(chan struct{}), make(chan struct{})
	w := serve(signedWebhook("s3cret", mainPush))
	if w.Code != http.StatusAccepted || w.Body.String() != "deploy started" {
		t.Errorf("first delivery: %d %q", w.Code, w.Body)
	}
	<-h.fetchSeen
	w = serve(signedWebhook("s3cret", `{"ref":"refs/heads/main","after":"later"}`))
	if w.Code != http.StatusAccepted || w.Body.String() != "deploy queued behind a running deploy" {
		t.Errorf("second delivery: %d %q", w.Code, w.Body)
	}
	close(h.blockFetch)
	h.wait()
	if st := h.status(); st.AnnouncedSHA != "later" || st.Trigger != "webhook" || st.State != deploySucceeded {
		t.Errorf("status = %+v", st)
	}
}

func TestWebhookNotConfigured(t *testing.T) {
	t.Setenv("DEPLOY_SECRET", "")
	h := newHarness(t)
	w := httptest.NewRecorder()
	h.d.handleWebhook(w, httptest.NewRequest("POST", "/webhook/github", strings.NewReader(`{}`)))
	if w.Code != http.StatusServiceUnavailable {
		t.Errorf("code = %d", w.Code)
	}
}

func TestDeployStatusEndpointNeedsTheToken(t *testing.T) {
	h := newHarness(t)
	get := func(secret string, mod func(r *http.Request)) *httptest.ResponseRecorder {
		t.Setenv("DEPLOY_SECRET", secret)
		r := httptest.NewRequest("GET", "/admin/deploy-status", nil)
		if mod != nil {
			mod(r)
		}
		w := httptest.NewRecorder()
		h.d.handleDeployStatus(w, r)
		return w
	}
	withHeader := func(v string) func(*http.Request) { return func(r *http.Request) { r.Header.Set("X-Deploy-Token", v) } }

	if w := get("s3cret", nil); w.Code != http.StatusUnauthorized {
		t.Errorf("no token: %d", w.Code)
	}
	if w := get("s3cret", withHeader("nope")); w.Code != http.StatusUnauthorized {
		t.Errorf("wrong token: %d", w.Code)
	}
	if w := get("s3cret", func(r *http.Request) { r.URL.RawQuery = "token=nope" }); w.Code != http.StatusUnauthorized {
		t.Errorf("wrong query token: %d", w.Code)
	}
	if w := get("", withHeader("")); w.Code != http.StatusUnauthorized {
		t.Errorf("unconfigured secret must lock the endpoint, got %d", w.Code)
	}
	for _, w := range []*httptest.ResponseRecorder{get("s3cret", nil), get("s3cret", withHeader("nope"))} {
		if strings.Contains(w.Body.String(), "state") {
			t.Errorf("an unauthorised response leaked status: %s", w.Body)
		}
	}

	runningBuildSave := runningBuild
	defer func() { runningBuild = runningBuildSave }()
	runningBuild = func() buildInfo { return buildInfo{Revision: "abc123", Time: "2026-10-28T21:31:00Z"} }

	w := get("s3cret", withHeader("s3cret"))
	if w.Code != http.StatusOK || w.Header().Get("Content-Type") != "application/json" || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("authorised: %d %v", w.Code, w.Header())
	}
	var idle struct {
		State        string    `json:"state"`
		Queued       bool      `json:"queued"`
		RunningBuild buildInfo `json:"running_build"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &idle); err != nil || idle.State != "idle" || idle.RunningBuild.Revision != "abc123" {
		t.Errorf("idle body = %s (%v)", w.Body, err)
	}

	if w := get("s3cret", func(r *http.Request) { r.URL.RawQuery = "token=s3cret" }); w.Code != http.StatusOK {
		t.Errorf("query token: %d", w.Code)
	}

	h.sha = webFlowSHA
	h.fail["git verify-commit"] = cmdResult{incidentLog, errors.New("exit status 1")}
	h.deploy(false)
	w = get("s3cret", withHeader("s3cret"))
	var st map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil {
		t.Fatal(err)
	}
	if st["state"] != "refused" || st["sha"] != webFlowSHA || st["step"] != "verify" || !strings.Contains(fmt.Sprint(st["error"]), "web-flow") ||
		!strings.Contains(fmt.Sprint(st["output_tail"]), "No public key") || st["started_at"] == nil || st["finished_at"] == nil || st["trigger"] != "webhook" {
		t.Errorf("status body = %s", w.Body)
	}
}

func TestAdminDeployHandler(t *testing.T) {
	t.Setenv("DEPLOY_SECRET", "s3cret")
	h := newHarness(t)
	post := func(url, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", url, nil)
		if token != "" {
			r.Header.Set("X-Deploy-Token", token)
		}
		w := httptest.NewRecorder()
		h.d.handleAdminDeploy(w, r)
		h.wait()
		return w
	}

	for _, url := range []string{"/admin/deploy", "/admin/deploy?skip_ci=1"} {
		if w := post(url, ""); w.Code != http.StatusUnauthorized {
			t.Errorf("%s without a token: %d", url, w.Code)
		}
		if w := post(url, "wrong"); w.Code != http.StatusUnauthorized {
			t.Errorf("%s with a wrong token: %d", url, w.Code)
		}
	}
	if len(h.log()) != 0 {
		t.Fatalf("an unauthorised request ran %v", h.log())
	}

	// Gated by default: a red CI is reported to the caller.
	h.gate = func(n int, w http.ResponseWriter, r *http.Request) {
		writeRuns(w, runJSON(7, "test", "completed", "failure"))
	}
	w := post("/admin/deploy", "s3cret")
	body := w.Body.String()
	if !strings.Contains(body, "Starting deploy") || !strings.Contains(body, "DEPLOY FAILED") || !strings.Contains(body, `concluded "failure"`) {
		t.Errorf("gated manual deploy:\n%s", body)
	}
	if h.restarts.Load() != 0 {
		t.Error("a refused deploy restarted the service")
	}

	// skip_ci=1 lets the same commit through.
	w = post("/admin/deploy?skip_ci=1", "s3cret")
	body = w.Body.String()
	if !strings.Contains(body, "SKIPPED by skip_ci=1") || !strings.Contains(body, "Deploy succeeded. Scheduling restart in 2s") || strings.Contains(body, "DEPLOY FAILED") {
		t.Errorf("skip_ci manual deploy:\n%s", body)
	}
	if h.restarts.Load() != 1 {
		t.Errorf("restarts = %d", h.restarts.Load())
	}
	if st := h.status(); st.Trigger != "admin" || st.CIGate != "skipped" {
		t.Errorf("status = %+v", st)
	}
}

func TestAdminDeployWaitsItsTurnBehindARunningDeploy(t *testing.T) {
	t.Setenv("DEPLOY_SECRET", "s3cret")
	h := newHarness(t)
	h.blockFetch, h.fetchSeen = make(chan struct{}), make(chan struct{})
	h.d.submit("webhook", "a", false)
	<-h.fetchSeen

	done := make(chan string)
	go func() {
		r := httptest.NewRequest("POST", "/admin/deploy?skip_ci=1", nil)
		r.Header.Set("X-Deploy-Token", "s3cret")
		w := httptest.NewRecorder()
		h.d.handleAdminDeploy(w, r)
		done <- w.Body.String()
	}()
	// The request must be queued, not run: wait until it is, then release.
	deadline := time.Now().Add(5 * time.Second)
	for !h.d.snapshot().Queued {
		if time.Now().After(deadline) {
			t.Fatal("the admin request never queued")
		}
		time.Sleep(time.Millisecond)
	}
	close(h.blockFetch)
	body := <-done
	h.wait()
	if !strings.Contains(body, "already running; this request is queued") || !strings.Contains(body, "Deploy succeeded") {
		t.Errorf("body:\n%s", body)
	}
	if n := countPrefix(h.log(), "git fetch"); n != 2 {
		t.Errorf("fetches = %d", n)
	}
}

// ---- Deployed commit -------------------------------------------------------

func TestReadBuildInfo(t *testing.T) {
	info := &debug.BuildInfo{Settings: []debug.BuildSetting{
		{Key: "-buildmode", Value: "exe"},
		{Key: "vcs", Value: "git"},
		{Key: "vcs.revision", Value: "8d30d96a1b2c3d4e5f60718293a4b5c6d7e8f901"},
		{Key: "vcs.time", Value: "2026-10-28T21:31:00Z"},
		{Key: "vcs.modified", Value: "true"},
	}}
	got := readBuildInfo(info, true)
	if got.Revision != "8d30d96a1b2c3d4e5f60718293a4b5c6d7e8f901" || got.Time != "2026-10-28T21:31:00Z" || !got.Modified {
		t.Errorf("got %+v", got)
	}
	if (readBuildInfo(nil, false) != buildInfo{}) || (readBuildInfo(&debug.BuildInfo{}, true) != buildInfo{}) {
		t.Error("a binary without a VCS stamp reports nothing, not a made-up revision")
	}
}

func TestHealthCarriesTheBuildRevisionInAHeaderNotTheBody(t *testing.T) {
	save := runningBuild
	defer func() { runningBuild = save }()

	runningBuild = func() buildInfo { return buildInfo{Revision: "abc123def"} }
	w := httptest.NewRecorder()
	(&Server{}).ServeHTTP(w, httptest.NewRequest("GET", "/health", nil))
	if w.Code != 200 || w.Body.String() != `{"ok":true}` {
		t.Errorf("/health = %d %q: the body must stay exactly as the monitor expects", w.Code, w.Body)
	}
	if got := w.Header().Get("X-Build-Revision"); got != "abc123def" {
		t.Errorf("X-Build-Revision = %q", got)
	}

	runningBuild = func() buildInfo { return buildInfo{} }
	w = httptest.NewRecorder()
	(&Server{}).ServeHTTP(w, httptest.NewRequest("GET", "/health", nil))
	if _, ok := w.Header()["X-Build-Revision"]; ok {
		t.Error("no revision known, no header")
	}
}

func TestDeployStatusRouteIsRegisteredAndGETOnly(t *testing.T) {
	t.Setenv("DEPLOY_SECRET", "s3cret")
	srv := &Server{}
	for method, want := range map[string]int{"GET": http.StatusUnauthorized} {
		w := httptest.NewRecorder()
		srv.ServeHTTP(w, httptest.NewRequest(method, "/admin/deploy-status", nil))
		if w.Code != want {
			t.Errorf("%s /admin/deploy-status without a token = %d, want %d", method, w.Code, want)
		}
	}
	// POST is not a route of its own; it must not reach the status handler.
	w := httptest.NewRecorder()
	r := httptest.NewRequest("POST", "/admin/deploy-status", nil)
	r.Header.Set("X-Deploy-Token", "s3cret")
	func() {
		defer func() { recover() }() // a nil-storage handler may panic further down; reaching it is the point
		srv.ServeHTTP(w, r)
	}()
	if strings.Contains(w.Body.String(), `"running_build"`) {
		t.Error("POST must not return the deploy status")
	}
}

func TestOutBuf(t *testing.T) {
	var o outBuf
	for i := 0; i < 100; i++ {
		fmt.Fprintf(&o, "line %d\n", i)
	}
	if got := o.Tail(3, 1<<10); got != "line 97\nline 98\nline 99" {
		t.Errorf("tail = %q", got)
	}
	if got := o.Tail(100, 20); !strings.HasPrefix(got, "...") || len(got) != 23 {
		t.Errorf("byte-capped tail = %q", got)
	}
	s, off := o.From(0)
	if !strings.HasPrefix(s, "line 0\n") {
		t.Errorf("From(0) = %q", s[:20])
	}
	fmt.Fprint(&o, "more")
	if s, _ = o.From(off); s != "more" {
		t.Errorf("From(off) = %q", s)
	}
	if s, _ = o.From(1 << 30); s != "" {
		t.Errorf("From(past end) = %q", s)
	}
}
