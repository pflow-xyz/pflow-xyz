package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeClock is a clock whose Sleep advances it instead of waiting, so the
// gate's polling, grace and timeout run in microseconds and deterministically.
type fakeClock struct {
	mu    sync.Mutex
	t     time.Time
	slept []time.Duration
}

func newFakeClock() *fakeClock {
	return &fakeClock{t: time.Date(2026, 10, 28, 15, 34, 0, 0, time.UTC)}
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(d)
	c.slept = append(c.slept, d)
	return nil
}

func (c *fakeClock) elapsed(since time.Time) time.Duration { return c.Now().Sub(since) }

// gateServer stands in for api.github.com. handler gets the 1-based hit number.
type gateServer struct {
	srv     *httptest.Server
	mu      sync.Mutex
	hits    int
	reqs    []*http.Request
	handler func(n int, w http.ResponseWriter, r *http.Request)
}

func newGateServer(t *testing.T, h func(n int, w http.ResponseWriter, r *http.Request)) *gateServer {
	t.Helper()
	g := &gateServer{handler: h}
	g.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		g.mu.Lock()
		g.hits++
		n := g.hits
		g.reqs = append(g.reqs, r.Clone(context.Background()))
		g.mu.Unlock()
		g.handler(n, w, r)
	}))
	t.Cleanup(g.srv.Close)
	return g
}

func (g *gateServer) hitCount() int {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.hits
}

const testSHA = "89e6f34c0ffee0123456789abcdef0123456789a"

// runJSON is a check run made by GitHub Actions, in the check suite of the
// commit's one workflow run (suite 1000), as the API returns it.
func runJSON(id int64, name, status, conclusion string) string {
	return runJSONIn(id, name, status, conclusion, githubActionsAppID, githubActionsAppSlug, 1000)
}

// runJSONIn is a check run made by the given app in the given check suite.
func runJSONIn(id int64, name, status, conclusion string, appID int64, appSlug string, suite int64) string {
	c := "null"
	if conclusion != "" {
		c = strconv.Quote(conclusion)
	}
	return fmt.Sprintf(`{"id":%d,"name":%q,"status":%q,"conclusion":%s,"html_url":"https://github.com/pflow-xyz/pflow-xyz/actions/runs/%d/job/%d","app":{"id":%d,"slug":%q},"check_suite":{"id":%d}}`,
		id, name, status, c, id*10, id, appID, appSlug, suite)
}

func runsBody(runs ...string) string {
	return fmt.Sprintf(`{"total_count":%d,"check_runs":[%s]}`, len(runs), strings.Join(runs, ","))
}

func writeRuns(w http.ResponseWriter, runs ...string) {
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprint(w, runsBody(runs...))
}

type testGate struct {
	*ciGate
	clk  *fakeClock
	logs *[]string
}

func newTestGate(t *testing.T, gs *gateServer) testGate {
	t.Helper()
	clk := newFakeClock()
	var logs []string
	g := &ciGate{
		client:  gs.srv.Client(),
		now:     clk.Now,
		sleep:   clk.Sleep,
		apiBase: gs.srv.URL,
		repo:    "pflow-xyz/pflow-xyz",
		check:   "test",
		appID:   githubActionsAppID,
		appSlug: githubActionsAppSlug,
		poll:    15 * time.Second,
		grace:   2 * time.Minute,
		timeout: 15 * time.Minute,
		logf:    func(f string, a ...any) { logs = append(logs, fmt.Sprintf(f, a...)) },
	}
	return testGate{g, clk, &logs}
}

func asRefusal(t *testing.T, err error) *deployRefusal {
	t.Helper()
	var r *deployRefusal
	if !errors.As(err, &r) {
		t.Fatalf("want a *deployRefusal, got %T %v", err, err)
	}
	return r
}

func TestGatePassesOnSuccessfulCheckRun(t *testing.T) {
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		writeRuns(w, runJSON(7, "test", "completed", "success"))
	})
	g := newTestGate(t, gs)
	url, err := g.wait(context.Background(), testSHA)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(url, "/actions/runs/70/job/7") {
		t.Errorf("run url = %q", url)
	}
	if gs.hitCount() != 1 || len(g.clk.slept) != 0 {
		t.Errorf("a green run needs one request and no waiting, got %d hits, slept %v", gs.hitCount(), g.clk.slept)
	}
	r := gs.reqs[0]
	if want := "/repos/pflow-xyz/pflow-xyz/commits/" + testSHA + "/check-runs"; r.URL.Path != want {
		t.Errorf("path = %q, want %q", r.URL.Path, want)
	}
	if q := r.URL.Query(); q.Get("check_name") != "test" || q.Get("app_id") != "15368" || q.Get("filter") != "all" {
		t.Errorf("query = %q: want check_name=test, app_id=15368 (GitHub Actions) and filter=all", r.URL.RawQuery)
	}
	if r.Header.Get("Authorization") != "" {
		t.Errorf("no token configured, yet Authorization = %q", r.Header.Get("Authorization"))
	}
	if r.Header.Get("Accept") != "application/vnd.github+json" || r.Header.Get("User-Agent") == "" {
		t.Errorf("headers = %v", r.Header)
	}
}

