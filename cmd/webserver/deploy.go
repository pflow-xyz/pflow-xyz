package main

// Push-to-main self-deploy. docs/deploy.md describes the whole pipeline, its
// environment variables and how to diagnose a stuck deploy; this file is the
// mechanism.
//
//	webhook / POST /admin/deploy
//	  -> one deploy at a time (a delivery during a run queues ONE follow-up)
//	  -> git fetch origin main; pin the fetched sha
//	  -> git verify-commit <sha>          (signature; unchanged strictness)
//	  -> CI gate on <sha>                 (deploy_gate.go; fails closed)
//	  -> git merge --ff-only <sha>        (only now does the checkout change)
//	  -> copy public/, go build
//	  -> restart, once the queue is empty
//
// Every attempt is recorded (memory and data/deploy-status.json) and served at
// GET /admin/deploy-status, because the webhook answers 202 before any of it
// runs and GitHub therefore shows every delivery green.

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"time"
)

const deployVersion = "2026-02-07a"

func deploySecret() string {
	return os.Getenv("DEPLOY_SECRET")
}

func workspaceRoot() string {
	if v := os.Getenv("WORKSPACE_ROOT"); v != "" {
		return v
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Workspace")
}

func tmuxSession() string {
	if v := os.Getenv("TMUX_SESSION"); v != "" {
		return v
	}
	return "servers"
}

func serviceName() string {
	if v := os.Getenv("SERVICE_NAME"); v != "" {
		return v
	}
	return "pflow-xyz"
}

// verifyHMAC checks the GitHub X-Hub-Signature-256 header against the request body.
func verifyHMAC(secret string, body []byte, signature string) bool {
	if !strings.HasPrefix(signature, "sha256=") {
		return false
	}
	sig, err := hex.DecodeString(signature[7:])
	if err != nil {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	expected := mac.Sum(nil)
	return hmac.Equal(sig, expected)
}

// checkDeployAuth validates the deploy token from header or query param.
func checkDeployAuth(r *http.Request) bool {
	secret := deploySecret()
	if secret == "" {
		return false
	}
	if token := r.Header.Get("X-Deploy-Token"); token == secret {
		return true
	}
	if token := r.URL.Query().Get("token"); token == secret {
		return true
	}
	return false
}

// ---- Signature failures ----------------------------------------------------

// GitHub's web-flow key signs the commits GitHub itself creates: the merge,
// squash and rebase buttons and edits in the web UI. pflow.dev's keyring holds
// only the owner's keys, so such a tip cannot be verified there until the
// owner imports this key; the deploy never trusts it by itself.
const (
	webFlowKeyID       = "B5690EEEBB952194"
	webFlowFingerprint = "968479A1AFF927E37D1A566BB5690EEEBB952194"
	webFlowImportCmd   = "curl -sL https://github.com/web-flow.gpg | gpg --import"
)

var (
	reGPGUsing   = regexp.MustCompile(`(?m)\busing (\S+) key (?:ID )?([0-9A-Fa-f]{8,40})\b`)
	reNoPubKey   = regexp.MustCompile(`(?i)can't check signature: (?:no public key|public key not found)`)
	reNoPubKeyST = regexp.MustCompile(`\bNO_PUBKEY ([0-9A-Fa-f]{8,40})\b`)
	reBadSig     = regexp.MustCompile(`(?i)\bBAD signature\b|\bBADSIG\b`)
	reNoSig      = regexp.MustCompile(`(?i)\bno signature found\b`)
	reSSHSig     = regexp.MustCompile(`(?i)No principal matched|Could not verify signature|allowedSignersFile`)
)

// verifyDiagnosis is what the output of a failed `git verify-commit` says.
type verifyDiagnosis struct {
	Kind    string // no-public-key, bad-signature, unsigned, ssh-untrusted, unknown
	KeyAlgo string // "RSA", "EDDSA", ... as gpg prints it
	KeyID   string // as printed: 16 hex digits for gpg 2.x
	WebFlow bool   // KeyID is GitHub's web-flow key
}

// isWebFlowKey reports whether id (a key id of 8 to 40 hex digits, or a full
// fingerprint) names GitHub's web-flow key.
func isWebFlowKey(id string) bool {
	id = strings.ToUpper(strings.TrimSpace(id))
	return len(id) >= 8 && strings.HasSuffix(webFlowFingerprint, id)
}

// diagnoseVerify classifies the combined output of `git verify-commit`. It is a
// pure function of the text so it can be tested against real output.
func diagnoseVerify(output string) verifyDiagnosis {
	d := verifyDiagnosis{Kind: "unknown"}
	if m := reGPGUsing.FindStringSubmatch(output); m != nil {
		d.KeyAlgo, d.KeyID = m[1], strings.ToUpper(m[2])
	}
	switch {
	case reNoPubKey.MatchString(output):
		d.Kind = "no-public-key"
	case reNoPubKeyST.MatchString(output):
		d.Kind = "no-public-key"
		if d.KeyID == "" {
			d.KeyID = strings.ToUpper(reNoPubKeyST.FindStringSubmatch(output)[1])
		}
	case reBadSig.MatchString(output):
		d.Kind = "bad-signature"
	case reNoSig.MatchString(output):
		d.Kind = "unsigned"
	case reSSHSig.MatchString(output):
		d.Kind = "ssh-untrusted"
	}
	d.WebFlow = d.KeyID != "" && isWebFlowKey(d.KeyID)
	return d
}

// explainVerifyFailure turns a failed verify-commit into the error the deploy
// reports: which commit, which key, and what to do. It names the remedy and
// leaves the decision to the owner.
func explainVerifyFailure(sha, output string) string {
	d := diagnoseVerify(output)
	key := d.KeyID
	if key != "" && d.KeyAlgo != "" {
		key = d.KeyAlgo + " key " + d.KeyID
	} else if key != "" {
		key = "key " + key
	}
	pre := "refusing to deploy " + sha + ": "
	switch d.Kind {
	case "no-public-key":
		if d.WebFlow {
			return pre + "its signature cannot be checked: pflow.dev's keyring has no public key for " + key +
				", which is GitHub's web-flow key (it signs the merge, squash and rebase buttons and web edits). " +
				"The deploy does not trust it by itself; that is a keyring decision for the owner. " +
				"As ubuntu on pflow.dev run `" + webFlowImportCmd + "`, check that `gpg --fingerprint " + webFlowKeyID +
				"` shows " + webFlowFingerprint + ", then redeliver the webhook or POST /admin/deploy (docs/deploy.md)"
		}
		if key == "" {
			return pre + "its signature cannot be checked: the keyring has no public key for the signer (the output named none). If the signer is trusted, import its key with gpg on the box (docs/deploy.md)"
		}
		return pre + "its signature cannot be checked: the keyring has no public key for " + key +
			". If that is a signer you trust, import its public key with gpg on the box, then redeliver the webhook or POST /admin/deploy (docs/deploy.md)"
	case "bad-signature":
		return pre + "its signature is BAD (gpg reports a signature that does not match the commit" + keySuffix(key) + ")"
	case "unsigned":
		return pre + "the commit is not signed (protected main should only carry signed commits)"
	case "ssh-untrusted":
		return pre + "its SSH signature is not from a key in the box's allowed_signers file (gpg.ssh.allowedSignersFile)"
	}
	return pre + "git verify-commit failed" + keySuffix(key) + ": " + lastLines(output, 3)
}

func keySuffix(key string) string {
	if key == "" {
		return ""
	}
	return ", signer " + key
}

// lastLines returns the last n non-empty lines of s joined by " | ".
func lastLines(s string, n int) string {
	var lines []string
	for _, l := range strings.Split(s, "\n") {
		if l = strings.TrimSpace(l); l != "" {
			lines = append(lines, l)
		}
	}
	if len(lines) > n {
		lines = lines[len(lines)-n:]
	}
	if len(lines) == 0 {
		return "no output"
	}
	return strings.Join(lines, " | ")
}

// deployRefusal is a deploy the policy turned away (signature, CI gate), as
// opposed to one that broke. Nothing in the checkout had changed when it was
// returned.
type deployRefusal struct{ msg string }

func (e *deployRefusal) Error() string { return e.msg }

// ---- Output buffer ---------------------------------------------------------

// outBuf is a deploy's output, written by the worker while the admin endpoint
// and the status endpoint read it.
type outBuf struct {
	mu        sync.Mutex
	b         []byte
	truncated bool
}

const outBufMax = 4 << 20

func (o *outBuf) Write(p []byte) (int, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.b)+len(p) > outBufMax {
		if !o.truncated {
			o.truncated = true
			o.b = append(o.b, "\n[output truncated]\n"...)
		}
		return len(p), nil
	}
	o.b = append(o.b, p...)
	return len(p), nil
}

func (o *outBuf) String() string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return string(o.b)
}

