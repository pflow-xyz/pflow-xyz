package main

// The CI gate of the push-to-main deploy (see deploy.go and docs/deploy.md).
//
// A signed commit on main is not yet a tested one: the webhook fires on push,
// the GitHub Actions run for the same commit starts at the same moment, and
// before this gate the deploy never looked at it. The gate asks GitHub's
// check-runs API about the exact sha that was fetched and verified, and lets
// the deploy proceed only on a completed, successful check run of the
// configured name. It fails closed: anything it cannot positively establish
// (no run, a failed run, an unreachable API, a timeout) refuses the deploy,
// and a refused deploy has touched nothing in the checkout.

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultCICheck   = "test" // the job name in .github/workflows/test.yml
	defaultCIPoll    = 15 * time.Second
	defaultCIGrace   = 2 * time.Minute
	defaultCITimeout = 15 * time.Minute
	defaultGitHubAPI = "https://api.github.com"

	// The check run that counts is the one GitHub Actions made. A check name is
	// only a label, and a second workflow (or any other app) can use the same
	// one, so the gate asks for this app's runs and checks the answer.
	githubActionsAppID   = 15368
	githubActionsAppSlug = "github-actions"

	// ciHeartbeat is how often a long wait writes a progress line even when
	// nothing changed. The admin endpoint streams the deploy output, and an
	// nginx in front of it drops a response that is silent for 60 seconds.
	ciHeartbeat = 30 * time.Second

	ciRequestTimeout = 20 * time.Second
	ciMaxBody        = 1 << 20

	// Polling backs off: DEPLOY_CI_POLL for the first ciFastFor (when a run
	// registers or the gate learns there is none), twice that until ciSlowAfter,
	// then four times it, never more than a minute (or the poll itself, if that
	// is longer). An unauthenticated client has 60 requests an hour and every
	// poll spends one, ETag or not (see docs/deploy.md).
	ciFastFor   = 2 * time.Minute
	ciSlowAfter = 5 * time.Minute
	ciMaxPoll   = time.Minute

	// ciLowWater is the remaining-request count below which every poll logs it.
	ciLowWater = 10
)

// deployConfig is the deploy's environment-derived settings, read afresh for
// every run so a change in ~/services needs a restart and nothing more.
type deployConfig struct {
	RequireCI   bool          // DEPLOY_REQUIRE_CI; off only for an explicit 0/false/no/off
	CICheck     string        // DEPLOY_CI_CHECK
	CIPoll      time.Duration // DEPLOY_CI_POLL
	CIGrace     time.Duration // DEPLOY_CI_GRACE: how long a check run may take to register
	CITimeout   time.Duration // DEPLOY_CI_TIMEOUT: the whole gate, polling included
	Repo        string        // DEPLOY_REPO (owner/repo); empty = derive from the origin remote
	GitHubToken string        // DEPLOY_GITHUB_TOKEN, optional bearer token
	APIBase     string        // DEPLOY_GITHUB_API
}

// deployConfigFromEnv reads the DEPLOY_* settings. It returns warnings for
// values it could not use (the default is applied) so they reach the deploy
// output instead of vanishing.
func deployConfigFromEnv(getenv func(string) string) (deployConfig, []string) {
	var warns []string
	cfg := deployConfig{
		RequireCI:   true,
		CICheck:     defaultCICheck,
		Repo:        strings.TrimSpace(getenv("DEPLOY_REPO")),
		GitHubToken: strings.TrimSpace(getenv("DEPLOY_GITHUB_TOKEN")),
		APIBase:     defaultGitHubAPI,
	}
	switch strings.ToLower(strings.TrimSpace(getenv("DEPLOY_REQUIRE_CI"))) {
	case "0", "false", "no", "off":
		cfg.RequireCI = false
	}
	if v := strings.TrimSpace(getenv("DEPLOY_CI_CHECK")); v != "" {
		cfg.CICheck = v
	}
	if v := strings.TrimRight(strings.TrimSpace(getenv("DEPLOY_GITHUB_API")), "/"); v != "" {
		cfg.APIBase = v
	}
	dur := func(name string, def time.Duration) time.Duration {
		v := strings.TrimSpace(getenv(name))
		if v == "" {
			return def
		}
		d, err := time.ParseDuration(v)
		if err != nil {
			// A bare number is seconds: DEPLOY_CI_POLL=15.
			if n, nerr := strconv.Atoi(v); nerr == nil {
				d, err = time.Duration(n)*time.Second, nil
			}
		}
		if err != nil || d <= 0 {
			warns = append(warns, fmt.Sprintf("%s=%q is not a positive duration; using %s", name, v, def))
			return def
		}
		return d
	}
	cfg.CIPoll = dur("DEPLOY_CI_POLL", defaultCIPoll)
	cfg.CIGrace = dur("DEPLOY_CI_GRACE", defaultCIGrace)
	cfg.CITimeout = dur("DEPLOY_CI_TIMEOUT", defaultCITimeout)
	return cfg, warns
}

