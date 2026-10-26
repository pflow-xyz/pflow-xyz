package llm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// AutoStats counts what auto mode labelled messages as, with nothing that
// identifies a person: no user id or login, no message text, no time finer
// than the UTC day, and the confidence only as a coarse band. Counters live in
// one small JSON file (auto-stats.json in the limiter's directory) rewritten
// atomically, so it cannot be joined to the usage log's per-call timestamps.
type AutoStats struct {
	mu     sync.Mutex
	path   string
	Now    func() time.Time
	counts map[string]int
}

// AutoKey is one counter: a UTC day plus the label.
func autoKey(day, mode, sentiment, band string, fallback bool) string {
	f := "ok"
	if fallback {
		f = "fallback"
	}
	return day + "|" + mode + "|" + sentiment + "|" + band + "|" + f
}

// ConfidenceBand coarsens a confidence so it cannot fingerprint a message.
func ConfidenceBand(c float64) string {
	switch {
	case c >= 0.8:
		return "high"
	case c >= 0.5:
		return "mid"
	default:
		return "low"
	}
}

// NewAutoStats loads dir/auto-stats.json if it exists.
func NewAutoStats(dir string) (*AutoStats, error) {
	a := &AutoStats{path: filepath.Join(dir, "auto-stats.json"), Now: time.Now, counts: map[string]int{}}
	raw, err := os.ReadFile(a.path)
	switch {
	case os.IsNotExist(err):
		return a, nil
	case err != nil:
		return nil, err
	}
	if err := json.Unmarshal(raw, &a.counts); err != nil {
		return nil, err
	}
	return a, nil
}

// Record adds one label. A write failure is returned for the caller to log;
// the count stays in memory.
func (a *AutoStats) Record(mode, sentiment string, confidence float64, fallback bool) error {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.counts[autoKey(dayOf(a.Now()), mode, sentiment, ConfidenceBand(confidence), fallback)]++
	raw, err := json.MarshalIndent(a.counts, "", " ")
	if err != nil {
		return err
	}
	tmp := a.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, a.path)
}

// Counts is a copy of the counters, for tests.
func (a *AutoStats) Counts() map[string]int {
	a.mu.Lock()
	defer a.mu.Unlock()
	out := make(map[string]int, len(a.counts))
	for k, v := range a.counts {
		out[k] = v
	}
	return out
}