// From returns what was written after offset off and the new offset.
func (o *outBuf) From(off int) (string, int) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if off > len(o.b) {
		off = len(o.b)
	}
	return string(o.b[off:]), len(o.b)
}

// Tail returns the last lines of the output, at most maxBytes.
func (o *outBuf) Tail(maxLines, maxBytes int) string {
	s := strings.TrimRight(o.String(), "\n")
	if lines := strings.Split(s, "\n"); len(lines) > maxLines {
		s = strings.Join(lines[len(lines)-maxLines:], "\n")
	}
	if len(s) > maxBytes {
		s = "..." + s[len(s)-maxBytes:]
	}
	return s
}

// ---- Status ----------------------------------------------------------------

const (
	deployIdle      = "idle"      // nothing attempted since the status file began
	deployRunning   = "running"   // an attempt is in progress
	deploySucceeded = "succeeded" // built; a restart follows when the queue empties
	deployFailed    = "failed"    // something broke (fetch, merge, copy, build)
	deployRefused   = "refused"   // policy said no (signature, CI); checkout untouched
)

// deployMark is a successful deploy, kept apart so a later refusal does not
// hide what is actually live.
type deployMark struct {
	SHA        string    `json:"sha"`
	FinishedAt time.Time `json:"finished_at"`
}

