package llm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sync"
	"time"
)

// NoGoal is the key for a goal-toolset turn that ran no goal (a question to
// the person, a build edit, a composed command, a plain answer).
const NoGoal = "none"

// GoalCount is what the turns of one goal on one day cost.
type GoalCount struct {
	Count    int `json:"count"`    // model calls
	In       int `json:"in"`       // prompt tokens
	Out      int `json:"out"`      // visible output tokens
	Thoughts int `json:"thoughts"` // hidden reasoning tokens, billed as output
}

// GoalStats is the cost per goal the design asks for (docs/design/
// agent-first-analysis.md section 10: "cost per goal is visible"), kept the way
// AutoStats keeps its labels: nothing that identifies a person (no user id or
// login, no message text), no time finer than the UTC day, one small JSON file
// (goal-stats.json in the limiter's directory) rewritten atomically so it
// cannot be joined to the usage log's per-call timestamps. It is separate
// from the usage log on purpose: the billing-alarm input, limits.go's Usage,
// is not changed for this.
//
// A key is "<UTC day>|<goal id>"; the id is a goal of goals.json or NoGoal.
type GoalStats struct {
	mu     sync.Mutex
	path   string
	Now    func() time.Time
	counts map[string]GoalCount
}

// goalIDPattern is what a goal id looks like (goals.json's ids). Anything else
// is counted as NoGoal, so the file stays as small as the catalog whatever a
// caller passes.
var goalIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]{0,47}$`)

// NewGoalStats loads dir/goal-stats.json if it exists.
func NewGoalStats(dir string) (*GoalStats, error) {
	g := &GoalStats{path: filepath.Join(dir, "goal-stats.json"), Now: time.Now, counts: map[string]GoalCount{}}
	raw, err := os.ReadFile(g.path)
	switch {
	case os.IsNotExist(err):
		return g, nil
	case err != nil:
		return nil, err
	}
	if err := json.Unmarshal(raw, &g.counts); err != nil {
		return nil, err
	}
	return g, nil
}

// Record adds one model call for goal (NoGoal for none) and its tokens. A
// write failure is returned for the caller to log; the count stays in memory.
func (g *GoalStats) Record(goal string, in, out, thoughts int) error {
	if goal != NoGoal && !goalIDPattern.MatchString(goal) {
		goal = NoGoal
	}
	g.mu.Lock()
	defer g.mu.Unlock()
	k := dayOf(g.Now()) + "|" + goal
	c := g.counts[k]
	c.Count++
	c.In += in
	c.Out += out
	c.Thoughts += thoughts
	g.counts[k] = c
	raw, err := json.MarshalIndent(g.counts, "", " ")
	if err != nil {
		return err
	}
	tmp := g.path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, g.path)
}

// Counts is a copy of the counters, for tests.
func (g *GoalStats) Counts() map[string]GoalCount {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := make(map[string]GoalCount, len(g.counts))
	for k, v := range g.counts {
		out[k] = v
	}
	return out
}