func TestGateSendsTheTokenWhenConfigured(t *testing.T) {
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		writeRuns(w, runJSON(7, "test", "completed", "success"))
	})
	g := newTestGate(t, gs)
	g.token = "ghp_example"
	if _, err := g.wait(context.Background(), testSHA); err != nil {
		t.Fatal(err)
	}
	if got := gs.reqs[0].Header.Get("Authorization"); got != "Bearer ghp_example" {
		t.Errorf("Authorization = %q", got)
	}
}

func TestGateRefusesEveryOutcomeButSuccess(t *testing.T) {
	for _, conclusion := range []string{"failure", "cancelled", "timed_out", "action_required", "stale", "neutral", "skipped", "startup_failure", ""} {
		t.Run("conclusion="+conclusion, func(t *testing.T) {
			gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
				writeRuns(w, runJSON(7, "test", "completed", conclusion))
			})
			g := newTestGate(t, gs)
			_, err := g.wait(context.Background(), testSHA)
			ref := asRefusal(t, err)
			if !strings.Contains(ref.msg, `concluded "`+conclusion+`"`) || !strings.Contains(ref.msg, "/actions/runs/70/job/7") {
				t.Errorf("refusal should name the conclusion and the run URL: %s", ref.msg)
			}
			if !strings.Contains(ref.msg, testSHA[:12]) {
				t.Errorf("refusal should name the commit: %s", ref.msg)
			}
			if gs.hitCount() != 1 {
				t.Errorf("a finished run is final; got %d requests", gs.hitCount())
			}
		})
	}
}

func TestGateWaitsThroughQueuedAndInProgress(t *testing.T) {
	steps := []string{
		runJSON(7, "test", "queued", ""),
		runJSON(7, "test", "in_progress", ""),
		runJSON(7, "test", "in_progress", ""),
		runJSON(7, "test", "completed", "success"),
	}
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) { writeRuns(w, steps[n-1]) })
	g := newTestGate(t, gs)
	if _, err := g.wait(context.Background(), testSHA); err != nil {
		t.Fatal(err)
	}
	if gs.hitCount() != 4 {
		t.Errorf("hits = %d, want 4", gs.hitCount())
	}
	if want := []time.Duration{15 * time.Second, 15 * time.Second, 15 * time.Second}; fmt.Sprint(g.clk.slept) != fmt.Sprint(want) {
		t.Errorf("polled at %v, want %v", g.clk.slept, want)
	}
	joined := strings.Join(*g.logs, "\n")
	for _, want := range []string{"queued", "in_progress", "succeeded"} {
		if !strings.Contains(joined, want) {
			t.Errorf("gate log should record %q:\n%s", want, joined)
		}
	}
	if n := strings.Count(joined, "is in_progress"); n != 1 {
		t.Errorf("an unchanged state is logged once, not per poll (got %d):\n%s", n, joined)
	}
}

func TestGateRefusesAfterGraceWhenNoCheckRunAppears(t *testing.T) {
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		writeRuns(w, runJSON(3, "lint", "completed", "success")) // some other check; not "test"
	})
	g := newTestGate(t, gs)
	start := g.clk.Now()
	_, err := g.wait(context.Background(), testSHA)
	ref := asRefusal(t, err)
	if !strings.Contains(ref.msg, `no check run named "test"`) || !strings.Contains(ref.msg, "2m0s") {
		t.Errorf("refusal = %s", ref.msg)
	}
	if got := g.clk.elapsed(start); got != 2*time.Minute {
		t.Errorf("refused after %s, want exactly the 2m grace", got)
	}
	if gs.hitCount() != 9 { // t = 0, 15, ..., 120
		t.Errorf("hits = %d, want 9", gs.hitCount())
	}
}

func TestGateAcceptsACheckRunThatRegistersWithinGrace(t *testing.T) {
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		if n < 4 {
			writeRuns(w)
			return
		}
		writeRuns(w, runJSON(9, "test", "completed", "success"))
	})
	g := newTestGate(t, gs)
	if _, err := g.wait(context.Background(), testSHA); err != nil {
		t.Fatal(err)
	}
	if gs.hitCount() != 4 {
		t.Errorf("hits = %d", gs.hitCount())
	}
}