// deployStatus is the last deploy attempt. Treat values as immutable: copies
// are handed to other goroutines.
type deployStatus struct {
	State        string     `json:"state"`
	Trigger      string     `json:"trigger,omitempty"`       // webhook | admin
	AnnouncedSHA string     `json:"announced_sha,omitempty"` // what the webhook said was pushed
	SHA          string     `json:"sha,omitempty"`           // what was fetched, verified, gated, merged, built
	Step         string     `json:"step,omitempty"`          // current step, or the one it ended at
	StartedAt    time.Time  `json:"started_at,omitzero"`
	FinishedAt   time.Time  `json:"finished_at,omitzero"`
	Error        string     `json:"error,omitempty"`
	CIGate       string     `json:"ci_gate,omitempty"` // passed | refused | skipped | disabled
	CIRunURL     string     `json:"ci_run_url,omitempty"`
	OutputTail   string     `json:"output_tail,omitempty"`
	Queued       bool       `json:"queued"` // a follow-up deploy is waiting for this one
	LastSuccess  deployMark `json:"last_success,omitzero"`
}

// buildInfo says which commit the running binary was built from.
type buildInfo struct {
	Revision string `json:"revision,omitempty"`
	Time     string `json:"time,omitempty"`
	Modified bool   `json:"modified,omitempty"`
}