var repoNameRE = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)

// parseGitHubRepo extracts "owner/repo" from a git remote URL: the scp form
// (git@github.com:owner/repo.git) and the URL forms (https://, ssh://).
func parseGitHubRepo(remote string) (string, error) {
	r := strings.TrimSpace(remote)
	var path string
	if i := strings.Index(r, "://"); i >= 0 {
		u, err := url.Parse(r)
		if err != nil {
			return "", fmt.Errorf("cannot parse remote URL %q: %w", remote, err)
		}
		path = u.Path
	} else if i := strings.Index(r, ":"); i >= 0 {
		path = r[i+1:]
	} else {
		path = r
	}
	path = strings.TrimSuffix(strings.Trim(path, "/"), ".git")
	parts := strings.Split(path, "/")
	if len(parts) < 2 {
		return "", fmt.Errorf("remote %q does not look like owner/repo", remote)
	}
	repo := parts[len(parts)-2] + "/" + parts[len(parts)-1]
	if !repoNameRE.MatchString(repo) {
		return "", fmt.Errorf("remote %q does not look like owner/repo", remote)
	}
	return repo, nil
}

// checkRun is the part of a check-run object the gate reads.
type checkRun struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Status     string `json:"status"`
	Conclusion string `json:"conclusion"`
	HTMLURL    string `json:"html_url"`
	App        struct {
		ID   int64  `json:"id"`
		Slug string `json:"slug"`
	} `json:"app"`
	CheckSuite struct {
		ID int64 `json:"id"`
	} `json:"check_suite"`
}

// ciGate polls one commit's check runs. A gate is single use per deploy; it
// keeps the ETag of its last 200 so a repeat poll that nothing answered is a
// 304, which GitHub does not count against the rate limit (the unauthenticated
// limit is 60 requests an hour, and a 15 minute wait at 15 seconds is 60).
type ciGate struct {
	client  *http.Client
	now     func() time.Time
	sleep   func(ctx context.Context, d time.Duration) error
	apiBase string
	token   string
	repo    string // owner/repo
	check   string
	appID   int64  // only check runs of this GitHub App count; 0 = any (tests)
	appSlug string // and its slug must match; "" = any
	poll    time.Duration
	grace   time.Duration
	timeout time.Duration
	logf    func(format string, args ...any) // goes to the deploy output
	onWait  func()                           // called before each sleep: the gate has nothing to decide yet

	etag      string
	cached    []checkRun
	truncated bool
	cacheOK   bool

	rate     rateLimit // from the latest response
	requests int       // requests made
}

// rateLimit is what GitHub's X-RateLimit-* headers said.
type rateLimit struct {
	known     bool
	limit     int
	remaining int
	reset     time.Time
}

func parseRateLimit(h http.Header) rateLimit {
	var r rateLimit
	rem, err1 := strconv.Atoi(h.Get("X-RateLimit-Remaining"))
	reset, err2 := strconv.ParseInt(h.Get("X-RateLimit-Reset"), 10, 64)
	if err1 != nil || err2 != nil {
		return r
	}
	r.known, r.remaining, r.reset = true, rem, time.Unix(reset, 0)
	r.limit, _ = strconv.Atoi(h.Get("X-RateLimit-Limit"))
	return r
}

// interval is how long to sleep before the next poll, given how long the gate
// has been waiting.
func (g *ciGate) interval(elapsed time.Duration) time.Duration {
	d := g.poll
	switch {
	case elapsed >= ciSlowAfter:
		d = 4 * g.poll
	case elapsed >= ciFastFor:
		d = 2 * g.poll
	}
	if max := max(ciMaxPoll, g.poll); d > max {
		d = max
	}
	return d
}