func TestGateGraceStartsAtTheFirstAnswerNotAtTheFirstError(t *testing.T) {
	// 100 seconds of 500s, then a clean answer with no run: the grace window
	// must still be available, or an outage would turn into a "CI never ran".
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		if n <= 7 { // t = 0 .. 90
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		if n < 10 {
			writeRuns(w)
			return
		}
		writeRuns(w, runJSON(9, "test", "completed", "success"))
	})
	g := newTestGate(t, gs)
	if _, err := g.wait(context.Background(), testSHA); err != nil {
		t.Fatalf("refused although the run showed up within the grace of the first clean answer: %v", err)
	}
}

func TestGateRetriesServerErrorsThenPasses(t *testing.T) {
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		if n <= 3 {
			http.Error(w, "upstream down", http.StatusBadGateway)
			return
		}
		writeRuns(w, runJSON(7, "test", "completed", "success"))
	})
	g := newTestGate(t, gs)
	if _, err := g.wait(context.Background(), testSHA); err != nil {
		t.Fatal(err)
	}
	if gs.hitCount() != 4 {
		t.Errorf("hits = %d", gs.hitCount())
	}
	if !strings.Contains(strings.Join(*g.logs, "\n"), "answered 502") {
		t.Errorf("the outage should be in the log: %v", *g.logs)
	}
}

func TestGateFailsClosedWhenTheAPIStaysDown(t *testing.T) {
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream down", http.StatusInternalServerError)
	})
	g := newTestGate(t, gs)
	start := g.clk.Now()
	_, err := g.wait(context.Background(), testSHA)
	ref := asRefusal(t, err)
	if !strings.Contains(ref.msg, "gave up after 15m0s") || !strings.Contains(ref.msg, "answered 500") {
		t.Errorf("refusal = %s", ref.msg)
	}
	if got := g.clk.elapsed(start); got != 15*time.Minute {
		t.Errorf("gave up after %s", got)
	}
	if gs.hitCount() != 25 { // 15s for 2 minutes, 30s until 5, then 60s, the last look at the deadline
		t.Errorf("hits = %d, want 25", gs.hitCount())
	}
}

func TestGateFailsClosedWhenTheAPIIsUnreachable(t *testing.T) {
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {})
	g := newTestGate(t, gs)
	gs.srv.Close() // connections now refused
	_, err := g.wait(context.Background(), testSHA)
	ref := asRefusal(t, err)
	if !strings.Contains(ref.msg, "unreachable") {
		t.Errorf("refusal = %s", ref.msg)
	}
}

func TestGateWaitsOutRateLimits(t *testing.T) {
	t.Run("Retry-After", func(t *testing.T) {
		gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
			if n == 1 {
				w.Header().Set("Retry-After", "60")
				http.Error(w, "secondary rate limit", http.StatusForbidden)
				return
			}
			writeRuns(w, runJSON(7, "test", "completed", "success"))
		})
		g := newTestGate(t, gs)
		if _, err := g.wait(context.Background(), testSHA); err != nil {
			t.Fatal(err)
		}
		if len(g.clk.slept) != 1 || g.clk.slept[0] != 60*time.Second {
			t.Errorf("slept %v, want one 60s wait", g.clk.slept)
		}
	})
	t.Run("X-RateLimit-Reset", func(t *testing.T) {
		var clk *fakeClock
		gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
			if n == 1 {
				w.Header().Set("X-RateLimit-Remaining", "0")
				w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(clk.Now().Add(90*time.Second).Unix(), 10))
				http.Error(w, "API rate limit exceeded", http.StatusForbidden)
				return
			}
			writeRuns(w, runJSON(7, "test", "completed", "success"))
		})
		g := newTestGate(t, gs)
		clk = g.clk
		if _, err := g.wait(context.Background(), testSHA); err != nil {
			t.Fatal(err)
		}
		if len(clk.slept) != 1 || clk.slept[0] < 90*time.Second || clk.slept[0] > 92*time.Second {
			t.Errorf("slept %v, want about the reset time (90s)", clk.slept)
		}
	})
	t.Run("never past the deadline", func(t *testing.T) {
		gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Retry-After", "3600")
			http.Error(w, "rate limited", http.StatusTooManyRequests)
		})
		g := newTestGate(t, gs)
		start := g.clk.Now()
		_, err := g.wait(context.Background(), testSHA)
		asRefusal(t, err)
		if got := g.clk.elapsed(start); got != 15*time.Minute {
			t.Errorf("waited %s; a rate limit may not stretch the gate beyond its timeout", got)
		}
	})
}