// readBuildInfo extracts the VCS stamp `go build` leaves in a binary built
// inside a git checkout. Test binaries and Bazel builds carry none.
func readBuildInfo(info *debug.BuildInfo, ok bool) buildInfo {
	var b buildInfo
	if !ok || info == nil {
		return b
	}
	for _, s := range info.Settings {
		switch s.Key {
		case "vcs.revision":
			b.Revision = s.Value
		case "vcs.time":
			b.Time = s.Value
		case "vcs.modified":
			b.Modified = s.Value == "true"
		}
	}
	return b
}

// runningBuild is the build info of this process; tests replace it.
var runningBuild = func() buildInfo { return readBuildInfo(debug.ReadBuildInfo()) }

// setBuildHeader stamps /health with the commit this binary was built from, so
// "what is deployed" can be compared with GitHub's main from outside. It is a
// header, not a body field: the body stays exactly {"ok":true}, which is what
// the synthetic monitor sees.
func setBuildHeader(w http.ResponseWriter) {
	if b := runningBuild(); b.Revision != "" {
		w.Header().Set("X-Build-Revision", b.Revision)
	}
}

// ---- The deployer ----------------------------------------------------------

// cmdRunner runs one command and returns its combined output.
type cmdRunner func(ctx context.Context, dir string, args ...string) ([]byte, error)

func execRunner(ctx context.Context, dir string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, args[0], args[1:]...)
	cmd.Dir = dir
	return cmd.CombinedOutput()
}

func realSleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// deployJob is one run of the pipeline. A job that is still queued can absorb
// later requests (see submit).
type deployJob struct {
	trigger   string
	announced string
	skipCI    bool
	out       *outBuf
	done      chan struct{} // closed when the run has finished
	err       error         // set before done is closed
}

// deployer owns the deploy pipeline and everything it touches: the single
// flight, the status, and the seams the tests replace (commands, HTTP, clock,
// environment, restart).
type deployer struct {
	getenv     func(string) string
	run        cmdRunner
	httpc      *http.Client
	now        func() time.Time
	sleep      func(ctx context.Context, d time.Duration) error
	restart    func()
	projectDir func() string

	loops      sync.WaitGroup // one per running loop; tests wait on it
	mu         sync.Mutex
	statusPath string // "" = memory only
	running    bool
	cur        *deployJob // the job being executed
	next       *deployJob // the queued follow-up, at most one
	status     deployStatus
}

func newDeployer() *deployer {
	return &deployer{
		getenv:     os.Getenv,
		run:        execRunner,
		httpc:      &http.Client{},
		now:        time.Now,
		sleep:      realSleep,
		restart:    scheduleRestart,
		projectDir: func() string { return filepath.Join(workspaceRoot(), "pflow-xyz") },
		status:     deployStatus{State: deployIdle},
	}
}

// deploys is the process's deployer; the handlers below wrap it.
var deploys = newDeployer()

// configureDeploy points the deployer at the data directory and reloads the
// last recorded attempt, which is how a status survives the restart that
// follows every successful deploy.
func configureDeploy(dataDir string) { deploys.configure(dataDir) }

