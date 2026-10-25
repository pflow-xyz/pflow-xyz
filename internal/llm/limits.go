package llm

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"
)

// Limits are the per-user and global caps. GitHub accounts are free to
// create, so per-user limits stop accidents and casual abuse; the global
// daily cap is the cost ceiling.
type Limits struct {
	Burst       int           // per-user bucket size
	Refill      time.Duration // one token back per Refill
	Daily       int           // per user per UTC day
	GlobalDaily int           // all users per UTC day
}

// DefaultLimits are the slice-1 design's proposal (open decision 3).
var DefaultLimits = Limits{Burst: 3, Refill: 20 * time.Second, Daily: 30, GlobalDaily: 500}

// LimitsFromEnv reads PFLOW_LLM_BURST, PFLOW_LLM_REFILL_S, PFLOW_LLM_DAILY_LIMIT
// and PFLOW_LLM_GLOBAL_DAILY_LIMIT. A malformed value logs once and keeps the
// default, as sim's dailyLimit() does.
func LimitsFromEnv(getenv func(string) string) Limits {
	l := DefaultLimits
	read := func(name string, dst *int) {
		v := getenv(name)
		if v == "" {
			return
		}
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			log.Printf("llm: ignoring %s=%q (not a non-negative integer); using %d", name, v, *dst)
			return
		}
		*dst = n
	}
	read("PFLOW_LLM_BURST", &l.Burst)
	read("PFLOW_LLM_DAILY_LIMIT", &l.Daily)
	read("PFLOW_LLM_GLOBAL_DAILY_LIMIT", &l.GlobalDaily)
	refill := int(l.Refill / time.Second)
	read("PFLOW_LLM_REFILL_S", &refill)
	l.Refill = time.Duration(refill) * time.Second
	return l
}

// LimitError is a refusal: which limit, when to retry, when the day resets.
type LimitError struct {
	Reason     string
	RetryAfter time.Duration
	Reset      time.Time
}

func (e *LimitError) Error() string { return e.Reason }

// ErrUsageLog means the usage log could not be written. Callers fail closed
// with 503: an unrecorded call is one the daily caps cannot see.
var ErrUsageLog = errors.New("usage log unavailable")

// Usage is one line of the usage log. A "start" line is written before a call
// goes upstream and is what the counters count; a "done" line follows with
// what it cost.
type Usage struct {
	T      time.Time `json:"t"`
	Event  string    `json:"event"` // start | done
	Kind   string    `json:"kind"`  // draft | turn
	GHID   string    `json:"gh_id"`
	Login  string    `json:"login,omitempty"`
	Prompt string    `json:"prompt,omitempty"`
	In     int       `json:"in,omitempty"`
	Out    int       `json:"out,omitempty"`
	Status int       `json:"status,omitempty"`
	MS     int64     `json:"ms,omitempty"`
}

type bucket struct {
	tokens float64
	at     time.Time
}

// Limiter enforces Limits and keeps the usage log. Daily counters are
// rebuilt from the current month's log at startup, because pushing main
// redeploys and restarts the server several times a day; the burst bucket is
// in memory only (losing it on restart is harmless).
type Limiter struct {
	L   Limits
	Dir string // data/llm; usage-YYYY-MM.jsonl lives here
	Now func() time.Time

	mu       sync.Mutex
	buckets  map[string]*bucket
	inflight map[string]bool
	day      string
	perUser  map[string]int
	global   int
}

// NewLimiter replays dir's current-month log into the daily counters.
func NewLimiter(l Limits, dir string) (*Limiter, error) {
	lim := &Limiter{L: l, Dir: dir, Now: time.Now}
	if err := lim.replay(); err != nil {
		return nil, err
	}
	return lim, nil
}

func dayOf(t time.Time) string { return t.UTC().Format("2006-01-02") }

func nextReset(t time.Time) time.Time {
	u := t.UTC()
	return time.Date(u.Year(), u.Month(), u.Day()+1, 0, 0, 0, 0, time.UTC)
}

func (l *Limiter) logPath(t time.Time) string {
	return filepath.Join(l.Dir, "usage-"+t.UTC().Format("2006-01")+".jsonl")
}