// Unauthenticated, GitHub allows 60 requests an hour and every poll spends one
// (a 304 included): a flat 15 seconds would spend all 60 on one stuck CI run.
func TestGateBacksOffItsPolling(t *testing.T) {
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		writeRuns(w, runJSON(7, "test", "in_progress", ""))
	})
	g := newTestGate(t, gs)
	_, err := g.wait(context.Background(), testSHA)
	asRefusal(t, err)

	var want []time.Duration
	for i := 0; i < 8; i++ { // 0 .. 2m
		want = append(want, 15*time.Second)
	}
	for i := 0; i < 6; i++ { // 2m .. 5m
		want = append(want, 30*time.Second)
	}
	for i := 0; i < 10; i++ { // 5m .. 15m
		want = append(want, time.Minute)
	}
	if fmt.Sprint(g.clk.slept) != fmt.Sprint(want) {
		t.Errorf("polled at intervals %v\nwant %v", g.clk.slept, want)
	}
	if gs.hitCount() != 25 {
		t.Errorf("a stuck run costs %d requests, want 25 (it was 61)", gs.hitCount())
	}
}

func TestGateIntervalScalesWithThePollSetting(t *testing.T) {
	for _, c := range []struct {
		poll, elapsed, want time.Duration
	}{
		{15 * time.Second, 0, 15 * time.Second},
		{15 * time.Second, ciFastFor - time.Second, 15 * time.Second},
		{15 * time.Second, ciFastFor, 30 * time.Second},
		{15 * time.Second, ciSlowAfter - time.Second, 30 * time.Second},
		{15 * time.Second, ciSlowAfter, time.Minute},
		{15 * time.Second, time.Hour, time.Minute},
		{5 * time.Second, 0, 5 * time.Second},
		{5 * time.Second, ciFastFor, 10 * time.Second},
		{5 * time.Second, ciSlowAfter, 20 * time.Second},
		{40 * time.Second, ciSlowAfter, time.Minute},    // 4x would be 160s: capped at a minute
		{2 * time.Minute, 0, 2 * time.Minute},           // a slower poll than the cap is the operator's choice
		{2 * time.Minute, ciSlowAfter, 2 * time.Minute}, // and is never made slower
	} {
		g := &ciGate{poll: c.poll}
		if got := g.interval(c.elapsed); got != c.want {
			t.Errorf("poll %s after %s: interval %s, want %s", c.poll, c.elapsed, got, c.want)
		}
	}
}

// rateHeaders sets the headers GitHub puts on every API response.
func rateHeaders(w http.ResponseWriter, limit, remaining int, reset time.Time) {
	w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
	w.Header().Set("X-RateLimit-Remaining", strconv.Itoa(remaining))
	w.Header().Set("X-RateLimit-Reset", strconv.FormatInt(reset.Unix(), 10))
}

func TestGateLogsTheRateLimit(t *testing.T) {
	var clk *fakeClock
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		rateHeaders(w, 60, 60-n, clk.Now().Add(40*time.Minute))
		if n < 3 {
			writeRuns(w, runJSON(7, "test", "in_progress", ""))
			return
		}
		writeRuns(w, runJSON(7, "test", "completed", "success"))
	})
	g := newTestGate(t, gs)
	clk = g.clk
	if _, err := g.wait(context.Background(), testSHA); err != nil {
		t.Fatal(err)
	}
	log := strings.Join(*g.logs, "\n")
	for _, want := range []string{
		"GitHub API rate limit: 59 of 60 left, resets 16:14:00Z",
		"unauthenticated, so every poll costs one request",
		"DEPLOY_GITHUB_TOKEN",
		"3 requests to GitHub; rate limit 57 of 60 left",
	} {
		if !strings.Contains(log, want) {
			t.Errorf("gate log lacks %q:\n%s", want, log)
		}
	}
	if n := strings.Count(log, "rate limit: "); n != 1 {
		t.Errorf("the rate limit is logged once while it is comfortable, got %d times:\n%s", n, log)
	}

	// With a token the hint about unauthenticated requests is not shown.
	gs2 := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		rateHeaders(w, 5000, 4999, clk.Now().Add(time.Hour))
		writeRuns(w, runJSON(7, "test", "completed", "success"))
	})
	g2 := newTestGate(t, gs2)
	g2.token = "ghp_example"
	if _, err := g2.wait(context.Background(), testSHA); err != nil {
		t.Fatal(err)
	}
	if log2 := strings.Join(*g2.logs, "\n"); !strings.Contains(log2, "4999 of 5000 left") || strings.Contains(log2, "unauthenticated") {
		t.Errorf("authenticated gate log:\n%s", log2)
	}
}