func (d *deployer) configure(dataDir string) {
	if dataDir == "" {
		return
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	d.statusPath = filepath.Join(dataDir, "deploy-status.json")
	b, err := os.ReadFile(d.statusPath)
	if err != nil {
		return
	}
	var st deployStatus
	if err := json.Unmarshal(b, &st); err != nil {
		log.Printf("[deploy] ignoring unreadable %s: %v", d.statusPath, err)
		return
	}
	if st.State == deployRunning {
		// The process died mid-run (a restart only follows a finished run).
		st.State = deployFailed
		st.Error = "interrupted: the server stopped while this deploy was running"
	}
	st.Queued = false
	d.status = st
}

// persistLocked writes the status file; d.mu must be held.
func (d *deployer) persistLocked() {
	if d.statusPath == "" {
		return
	}
	b, err := json.MarshalIndent(d.status, "", "  ")
	if err == nil {
		err = os.MkdirAll(filepath.Dir(d.statusPath), 0o755)
	}
	if err == nil {
		tmp := d.statusPath + ".tmp"
		if err = os.WriteFile(tmp, append(b, '\n'), 0o600); err == nil {
			err = os.Rename(tmp, d.statusPath)
		}
	}
	if err != nil {
		log.Printf("[deploy] cannot record status in %s: %v", d.statusPath, err)
	}
}

// snapshot returns the status with its live parts filled in.
func (d *deployer) snapshot() deployStatus {
	d.mu.Lock()
	s := d.status
	s.Queued = d.next != nil
	cur := d.cur
	d.mu.Unlock()
	if s.State == deployRunning && cur != nil {
		s.OutputTail = cur.out.Tail(40, 8<<10)
	}
	return s
}

func (d *deployer) update(f func(s *deployStatus), persist bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	f(&d.status)
	if persist {
		d.persistLocked()
	}
}

// submit asks for a deploy. If none is running, one starts at once. If one is
// running, the request joins a single queued follow-up (created if absent), so
// a burst of deliveries costs one extra run, not one each and not none: the
// follow-up fetches whatever main is when it starts, so the latest push wins.
// If the requests disagree about skipping the CI gate, the gate stays on.
func (d *deployer) submit(trigger, announced string, skipCI bool) (job *deployJob, queued bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if d.running {
		if d.next == nil {
			d.next = &deployJob{trigger: trigger, announced: announced, skipCI: skipCI, out: &outBuf{}, done: make(chan struct{})}
		} else {
			d.next.trigger = trigger
			if announced != "" {
				d.next.announced = announced
			}
			d.next.skipCI = d.next.skipCI && skipCI
		}
		return d.next, true
	}
	job = &deployJob{trigger: trigger, announced: announced, skipCI: skipCI, out: &outBuf{}, done: make(chan struct{})}
	d.running, d.cur = true, job
	d.loops.Add(1)
	go d.loop(job)
	return job, false
}

// loop runs jobs one after another until the queue is empty, then restarts the
// service once if any of them built a new binary. Restarting between jobs would
// kill the process and with it the queued follow-up.
func (d *deployer) loop(job *deployJob) {
	defer d.loops.Done()
	built := false
	for job != nil {
		d.execute(job)
		built = built || job.err == nil
		d.mu.Lock()
		next := d.next
		d.next, d.cur = nil, next
		// While a restart is pending the flight stays taken: a delivery in that
		// window queues rather than starting a build the exit would cut off.
		if next == nil && !built {
			d.running = false
		}
		d.mu.Unlock()
		if next == nil && built {
			built = false
			if d.restart != nil {
				d.restart() // exits the process; returns only if the restart failed
			}
			d.mu.Lock()
			next = d.next
			d.next, d.cur = nil, next
			if next == nil {
				d.running = false
			}
			d.mu.Unlock()
		}
		job = next
	}
}

// execute runs one job and records its outcome.
func (d *deployer) execute(job *deployJob) {
	started := d.now().UTC()
	d.update(func(s *deployStatus) {
		*s = deployStatus{State: deployRunning, Trigger: job.trigger, AnnouncedSHA: job.announced,
			StartedAt: started, LastSuccess: s.LastSuccess}
	}, true)
	log.Printf("[deploy] starting (%s)", job.trigger)

	var err error
	func() {
		defer func() {
			if r := recover(); r != nil {
				err = fmt.Errorf("deploy panicked: %v", r)
			}
		}()
		cfg, warns := deployConfigFromEnv(d.getenv)
		for _, w := range warns {
			fmt.Fprintf(job.out, "warning: %s\n", w)
		}
		err = d.pipeline(context.Background(), job, cfg)
	}()

	finished := d.now().UTC()
	var refusal *deployRefusal
	d.update(func(s *deployStatus) {
		s.FinishedAt = finished
		s.OutputTail = job.out.Tail(40, 8<<10)
		switch {
		case err == nil:
			s.State, s.Error = deploySucceeded, ""
			s.LastSuccess = deployMark{SHA: s.SHA, FinishedAt: finished}
		case errors.As(err, &refusal):
			s.State, s.Error = deployRefused, err.Error()
		default:
			s.State, s.Error = deployFailed, err.Error()
		}
	}, true)

	job.err = err
	switch {
	case err == nil:
		log.Printf("[deploy] success, scheduling restart")
	case errors.As(err, &refusal):
		log.Printf("[deploy] refused: %v\n%s", err, job.out.String())
	default:
		log.Printf("[deploy] failed: %v\n%s", err, job.out.String())
	}
	close(job.done)
}

var shaRE = regexp.MustCompile(`^[0-9a-f]{40}(?:[0-9a-f]{24})?$`)

// Per-command limits: with one deploy at a time, a hung command would block
// every later one.
const (
	gitStepTimeout   = 2 * time.Minute
	buildStepTimeout = 15 * time.Minute
)

// pipeline is the deploy proper. The order is the contract: nothing before the
// merge changes the checkout, so a deploy refused by verification or by the CI
// gate leaves the box exactly as it was, and the same pinned sha is verified,
// gated, merged and built.
func (d *deployer) pipeline(ctx context.Context, job *deployJob, cfg deployConfig) error {
	out := job.out
	dir := d.projectDir()

	step := func(name string) { d.update(func(s *deployStatus) { s.Step = name }, false) }
	// do runs one command and echoes it and its output into the deploy output.
	// quiet suppresses the command's output (for output that must not be kept).
	do := func(name, desc string, timeout time.Duration, quiet bool, args ...string) (string, error) {
		step(name)
		fmt.Fprintf(out, "==> %s\n    cd %s && %s\n", desc, dir, strings.Join(args, " "))
		cctx, cancel := context.WithTimeout(ctx, timeout)
		b, err := d.run(cctx, dir, args...)
		cancel()
		if !quiet {
			out.Write(b)
		}
		fmt.Fprintln(out)
		if err != nil {
			return string(b), fmt.Errorf("%s: %w", desc, err)
		}
		return string(b), nil
	}

	// 1. Fetch, then pin the tip. Everything after this names the sha, never
	// the moving origin/main ref.
	if _, err := do("fetch", "git fetch", gitStepTimeout, false, "git", "fetch", "origin", "main"); err != nil {
		return err
	}
	tip, err := do("fetch", "pin fetched tip", gitStepTimeout, false, "git", "rev-parse", "--verify", "FETCH_HEAD^{commit}")
	if err != nil {
		return err
	}
	sha := strings.TrimSpace(tip)
	if !shaRE.MatchString(sha) {
		return fmt.Errorf("pin fetched tip: unexpected output %q", snippet([]byte(tip), 80))
	}
	d.update(func(s *deployStatus) { s.SHA = sha }, true)
	fmt.Fprintf(out, "deploying %s\n\n", sha)

	// 2. Signature, exactly as strict as before: git verify-commit must pass.
	vout, err := do("verify", "verify signature", gitStepTimeout, false, "git", "verify-commit", sha)
	if err != nil {
		return &deployRefusal{explainVerifyFailure(sha, vout) + " [" + err.Error() + "]"}
	}

	// 3. CI gate on the same sha.
	if err := d.runCIGate(ctx, job, cfg, sha, do); err != nil {
		return err
	}

	// 4. Only now does the checkout move.
	if _, err := do("merge", "fast-forward", gitStepTimeout, false, "git", "merge", "--ff-only", sha); err != nil {
		return err
	}
	// Copy public assets to internal/static for embedding
	if _, err := do("copy", "copy public assets", gitStepTimeout, false, "bash", "-c", "rm -rf internal/static/public && cp -r public internal/static/"); err != nil {
		return err
	}
	if _, err := do("build", "go build", buildStepTimeout, false, "go", "build", "-o", "bin/webserver", "./cmd/webserver"); err != nil {
		return err
	}

	step("done")
	fmt.Fprintf(out, "==> Build complete (%s)\n", sha)
	return nil
}

// runCIGate runs the CI gate step of the pipeline for sha and records the
// decision in the output and the status.
func (d *deployer) runCIGate(ctx context.Context, job *deployJob, cfg deployConfig, sha string,
	do func(name, desc string, timeout time.Duration, quiet bool, args ...string) (string, error)) error {
	out := job.out
	d.update(func(s *deployStatus) { s.Step = "ci-gate" }, false)
	decide := func(state string) { d.update(func(s *deployStatus) { s.CIGate = state }, true) }

	switch {
	case !cfg.RequireCI:
		fmt.Fprintf(out, "ci-gate: DISABLED by DEPLOY_REQUIRE_CI=0 on this box; deploying %s without a CI check\n\n", shortSHA(sha))
		decide("disabled")
		return nil
	case job.skipCI:
		fmt.Fprintf(out, "ci-gate: SKIPPED by skip_ci=1 on POST /admin/deploy; deploying %s without a CI check (the signature was still verified)\n\n", shortSHA(sha))
		decide("skipped")
		return nil
	}

	repo := cfg.Repo
	if repo == "" {
		// The remote's URL can carry credentials, so its text is never echoed.
		remote, err := do("ci-gate", "read origin remote", gitStepTimeout, true, "git", "remote", "get-url", "origin")
		if err == nil {
			repo, err = parseGitHubRepo(remote)
		}
		if err != nil {
			decide("refused")
			return &deployRefusal{fmt.Sprintf("refusing to deploy %s: cannot tell which GitHub repository to ask about CI (%v); set DEPLOY_REPO=owner/repo", shortSHA(sha), err)}
		}
	}
	g := &ciGate{
		client:  d.httpc,
		now:     d.now,
		sleep:   d.sleep,
		apiBase: cfg.APIBase,
		token:   cfg.GitHubToken,
		repo:    repo,
		check:   cfg.CICheck,
		poll:    cfg.CIPoll,
		grace:   cfg.CIGrace,
		timeout: cfg.CITimeout,
		logf:    func(format string, a ...any) { fmt.Fprintf(out, format+"\n", a...) },
	}
	runURL, err := g.wait(ctx, sha)
	d.update(func(s *deployStatus) { s.CIRunURL = runURL }, false)
	if err != nil {
		var refusal *deployRefusal
		if errors.As(err, &refusal) {
			decide("refused")
		}
		return err
	}
	decide("passed")
	fmt.Fprintln(out)
	return nil
}

// ---- Handlers --------------------------------------------------------------

func handleWebhook(w http.ResponseWriter, r *http.Request)     { deploys.handleWebhook(w, r) }
func handleAdminDeploy(w http.ResponseWriter, r *http.Request) { deploys.handleAdminDeploy(w, r) }
func handleDeployStatus(w http.ResponseWriter, r *http.Request) {
	deploys.handleDeployStatus(w, r)
}

// handleWebhook handles GitHub push webhook events.
func (d *deployer) handleWebhook(w http.ResponseWriter, r *http.Request) {
	secret := deploySecret()
	if secret == "" {
		http.Error(w, "deploy not configured", http.StatusServiceUnavailable)
		return
	}

	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "failed to read body", http.StatusBadRequest)
		return
	}

	sig := r.Header.Get("X-Hub-Signature-256")
	if !verifyHMAC(secret, body, sig) {
		http.Error(w, "invalid signature", http.StatusForbidden)
		return
	}

	var payload struct {
		Ref   string `json:"ref"`
		After string `json:"after"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		http.Error(w, "invalid JSON", http.StatusBadRequest)
		return
	}

	if payload.Ref != "refs/heads/main" {
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, "ignored: %s", payload.Ref)
		return
	}

	log.Printf("[deploy] webhook triggered for %s", payload.Ref)
	_, queued := d.submit("webhook", payload.After, false)

	// The answer is 202 whatever happens next, so GitHub's delivery list shows
	// green even when the deploy is refused; GET /admin/deploy-status has the
	// outcome.
	w.WriteHeader(http.StatusAccepted)
	if queued {
		fmt.Fprintf(w, "deploy queued behind a running deploy")
		return
	}
	fmt.Fprintf(w, "deploy started")
}

func parseTruthy(v string) bool {
	switch strings.ToLower(strings.TrimSpace(v)) {
	case "1", "true", "yes", "on":
		return true
	}
	return false
}

// handleAdminDeploy handles manual deploy trigger. It streams the deploy's
// output; ?skip_ci=1 skips the CI gate (and only the CI gate: the signature is
// still verified). A deploy already running makes this one wait its turn.
func (d *deployer) handleAdminDeploy(w http.ResponseWriter, r *http.Request) {
	if !checkDeployAuth(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming not supported", http.StatusInternalServerError)
		return
	}

	cfg, _ := deployConfigFromEnv(d.getenv)
	rc := http.NewResponseController(w)
	// The CI gate may wait up to its timeout, then a build follows.
	_ = rc.SetWriteDeadline(time.Now().Add(cfg.CITimeout + cfg.CIGrace + 20*time.Minute))

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.WriteHeader(http.StatusOK)

	write := func(msg string) {
		fmt.Fprint(w, msg)
		flusher.Flush()
	}

	skipCI := parseTruthy(r.URL.Query().Get("skip_ci"))
	job, queued := d.submit("admin", "", skipCI)
	if queued {
		write("A deploy is already running; this request is queued behind it and runs next.\n")
	}
	write("Starting deploy...\n\n")

	// The job belongs to the deployer, not to this request: a client that
	// disconnects does not cancel it.
	off := 0
	tick := time.NewTicker(500 * time.Millisecond)
	defer tick.Stop()
	for finished := false; !finished; {
		select {
		case <-job.done:
			finished = true
		case <-tick.C:
		case <-r.Context().Done():
			return
		}
		var s string
		s, off = job.out.From(off)
		if s != "" {
			write(s)
		}
	}

	if job.err != nil {
		write(fmt.Sprintf("\nDEPLOY FAILED: %v\n", job.err))
		return
	}
	write("\nDeploy succeeded. Scheduling restart in 2s...\n")
}

// handleDeployStatus serves the last deploy attempt as JSON.
func (d *deployer) handleDeployStatus(w http.ResponseWriter, r *http.Request) {
	if !checkDeployAuth(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	resp := struct {
		deployStatus
		RunningBuild buildInfo `json:"running_build"`
	}{d.snapshot(), runningBuild()}
	b, err := json.MarshalIndent(resp, "", "  ")
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(append(b, '\n'))
}

// handleAdminLogs reads recent log output from tmux.
func handleAdminLogs(w http.ResponseWriter, r *http.Request) {
	if !checkDeployAuth(r) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	lines := 100
	if v := r.URL.Query().Get("lines"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			if n > 1000 {
				n = 1000
			}
			lines = n
		}
	}

	target := fmt.Sprintf("%s:%s", tmuxSession(), serviceName())
	cmd := exec.Command("tmux", "capture-pane", "-t", target, "-p", "-S", fmt.Sprintf("-%d", lines))
	out, err := cmd.CombinedOutput()
	if err != nil {
		http.Error(w, fmt.Sprintf("tmux error: %v\n%s", err, out), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(out)
}

// scheduleRestart waits briefly then triggers a service restart and exits.
func scheduleRestart() {
	time.Sleep(2 * time.Second)

	home, _ := os.UserHomeDir()
	servicesScript := filepath.Join(home, "services")

	log.Printf("[deploy] restarting %s via %s", serviceName(), servicesScript)

	cmd := exec.Command("nohup", servicesScript, "restart", serviceName())
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		log.Printf("[deploy] restart failed: %v", err)
		return
	}
	_ = cmd.Process.Release()

	log.Printf("[deploy] exiting for restart")
	os.Exit(0)
}