// exhausted reports whether GitHub has said the request budget is used up and
// stays so past deadline: waiting longer cannot help.
func (g *ciGate) exhausted(deadline time.Time) bool {
	return g.rate.known && g.rate.remaining == 0 && g.rate.reset.After(deadline)
}

func (g *ciGate) exhaustedRefusal(short string, deadline time.Time) *deployRefusal {
	fix := "Set DEPLOY_GITHUB_TOKEN on the box (a token with no scopes is enough for this public repository: authenticated requests get 5000 an hour, and an unchanged answer, a 304, costs nothing)"
	if g.token != "" {
		fix = "DEPLOY_GITHUB_TOKEN is set, so its own limit is used up; wait for the reset"
	}
	return &deployRefusal{fmt.Sprintf("refusing to deploy %s: GitHub's API rate limit is used up (%d of %d left) and does not reset until %s, after this gate's deadline (%s), so CI cannot be read. %s, or POST /admin/deploy?skip_ci=1 to override",
		short, g.rate.remaining, g.rate.limit, g.rate.reset.UTC().Format("15:04:05Z"), deadline.UTC().Format("15:04:05Z"), fix)}
}

// gateQuery is the outcome of one API call.
type gateQuery struct {
	runs        []checkRun
	truncated   bool          // GitHub has more matching runs than it sent
	err         error         // retryable: network, 5xx, rate limit, bad body
	fatal       error         // not retryable: bad credentials, unknown repo or sha
	retryAfter  time.Duration // the server's own advice for err
	notModified bool
}