func TestGateLogsEveryPollOnceTheRateLimitIsLow(t *testing.T) {
	var clk *fakeClock
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		rateHeaders(w, 60, 14-n, clk.Now().Add(40*time.Minute)) // 13, 12, 11, 10, 9, ...
		if n < 7 {
			writeRuns(w, runJSON(7, "test", "in_progress", ""))
			return
		}
		writeRuns(w, runJSON(7, "test", "completed", "success"))
	})
	g := newTestGate(t, gs)
	clk = g.clk
	if _, err := g.wait(context.Background(), testSHA); err != nil {
		t.Fatal(err)
	}
	log := strings.Join(*g.logs, "\n")
	for _, want := range []string{"13 of 60 left", "10 of 60 left", "9 of 60 left", "8 of 60 left", "7 of 60 left"} {
		if !strings.Contains(log, want) {
			t.Errorf("a low rate limit should be logged on every poll; lacks %q:\n%s", want, log)
		}
	}
	if strings.Contains(log, "12 of 60 left") || strings.Contains(log, "11 of 60 left") {
		t.Errorf("polls with a comfortable budget should not repeat the rate limit:\n%s", log)
	}
}

// When the budget is gone and will not come back before the gate gives up,
// waiting out the timeout only delays the same refusal and hides its cause.
func TestGateFailsFastWhenTheRateLimitOutlastsIt(t *testing.T) {
	for _, c := range []struct {
		name   string
		status int // what the exhausting response is
		token  string
		fix    string
	}{
		{"403 without a token", http.StatusForbidden, "", "Set DEPLOY_GITHUB_TOKEN"},
		{"429 without a token", http.StatusTooManyRequests, "", "Set DEPLOY_GITHUB_TOKEN"},
		{"a 200 that used the last request", http.StatusOK, "", "Set DEPLOY_GITHUB_TOKEN"},
		{"with a token", http.StatusForbidden, "ghp_example", "its own limit is used up"},
	} {
		t.Run(c.name, func(t *testing.T) {
			var clk *fakeClock
			gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
				rateHeaders(w, 60, 0, clk.Now().Add(50*time.Minute))
				if c.status == http.StatusOK {
					writeRuns(w, runJSON(7, "test", "in_progress", ""))
					return
				}
				http.Error(w, "API rate limit exceeded", c.status)
			})
			g := newTestGate(t, gs)
			clk, g.token = g.clk, c.token
			start := clk.Now()
			_, err := g.wait(context.Background(), testSHA)
			ref := asRefusal(t, err)
			for _, want := range []string{"rate limit is used up", "0 of 60 left", "16:24:00Z", c.fix, "skip_ci=1"} {
				if !strings.Contains(ref.msg, want) {
					t.Errorf("refusal lacks %q: %s", want, ref.msg)
				}
			}
			if strings.Contains(ref.msg, "gave up after") {
				t.Errorf("this is not a timeout: %s", ref.msg)
			}
			if gs.hitCount() != 1 || len(clk.slept) != 0 || clk.elapsed(start) != 0 {
				t.Errorf("hits %d, slept %v: it should refuse at once", gs.hitCount(), clk.slept)
			}
		})
	}
}

// A reset that arrives before the deadline is worth waiting for.
func TestGateWaitsForARateLimitThatResetsInTime(t *testing.T) {
	var clk *fakeClock
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		if n == 1 {
			rateHeaders(w, 60, 0, clk.Now().Add(5*time.Minute))
			http.Error(w, "API rate limit exceeded", http.StatusForbidden)
			return
		}
		rateHeaders(w, 60, 59, clk.Now().Add(time.Hour))
		writeRuns(w, runJSON(7, "test", "completed", "success"))
	})
	g := newTestGate(t, gs)
	clk = g.clk
	if _, err := g.wait(context.Background(), testSHA); err != nil {
		t.Fatalf("a limit that resets in 5 minutes must not fail a 15 minute gate: %v", err)
	}
}