func (l *Limiter) rollover(now time.Time) {
	if d := dayOf(now); d != l.day {
		l.day = d
		l.perUser = map[string]int{}
		l.global = 0
	}
}

func (l *Limiter) replay() error {
	now := l.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.buckets = map[string]*bucket{}
	l.inflight = map[string]bool{}
	l.day = ""
	l.rollover(now)
	f, err := os.Open(l.logPath(now))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUsageLog, err)
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		var u Usage
		if json.Unmarshal(sc.Bytes(), &u) != nil || u.Event != "start" || dayOf(u.T) != l.day {
			continue
		}
		l.perUser[u.GHID]++
		l.global++
	}
	return sc.Err()
}

// Remaining is the user's calls left today and when the day resets.
func (l *Limiter) Remaining(ghID string) (int, time.Time) {
	now := l.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollover(now)
	left := l.L.Daily - l.perUser[ghID]
	if g := l.L.GlobalDaily - l.global; g < left {
		left = g
	}
	if left < 0 {
		left = 0
	}
	return left, nextReset(now)
}

// Begin admits one upstream call for ghID: it checks every limit, takes a
// burst token, marks the user in flight and writes the "start" line (which
// is the charge). It returns a done func that writes the "done" line and
// clears the in-flight mark. A *LimitError means refused; ErrUsageLog means
// fail closed.
func (l *Limiter) Begin(u Usage) (done func(Usage), err error) {
	now := l.Now()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.rollover(now)
	reset := nextReset(now)

	if l.inflight[u.GHID] {
		return nil, &LimitError{Reason: "a request from you is already in progress", RetryAfter: 5 * time.Second, Reset: reset}
	}
	if l.global >= l.L.GlobalDaily {
		return nil, &LimitError{Reason: "the service's daily limit is reached", RetryAfter: reset.Sub(now), Reset: reset}
	}
	if l.perUser[u.GHID] >= l.L.Daily {
		return nil, &LimitError{Reason: fmt.Sprintf("your daily limit of %d is reached", l.L.Daily), RetryAfter: reset.Sub(now), Reset: reset}
	}
	b := l.buckets[u.GHID]
	if b == nil {
		b = &bucket{tokens: float64(l.L.Burst), at: now}
		l.buckets[u.GHID] = b
	}
	if l.L.Refill > 0 {
		b.tokens += float64(now.Sub(b.at)) / float64(l.L.Refill)
		if b.tokens > float64(l.L.Burst) {
			b.tokens = float64(l.L.Burst)
		}
	}
	b.at = now
	if b.tokens < 1 {
		wait := time.Duration((1 - b.tokens) * float64(l.L.Refill))
		return nil, &LimitError{Reason: "too many requests; slow down", RetryAfter: wait, Reset: reset}
	}

	u.T, u.Event = now.UTC(), "start"
	if err := l.appendLocked(u); err != nil {
		return nil, err
	}
	b.tokens--
	l.perUser[u.GHID]++
	l.global++
	l.inflight[u.GHID] = true

	start := now
	return func(fin Usage) {
		end := l.Now()
		l.mu.Lock()
		defer l.mu.Unlock()
		delete(l.inflight, u.GHID)
		fin.T, fin.Event, fin.Kind, fin.GHID, fin.Login, fin.Prompt = end.UTC(), "done", u.Kind, u.GHID, u.Login, u.Prompt
		fin.MS = end.Sub(start).Milliseconds()
		if err := l.appendLocked(fin); err != nil {
			log.Printf("llm: usage log: %v", err) // the charge is already recorded
		}
	}, nil
}

func (l *Limiter) appendLocked(u Usage) error {
	if err := os.MkdirAll(l.Dir, 0o755); err != nil {
		return fmt.Errorf("%w: %v", ErrUsageLog, err)
	}
	f, err := os.OpenFile(l.logPath(u.T), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUsageLog, err)
	}
	line, _ := json.Marshal(u)
	if _, err := f.Write(append(line, '\n')); err != nil {
		f.Close()
		return fmt.Errorf("%w: %v", ErrUsageLog, err)
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("%w: %v", ErrUsageLog, err)
	}
	return nil
}