func (g *ciGate) query(ctx context.Context, sha string) gateQuery {
	// filter=all: every attempt, so the gate sees all of a commit's check suites
	// itself instead of trusting GitHub to collapse them.
	u := fmt.Sprintf("%s/repos/%s/commits/%s/check-runs?per_page=100&filter=all&check_name=%s",
		g.apiBase, g.repo, sha, url.QueryEscape(g.check))
	if g.appID != 0 {
		u += "&app_id=" + strconv.FormatInt(g.appID, 10)
	}
	rctx, cancel := context.WithTimeout(ctx, ciRequestTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(rctx, http.MethodGet, u, nil)
	if err != nil {
		return gateQuery{fatal: err}
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "pflow-xyz-deploy")
	if g.token != "" {
		req.Header.Set("Authorization", "Bearer "+g.token)
	}
	if g.etag != "" && g.cacheOK {
		req.Header.Set("If-None-Match", g.etag)
	}
	resp, err := g.client.Do(req)
	if err != nil {
		return gateQuery{err: fmt.Errorf("GitHub API unreachable: %w", err)}
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, ciMaxBody))
	g.requests++
	if r := parseRateLimit(resp.Header); r.known {
		g.rate = r
	}

	switch {
	case resp.StatusCode == http.StatusNotModified:
		if !g.cacheOK {
			g.etag = ""
			return gateQuery{err: fmt.Errorf("GitHub API answered 304 with nothing cached")}
		}
		return gateQuery{runs: g.cached, truncated: g.truncated, notModified: true}
	case resp.StatusCode == http.StatusOK:
		var doc struct {
			TotalCount int        `json:"total_count"`
			CheckRuns  []checkRun `json:"check_runs"`
		}
		if err := json.Unmarshal(body, &doc); err != nil {
			return gateQuery{err: fmt.Errorf("GitHub API sent an unreadable body: %w", err)}
		}
		g.cached, g.cacheOK, g.etag = doc.CheckRuns, true, resp.Header.Get("ETag")
		g.truncated = doc.TotalCount > len(doc.CheckRuns)
		return gateQuery{runs: doc.CheckRuns, truncated: g.truncated}
	case resp.StatusCode == http.StatusUnauthorized:
		return gateQuery{fatal: fmt.Errorf("GitHub API answered 401: DEPLOY_GITHUB_TOKEN is not accepted")}
	case resp.StatusCode == http.StatusNotFound:
		return gateQuery{fatal: fmt.Errorf("GitHub API answered 404: repository %q not found, or it is private and DEPLOY_GITHUB_TOKEN is not set (DEPLOY_REPO overrides the repository)", g.repo)}
	case resp.StatusCode == http.StatusUnprocessableEntity:
		return gateQuery{fatal: fmt.Errorf("GitHub API answered 422: it does not know commit %s (pushed to another remote?)", sha)}
	}
	// Everything else is retried until the gate's own timeout: 5xx, and the 403
	// or 429 of a rate limit, whose headers say how long to wait.
	q := gateQuery{err: fmt.Errorf("GitHub API answered %d %s", resp.StatusCode, snippet(body, 120))}
	if resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests {
		if s := resp.Header.Get("Retry-After"); s != "" {
			if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil && n > 0 {
				q.retryAfter = time.Duration(n) * time.Second
			}
		} else if resp.Header.Get("X-RateLimit-Remaining") == "0" {
			if n, err := strconv.ParseInt(resp.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil {
				if d := time.Unix(n, 0).Sub(g.now()) + time.Second; d > 0 {
					q.retryAfter = d
				}
			}
		}
	}
	return q
}

func snippet(b []byte, n int) string {
	s := strings.Join(strings.Fields(string(b)), " ")
	if len(s) > n {
		s = s[:n] + "..."
	}
	return s
}

// ciVerdict is what a commit's check runs say about the required check.
type ciVerdict struct {
	state   string   // none | pending | failed | passed
	run     checkRun // the run the verdict rests on (the failing or pending one, else the newest)
	ignored int      // runs with the right name that were not made by the pinned app
}

// judge reads a commit's check runs. Only runs of the required name made by the
// pinned GitHub App count: a same-named run from another app or integration is
// ignored (and counted, so the refusal can say so), because otherwise anyone
// able to report a passing check could mask a failing one. A commit can have
// several check suites (a push and a pull_request workflow on the same sha, a
// second workflow with a job of that name); within a suite the newest run is
// the current attempt (a re-run supersedes the failure it re-ran), and EVERY
// suite must succeed. A finished non-success anywhere is final; otherwise any
// run still going keeps the gate waiting.
func (g *ciGate) judge(runs []checkRun) ciVerdict {
	var v ciVerdict
	newest := map[int64]checkRun{} // suite id -> newest run of the required name
	for _, r := range runs {
		if r.Name != g.check {
			continue
		}
		if (g.appID != 0 && r.App.ID != g.appID) || (g.appSlug != "" && r.App.Slug != g.appSlug) {
			v.ignored++
			continue
		}
		if cur, ok := newest[r.CheckSuite.ID]; !ok || r.ID > cur.ID {
			newest[r.CheckSuite.ID] = r
		}
	}
	if len(newest) == 0 {
		v.state = "none"
		return v
	}
	v.state = "passed"
	for _, r := range newest {
		switch {
		case r.Status == "completed" && r.Conclusion == "success":
			if v.state == "passed" && r.ID > v.run.ID {
				v.run = r
			}
		case r.Status != "completed":
			if v.state != "failed" && (v.state != "pending" || r.ID > v.run.ID) {
				v.state, v.run = "pending", r
			}
		default: // finished, and not a success
			if v.state != "failed" || r.ID > v.run.ID {
				v.state, v.run = "failed", r
			}
		}
	}
	return v
}

// wait blocks until the sha's check run succeeds (returning its URL), or
// returns a *deployRefusal. Only a completed run with conclusion "success"
// passes: failure, cancelled, timed_out, action_required, stale, and also
// neutral and skipped (a skipped test is not a passing test) all refuse.
func (g *ciGate) wait(ctx context.Context, sha string) (string, error) {
	short := shortSHA(sha)
	start := g.now()
	deadline := start.Add(g.timeout)
	var graceStart time.Time
	var lastMsg string
	var lastLog time.Time
	last := "no answer from GitHub yet"

	note := func(msg string) {
		now := g.now()
		if msg == lastMsg && now.Sub(lastLog) < ciHeartbeat {
			return
		}
		lastMsg, lastLog = msg, now
		g.logf("ci-gate: %s (waited %s)", msg, now.Sub(start).Round(time.Second))
	}
	timedOut := func() error {
		return &deployRefusal{fmt.Sprintf("refusing to deploy %s: gave up after %s waiting for CI check %q (last: %s); not deployed. POST /admin/deploy?skip_ci=1 to override",
			short, g.timeout, g.check, last)}
	}

	g.logf("ci-gate: waiting for check run %q on %s in %s (poll %s, backing off to %s; grace %s, timeout %s)",
		g.check, short, g.repo, g.poll, g.interval(ciSlowAfter), g.grace, g.timeout)
	var rateLogged bool
	defer func() {
		if g.rate.known {
			g.logf("ci-gate: %d requests to GitHub; rate limit %d of %d left, resets %s", g.requests, g.rate.remaining, g.rate.limit, g.rate.reset.UTC().Format("15:04:05Z"))
		}
	}()
	for {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		q := g.query(ctx, sha)
		if err := ctx.Err(); err != nil {
			return "", err // cancelled mid-request: not an API failure to retry or log
		}
		if g.rate.known && (!rateLogged || g.rate.remaining <= ciLowWater) {
			msg := fmt.Sprintf("GitHub API rate limit: %d of %d left, resets %s", g.rate.remaining, g.rate.limit, g.rate.reset.UTC().Format("15:04:05Z"))
			if !rateLogged && g.token == "" {
				msg += "; unauthenticated, so every poll costs one request (DEPLOY_GITHUB_TOKEN raises the limit and makes an unchanged answer free)"
			}
			rateLogged = true
			note(msg)
		}
		var advice time.Duration
		switch {
		case q.fatal != nil:
			return "", &deployRefusal{fmt.Sprintf("refusing to deploy %s: CI status cannot be read: %v", short, q.fatal)}
		case q.err != nil:
			last = q.err.Error()
			advice = q.retryAfter
			note("retrying: " + last)
		default:
			if graceStart.IsZero() {
				graceStart = g.now()
			}
			if q.truncated {
				return "", &deployRefusal{fmt.Sprintf("refusing to deploy %s: GitHub lists more check runs for this commit than the %d the gate reads, so it cannot tell whether CI passed", short, len(q.runs))}
			}
			v := g.judge(q.runs)
			switch v.state {
			case "none":
				last = fmt.Sprintf("no check run named %q yet", g.check)
				if v.ignored > 0 {
					last += fmt.Sprintf(" from %s (%d of that name from other apps ignored)", g.appDesc(), v.ignored)
				}
				if g.now().Sub(graceStart) >= g.grace {
					return "", &deployRefusal{fmt.Sprintf("refusing to deploy %s: no check run named %q from %s appeared on GitHub within %s%s, so CI is not known to have run (is the workflow triggered by pushes to main, and is the job still named %q? DEPLOY_CI_CHECK names it; POST /admin/deploy?skip_ci=1 overrides)",
						short, g.check, g.appDesc(), g.grace, ignoredNote(v.ignored), g.check)}
				}
				note(last)
			case "pending":
				last = fmt.Sprintf("check run %q is %s %s", g.check, v.run.Status, v.run.HTMLURL)
				note(last)
			case "passed":
				g.logf("ci-gate: check run %q succeeded: %s", g.check, v.run.HTMLURL)
				return v.run.HTMLURL, nil
			default:
				return v.run.HTMLURL, &deployRefusal{fmt.Sprintf("refusing to deploy %s: CI check %q concluded %q (%s); not deployed. Fix and push, or POST /admin/deploy?skip_ci=1 to override",
					short, g.check, v.run.Conclusion, v.run.HTMLURL)}
			}
		}

		now := g.now()
		if g.exhausted(deadline) {
			return "", g.exhaustedRefusal(short, deadline)
		}
		if !now.Before(deadline) {
			return "", timedOut()
		}
		d := g.interval(now.Sub(start))
		if advice > d {
			d = advice
		}
		if rem := deadline.Sub(now); d > rem {
			d = rem // one last look exactly at the deadline
		}
		if g.onWait != nil {
			g.onWait()
		}
		if err := g.sleep(ctx, d); err != nil {
			return "", err
		}
	}
}

// appDesc names the app whose check runs count, for messages.
func (g *ciGate) appDesc() string {
	switch {
	case g.appSlug != "":
		return g.appSlug
	case g.appID != 0:
		return fmt.Sprintf("app %d", g.appID)
	}
	return "any app"
}

func ignoredNote(n int) string {
	if n == 0 {
		return ""
	}
	return fmt.Sprintf(" (%d of that name from other apps were ignored)", n)
}

func shortSHA(sha string) string {
	if len(sha) > 12 {
		return sha[:12]
	}
	return sha
}