func TestGateUsesETagsSoPollingIsCheap(t *testing.T) {
	var inm []string
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		inm = append(inm, r.Header.Get("If-None-Match"))
		switch n {
		case 1:
			w.Header().Set("ETag", `W/"v1"`)
			writeRuns(w, runJSON(7, "test", "in_progress", ""))
		case 2:
			if r.Header.Get("If-None-Match") != `W/"v1"` {
				t.Errorf("poll 2 did not send the ETag")
			}
			w.WriteHeader(http.StatusNotModified)
		case 3:
			w.WriteHeader(http.StatusNotModified)
		default:
			w.Header().Set("ETag", `W/"v2"`)
			writeRuns(w, runJSON(7, "test", "completed", "success"))
		}
	})
	g := newTestGate(t, gs)
	if _, err := g.wait(context.Background(), testSHA); err != nil {
		t.Fatal(err)
	}
	if want := []string{"", `W/"v1"`, `W/"v1"`, `W/"v1"`}; fmt.Sprint(inm) != fmt.Sprint(want) {
		t.Errorf("If-None-Match sequence = %q, want %q", inm, want)
	}
}

func TestGateTreatsA304ItCannotExplainAsAnError(t *testing.T) {
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		if n == 1 {
			w.WriteHeader(http.StatusNotModified) // nothing was sent for this to be "not modified" from
			return
		}
		writeRuns(w, runJSON(7, "test", "completed", "success"))
	})
	g := newTestGate(t, gs)
	if _, err := g.wait(context.Background(), testSHA); err != nil {
		t.Fatal(err)
	}
	if gs.hitCount() != 2 {
		t.Errorf("hits = %d", gs.hitCount())
	}
}

func TestGateDoesNotRetryWhatRetryingCannotFix(t *testing.T) {
	for _, code := range []int{http.StatusUnauthorized, http.StatusNotFound, http.StatusUnprocessableEntity} {
		t.Run(strconv.Itoa(code), func(t *testing.T) {
			gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
				http.Error(w, `{"message":"nope"}`, code)
			})
			g := newTestGate(t, gs)
			_, err := g.wait(context.Background(), testSHA)
			ref := asRefusal(t, err)
			if !strings.Contains(ref.msg, strconv.Itoa(code)) {
				t.Errorf("refusal = %s", ref.msg)
			}
			if gs.hitCount() != 1 || len(g.clk.slept) != 0 {
				t.Errorf("hits %d, slept %v: a permanent error should refuse at once", gs.hitCount(), g.clk.slept)
			}
		})
	}
}

func TestGateChoosesTheNewestRunOfTheRequiredName(t *testing.T) {
	cases := []struct {
		name string
		runs []string
		pass bool
	}{
		{"other names are ignored", []string{runJSON(1, "lint", "completed", "success"), runJSON(2, "test", "completed", "failure")}, false},
		{"a rerun that passed supersedes the failure", []string{runJSON(5, "test", "completed", "failure"), runJSON(9, "test", "completed", "success")}, true},
		{"a rerun that failed supersedes the pass", []string{runJSON(9, "test", "completed", "failure"), runJSON(5, "test", "completed", "success")}, false},
		{"order in the response does not matter", []string{runJSON(9, "test", "completed", "success"), runJSON(5, "test", "completed", "failure")}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) { writeRuns(w, c.runs...) })
			g := newTestGate(t, gs)
			_, err := g.wait(context.Background(), testSHA)
			if c.pass && err != nil {
				t.Fatal(err)
			}
			if !c.pass {
				asRefusal(t, err)
			}
		})
	}
}

// The check name is only a label. A run called "test" from another app, or from
// a second workflow, must neither stand in for the real one nor mask it.
func TestGateCountsOnlyGitHubActionsCheckRuns(t *testing.T) {
	const otherApp = 99999
	cases := []struct {
		name    string
		runs    []string
		pass    bool
		refusal string // what the refusal must say, when it is one
	}{
		{"a failing Actions run is not masked by another app's passing run",
			[]string{runJSON(30, "test", "completed", "failure"), runJSONIn(31, "test", "completed", "success", otherApp, "some-other-app", 1000)}, false, `concluded "failure"`},
		{"the same, whichever comes first",
			[]string{runJSONIn(31, "test", "completed", "success", otherApp, "some-other-app", 1000), runJSON(30, "test", "completed", "failure")}, false, `concluded "failure"`},
		{"another app's passing run alone is not CI",
			[]string{runJSONIn(31, "test", "completed", "success", otherApp, "some-other-app", 1000)}, false, "from github-actions"},
		{"right app id, wrong slug",
			[]string{runJSONIn(31, "test", "completed", "success", githubActionsAppID, "impostor", 1000)}, false, "no check run named"},
		{"right slug, wrong app id",
			[]string{runJSONIn(31, "test", "completed", "success", otherApp, githubActionsAppSlug, 1000)}, false, "no check run named"},
		{"a run with no app at all",
			[]string{`{"id":5,"name":"test","status":"completed","conclusion":"success","html_url":"u"}`}, false, "no check run named"},
		{"an Actions pass counts and another app's failure does not matter",
			[]string{runJSON(30, "test", "completed", "success"), runJSONIn(31, "test", "completed", "failure", otherApp, "some-other-app", 1000)}, true, ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) { writeRuns(w, c.runs...) })
			g := newTestGate(t, gs)
			_, err := g.wait(context.Background(), testSHA)
			if c.pass {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			ref := asRefusal(t, err)
			if !strings.Contains(ref.msg, c.refusal) {
				t.Errorf("refusal = %s, want it to contain %q", ref.msg, c.refusal)
			}
		})
	}
}

