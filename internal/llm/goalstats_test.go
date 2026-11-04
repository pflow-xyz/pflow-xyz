package llm

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestGoalStatsCountsPerDayAndGoalAndSurvivesRestart(t *testing.T) {
	dir := t.TempDir()
	g, err := NewGoalStats(dir)
	if err != nil {
		t.Fatal(err)
	}
	day1 := time.Date(2026, 11, 1, 23, 59, 0, 0, time.UTC)
	g.Now = func() time.Time { return day1 }
	for _, c := range []struct {
		goal            string
		in, out, thinks int
	}{
		{"risk", 1000, 40, 100}, {"risk", 1200, 60, 0}, {"stuck", 900, 20, 10}, {NoGoal, 800, 80, 0},
	} {
		if err := g.Record(c.goal, c.in, c.out, c.thinks); err != nil {
			t.Fatal(err)
		}
	}
	g.Now = func() time.Time { return day1.Add(2 * time.Minute) } // past midnight UTC
	if err := g.Record("risk", 500, 5, 0); err != nil {
		t.Fatal(err)
	}
	want := map[string]GoalCount{
		"2026-11-01|risk":  {Count: 2, In: 2200, Out: 100, Thoughts: 100},
		"2026-11-01|stuck": {Count: 1, In: 900, Out: 20, Thoughts: 10},
		"2026-11-01|none":  {Count: 1, In: 800, Out: 80},
		"2026-11-02|risk":  {Count: 1, In: 500, Out: 5},
	}
	got := g.Counts()
	if len(got) != len(want) {
		t.Fatalf("%v", got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s: %+v, want %+v", k, got[k], v)
		}
	}
	// a restart keeps the counts and goes on from them
	g2, err := NewGoalStats(dir)
	if err != nil {
		t.Fatal(err)
	}
	g2.Now = func() time.Time { return day1.Add(2 * time.Minute) }
	if err := g2.Record("risk", 100, 1, 0); err != nil {
		t.Fatal(err)
	}
	if c := g2.Counts()["2026-11-02|risk"]; c != (GoalCount{Count: 2, In: 600, Out: 6}) {
		t.Fatalf("after restart: %+v", c)
	}
	if info, err := os.Stat(filepath.Join(dir, "goal-stats.json")); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("goal-stats.json: %v %v", info, err)
	}
	if _, err := os.Stat(filepath.Join(dir, "goal-stats.json.tmp")); !os.IsNotExist(err) {
		t.Fatal("the temporary file was left behind")
	}
}

// Nothing that identifies a person goes in, and what a caller passes cannot
// widen the file: an id that is not a goal's is counted as none.
func TestGoalStatsIsAnonymousAndBounded(t *testing.T) {
	dir := t.TempDir()
	g, _ := NewGoalStats(dir)
	g.Now = func() time.Time { return time.Date(2026, 11, 1, 12, 0, 0, 0, time.UTC) }
	for _, id := range []string{"octocat@example.com", "Risk", "", "has space", strings.Repeat("a", 60), "rm -rf"} {
		if err := g.Record(id, 1, 1, 0); err != nil {
			t.Fatal(err)
		}
	}
	got := g.Counts()
	if len(got) != 1 || got["2026-11-01|none"].Count != 6 {
		t.Fatalf("%v", got)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "goal-stats.json"))
	for _, leak := range []string{"octocat", "example.com", "gh_id", "login", "T12:"} {
		if strings.Contains(string(raw), leak) {
			t.Fatalf("%q in %s", leak, raw)
		}
	}
}

func TestGoalStatsRefusesACorruptFileAndKeepsCountsOnWriteFailure(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "goal-stats.json"), []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := NewGoalStats(dir); err == nil {
		t.Fatal("a corrupt stats file must not be silently replaced")
	}
	g, _ := NewGoalStats(t.TempDir())
	g.path = filepath.Join(dir, "no", "such", "dir", "goal-stats.json")
	if err := g.Record("risk", 1, 1, 0); err == nil {
		t.Fatal("a write failure is returned for the caller to log")
	}
	if g.Counts()[dayOf(time.Now())+"|risk"].Count != 1 {
		t.Fatal("the count stays in memory")
	}
}