func TestGateSaysWhenItIgnoredOtherAppsRuns(t *testing.T) {
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		writeRuns(w, runJSONIn(31, "test", "completed", "success", 99999, "some-other-app", 1000))
	})
	g := newTestGate(t, gs)
	_, err := g.wait(context.Background(), testSHA)
	ref := asRefusal(t, err)
	if !strings.Contains(ref.msg, "1 of that name from other apps were ignored") {
		t.Errorf("refusal = %s", ref.msg)
	}
	if !strings.Contains(strings.Join(*g.logs, "\n"), "ignored") {
		t.Errorf("the log should say a same-named run was ignored: %v", *g.logs)
	}
}

// A commit can have several check suites with a job of this name: a push and a
// pull_request workflow on the same sha, a second workflow. All must pass.
func TestGateRequiresEveryCheckSuite(t *testing.T) {
	cases := []struct {
		name    string
		runs    []string
		pass    bool
		refusal string
	}{
		{"both suites green",
			[]string{runJSONIn(10, "test", "completed", "success", 15368, "github-actions", 1), runJSONIn(20, "test", "completed", "success", 15368, "github-actions", 2)}, true, ""},
		{"one suite red, the other green and newer",
			[]string{runJSONIn(10, "test", "completed", "failure", 15368, "github-actions", 1), runJSONIn(20, "test", "completed", "success", 15368, "github-actions", 2)}, false, `concluded "failure"`},
		{"one suite red, the other still running: red is final",
			[]string{runJSONIn(10, "test", "completed", "failure", 15368, "github-actions", 1), runJSONIn(20, "test", "in_progress", "", 15368, "github-actions", 2)}, false, `concluded "failure"`},
		{"a re-run in the same suite replaces the failure it re-ran",
			[]string{runJSONIn(10, "test", "completed", "failure", 15368, "github-actions", 1), runJSONIn(11, "test", "completed", "success", 15368, "github-actions", 1), runJSONIn(20, "test", "completed", "success", 15368, "github-actions", 2)}, true, ""},
		{"a re-run that failed replaces the pass it re-ran",
			[]string{runJSONIn(10, "test", "completed", "success", 15368, "github-actions", 1), runJSONIn(11, "test", "completed", "failure", 15368, "github-actions", 1)}, false, `concluded "failure"`},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) { writeRuns(w, c.runs...) })
			g := newTestGate(t, gs)
			_, err := g.wait(context.Background(), testSHA)
			if c.pass {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if ref := asRefusal(t, err); !strings.Contains(ref.msg, c.refusal) {
				t.Errorf("refusal = %s", ref.msg)
			}
		})
	}

	t.Run("one suite green, the other still running: wait for it", func(t *testing.T) {
		gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
			second := runJSONIn(20, "test", "in_progress", "", 15368, "github-actions", 2)
			if n >= 3 {
				second = runJSONIn(20, "test", "completed", "success", 15368, "github-actions", 2)
			}
			writeRuns(w, runJSONIn(10, "test", "completed", "success", 15368, "github-actions", 1), second)
		})
		g := newTestGate(t, gs)
		if _, err := g.wait(context.Background(), testSHA); err != nil {
			t.Fatal(err)
		}
		if gs.hitCount() != 3 {
			t.Errorf("hits = %d, want 3", gs.hitCount())
		}
	})
}

// If GitHub has more matching runs than it sent, the gate cannot know it saw
// the failing one.
func TestGateRefusesWhenItCannotSeeAllTheRuns(t *testing.T) {
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprintf(w, `{"total_count":101,"check_runs":[%s]}`, runJSON(7, "test", "completed", "success"))
	})
	g := newTestGate(t, gs)
	_, err := g.wait(context.Background(), testSHA)
	if ref := asRefusal(t, err); !strings.Contains(ref.msg, "more check runs") {
		t.Errorf("refusal = %s", ref.msg)
	}
	if gs.hitCount() != 1 {
		t.Errorf("hits = %d: nothing to wait for", gs.hitCount())
	}
}

func TestGateHonoursACancelledContext(t *testing.T) {
	gs := newGateServer(t, func(n int, w http.ResponseWriter, r *http.Request) {
		writeRuns(w, runJSON(7, "test", "in_progress", ""))
	})
	g := newTestGate(t, gs)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := g.wait(ctx, testSHA); !errors.Is(err, context.Canceled) {
		t.Errorf("err = %v, want context.Canceled", err)
	}
}

func TestDeployConfigFromEnv(t *testing.T) {
	env := func(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

	cfg, warns := deployConfigFromEnv(env(nil))
	if !cfg.RequireCI || cfg.CICheck != "test" || cfg.CIPoll != 15*time.Second || cfg.CIGrace != 2*time.Minute ||
		cfg.CITimeout != 15*time.Minute || cfg.APIBase != "https://api.github.com" || cfg.Repo != "" || cfg.GitHubToken != "" || len(warns) != 0 {
		t.Errorf("defaults = %+v warns %v", cfg, warns)
	}

	for _, off := range []string{"0", "false", "FALSE", " no ", "off"} {
		if cfg, _ := deployConfigFromEnv(env(map[string]string{"DEPLOY_REQUIRE_CI": off})); cfg.RequireCI {
			t.Errorf("DEPLOY_REQUIRE_CI=%q should turn the gate off", off)
		}
	}
	// Anything else, including nonsense, leaves the gate on: it is the safe side.
	for _, on := range []string{"", "1", "true", "yes", "disable", "2"} {
		if cfg, _ := deployConfigFromEnv(env(map[string]string{"DEPLOY_REQUIRE_CI": on})); !cfg.RequireCI {
			t.Errorf("DEPLOY_REQUIRE_CI=%q must not turn the gate off", on)
		}
	}

	cfg, warns = deployConfigFromEnv(env(map[string]string{
		"DEPLOY_CI_CHECK": "build", "DEPLOY_CI_POLL": "5s", "DEPLOY_CI_GRACE": "90", "DEPLOY_CI_TIMEOUT": "20m",
		"DEPLOY_REPO": "o/r", "DEPLOY_GITHUB_TOKEN": " tok ", "DEPLOY_GITHUB_API": "http://127.0.0.1:9/",
	}))
	if cfg.CICheck != "build" || cfg.CIPoll != 5*time.Second || cfg.CIGrace != 90*time.Second || cfg.CITimeout != 20*time.Minute ||
		cfg.Repo != "o/r" || cfg.GitHubToken != "tok" || cfg.APIBase != "http://127.0.0.1:9" || len(warns) != 0 {
		t.Errorf("custom = %+v warns %v", cfg, warns)
	}

	cfg, warns = deployConfigFromEnv(env(map[string]string{"DEPLOY_CI_POLL": "soon", "DEPLOY_CI_TIMEOUT": "-5m", "DEPLOY_CI_GRACE": "0"}))
	if cfg.CIPoll != 15*time.Second || cfg.CITimeout != 15*time.Minute || cfg.CIGrace != 2*time.Minute || len(warns) != 3 {
		t.Errorf("bad values should fall back to defaults with a warning each: %+v %v", cfg, warns)
	}
}

func TestParseGitHubRepo(t *testing.T) {
	for in, want := range map[string]string{
		"git@github.com:pflow-xyz/pflow-xyz.git":       "pflow-xyz/pflow-xyz",
		"git@github.com:pflow-xyz/pflow-xyz":           "pflow-xyz/pflow-xyz",
		"https://github.com/pflow-xyz/pflow-xyz.git":   "pflow-xyz/pflow-xyz",
		"https://github.com/pflow-xyz/pflow-xyz":       "pflow-xyz/pflow-xyz",
		"https://github.com/pflow-xyz/pflow-xyz/":      "pflow-xyz/pflow-xyz",
		"ssh://git@github.com/pflow-xyz/pflow-xyz.git": "pflow-xyz/pflow-xyz",
		"https://user:tok@github.com/o/r.git\n":        "o/r",
		"github-deploy:pflow-xyz/pflow-xyz.git":        "pflow-xyz/pflow-xyz", // an ssh host alias
	} {
		got, err := parseGitHubRepo(in)
		if err != nil || got != want {
			t.Errorf("parseGitHubRepo(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, bad := range []string{"", "pflow-xyz", "git@github.com:onlyone", "https://github.com/", "https://github.com/a b/c"} {
		if got, err := parseGitHubRepo(bad); err == nil {
			t.Errorf("parseGitHubRepo(%q) = %q, want an error", bad, got)
		}
	}
}
