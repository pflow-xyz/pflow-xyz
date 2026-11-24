package tabhub

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) now() time.Time { c.mu.Lock(); defer c.mu.Unlock(); return c.t }
func (c *fakeClock) add(d time.Duration) {
	c.mu.Lock()
	c.t = c.t.Add(d)
	c.mu.Unlock()
}

func newHub() (*Hub, *fakeClock) {
	c := &fakeClock{t: time.Date(2026, 11, 24, 0, 0, 0, 0, time.UTC)}
	return New(c.now), c
}

func recv(t *testing.T, s *Subscription) Event {
	t.Helper()
	select {
	case ev, ok := <-s.C:
		if !ok {
			t.Fatal("stream closed")
		}
		return ev
	case <-time.After(2 * time.Second):
		t.Fatal("no event")
	}
	return Event{}
}

func TestCreateNeedsOwnerAndCaps(t *testing.T) {
	h, _ := newHub()
	if _, err := h.Create(""); !Is(err, "auth_required") {
		t.Fatalf("anonymous: %v", err)
	}
	for i := 0; i < MaxTabsPerUser; i++ {
		if _, err := h.Create("github:1"); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := h.Create("github:1"); !Is(err, "too_many_tabs") {
		t.Fatalf("over the per-user cap: %v", err)
	}
	if _, err := h.Create("github:2"); err != nil {
		t.Fatalf("another account is unaffected: %v", err)
	}
}

func TestOwnershipIsOneAnswer(t *testing.T) {
	h, _ := newHub()
	id, _ := h.Create("github:1")
	if _, err := h.Subscribe(id, "github:2", nil); !Is(err, "no_tab") {
		t.Fatal(err)
	}
	if _, err := h.Subscribe("nope", "github:1", nil); !Is(err, "no_tab") {
		t.Fatal(err)
	}
	if _, err := h.Push("github:2", id, Event{Type: "stop"}); !Is(err, "no_tab") {
		t.Fatal(err)
	}
	if err := h.Report(id, "github:2", Report(`{}`)); !Is(err, "no_tab") {
		t.Fatal(err)
	}
}

func TestPushCountsLiveStreams(t *testing.T) {
	h, _ := newHub()
	a, _ := h.Create("github:1")
	b, _ := h.Create("github:1")
	sa, _ := h.Subscribe(a, "github:1", []string{"canvas"})
	if ev := recv(t, sa); ev.Type != "hello" || ev.Tab != a || len(ev.Views) != 1 {
		t.Fatalf("hello: %+v", ev)
	}
	n, err := h.Push("github:1", "", Event{Type: "show", View: "canvas"})
	if err != nil || n != 1 {
		t.Fatalf("all tabs: %d %v (b=%s has no stream)", n, err, b)
	}
	if ev := recv(t, sa); ev.Type != "show" {
		t.Fatal(ev)
	}
	n, _ = h.Push("github:1", b, Event{Type: "stop"})
	if n != 0 {
		t.Fatalf("a tab with no stream receives nothing, and nothing is queued: %d", n)
	}
	sb, _ := h.Subscribe(b, "github:1", nil)
	if ev := recv(t, sb); ev.Type != "hello" {
		t.Fatalf("a later stream sees no backlog: %+v", ev)
	}
	select {
	case ev := <-sb.C:
		t.Fatalf("queued event: %+v", ev)
	default:
	}
}

func TestStreamCaps(t *testing.T) {
	h, _ := newHub()
	id, _ := h.Create("github:1")
	var subs []*Subscription
	for i := 0; i < MaxStreamsPerTab; i++ {
		s, err := h.Subscribe(id, "github:1", nil)
		if err != nil {
			t.Fatal(err)
		}
		subs = append(subs, s)
	}
	if _, err := h.Subscribe(id, "github:1", nil); !Is(err, "too_many_streams") {
		t.Fatal(err)
	}
	subs[0].Close()
	subs[0].Close() // twice is fine
	if _, err := h.Subscribe(id, "github:1", nil); err != nil {
		t.Fatalf("a closed stream frees its place: %v", err)
	}
	for i := 0; i < MaxStreamsPerIP; i++ {
		if !h.AcquireStream("1.2.3.4") {
			t.Fatal("under the cap")
		}
	}
	if h.AcquireStream("1.2.3.4") {
		t.Fatal("over the per-address cap")
	}
	h.ReleaseStream("1.2.3.4")
	if !h.AcquireStream("1.2.3.4") {
		t.Fatal("release frees one")
	}
}

func TestSlowStreamIsDroppedNotBlocking(t *testing.T) {
	h, _ := newHub()
	id, _ := h.Create("github:1")
	s, _ := h.Subscribe(id, "github:1", nil)
	for i := 0; i < subBuffer+5; i++ {
		h.Push("github:1", id, Event{Type: "ping"})
	}
	// the stream was closed by the hub: draining ends
	n := 0
	for range s.C {
		n++
	}
	if n == 0 {
		t.Fatal("buffered events should still drain")
	}
	if got := h.List("github:1")[0]; got.Connected {
		t.Fatal("dropped stream should not count as connected")
	}
	s.Close() // after a drop: no double close
}

func TestStateFreshStaleAndReply(t *testing.T) {
	h, clk := newHub()
	id, _ := h.Create("github:1")
	if _, _, _, err := h.State(context.Background(), "github:1", id, false); !Is(err, "no_stream") {
		t.Fatalf("no stream, no report: %v", err)
	}
	s, _ := h.Subscribe(id, "github:1", nil)
	recv(t, s) // hello
	// the page answers a get
	go func() {
		ev := recv(t, s)
		if ev.Type != "get" || ev.RequestID == "" {
			t.Errorf("get: %+v", ev)
			return
		}
		h.Reply(id, "github:1", ev.RequestID, Report(`{"view":"plot"}`))
	}()
	r, fresh, tabID, err := h.State(context.Background(), "github:1", "", false)
	if err != nil || !fresh || tabID != id || string(r) != `{"view":"plot"}` {
		t.Fatalf("state: %s %v %s %v", r, fresh, tabID, err)
	}
	// within StateFresh: no new get
	h.Report(id, "github:1", Report(`{"view":"canvas"}`))
	r, fresh, _, _ = h.State(context.Background(), "github:1", id, false)
	if !fresh || string(r) != `{"view":"canvas"}` {
		t.Fatalf("fresh report: %s %v", r, fresh)
	}
	select {
	case ev := <-s.C:
		t.Fatalf("a fresh report must not ask the page: %+v", ev)
	default:
	}
	// stale and the page is silent: the last report comes back, marked not fresh
	clk.add(time.Minute)
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	r, fresh, _, err = h.State(ctx, "github:1", id, false)
	if err != nil || fresh || string(r) != `{"view":"canvas"}` {
		t.Fatalf("silent page: %s %v %v", r, fresh, err)
	}
}

func TestStateWantNetAlwaysAsks(t *testing.T) {
	h, _ := newHub()
	id, _ := h.Create("github:1")
	s, _ := h.Subscribe(id, "github:1", nil)
	recv(t, s)
	h.Report(id, "github:1", Report(`{"view":"canvas"}`))
	go func() {
		ev := recv(t, s)
		if !strings.Contains(string(ev.Params), "net") {
			t.Errorf("get should ask for the net: %+v", ev)
		}
		h.Reply(id, "github:1", ev.RequestID, Report(`{"view":"canvas","net":{}}`))
	}()
	r, fresh, _, err := h.State(context.Background(), "github:1", id, true)
	if err != nil || !fresh || !strings.Contains(string(r), `"net"`) {
		t.Fatalf("%s %v %v", r, fresh, err)
	}
}

func TestReportLimits(t *testing.T) {
	h, _ := newHub()
	id, _ := h.Create("github:1")
	if err := h.Report(id, "github:1", Report(`{not json`)); !Is(err, "bad_request") {
		t.Fatal(err)
	}
	big := Report(`"` + strings.Repeat("x", MaxReportBytes) + `"`)
	if err := h.Report(id, "github:1", big); !Is(err, "too_large") {
		t.Fatal(err)
	}
}

func TestSweepKeepsTabsWithStreams(t *testing.T) {
	h, clk := newHub()
	a, _ := h.Create("github:1")
	b, _ := h.Create("github:1")
	h.Subscribe(b, "github:1", nil)
	clk.add(TabTTL + time.Second)
	h.Sweep()
	if h.Count() != 1 {
		t.Fatalf("count %d (a=%s b=%s)", h.Count(), a, b)
	}
	if got := h.List("github:1"); len(got) != 1 || got[0].ID != b || !got[0].Connected {
		t.Fatalf("%+v", got)
	}
}

func TestListNewestFirstAndPrivateToOwner(t *testing.T) {
	h, clk := newHub()
	a, _ := h.Create("github:1")
	clk.add(time.Second)
	b, _ := h.Create("github:1")
	h.Create("github:2")
	got := h.List("github:1")
	if len(got) != 2 || got[0].ID != b || got[1].ID != a {
		t.Fatalf("%+v", got)
	}
	if len(h.List("")) != 0 {
		t.Fatal("no caller, no tabs")
	}
}

func TestDrop(t *testing.T) {
	h, _ := newHub()
	id, _ := h.Create("github:1")
	s, _ := h.Subscribe(id, "github:1", nil)
	if err := h.Drop(id, "github:2"); !Is(err, "no_tab") {
		t.Fatal(err)
	}
	if err := h.Drop(id, "github:1"); err != nil {
		t.Fatal(err)
	}
	recv(t, s) // hello, then closed
	if _, ok := <-s.C; ok {
		t.Fatal("stream should close")
	}
}

// The vectors file is the cross-implementation contract (docs/design/tab-push.md).
func TestVectors(t *testing.T) {
	raw, err := os.ReadFile("testdata/vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var f struct {
		Cases []struct {
			Name  string
			Steps []map[string]any
		}
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	for _, c := range f.Cases {
		t.Run(c.Name, func(t *testing.T) {
			h, _ := newHub()
			tabs := map[string]string{}
			subs := map[string]*Subscription{}
			str := func(m map[string]any, k string) string { s, _ := m[k].(string); return s }
			for i, st := range c.Steps {
				exp, _ := st["expect"].(map[string]any)
				wantErr := str(exp, "error")
				check := func(err error) bool {
					if wantErr == "" {
						if err != nil {
							t.Fatalf("step %d: %v", i, err)
						}
						return false
					}
					if !Is(err, wantErr) {
						t.Fatalf("step %d: want error %s, got %v", i, wantErr, err)
					}
					return true
				}
				owner := str(st, "owner")
				switch st["op"] {
				case "create":
					id, err := h.Create(owner)
					if check(err) {
						continue
					}
					tabs[str(st, "as")] = id
				case "subscribe":
					s, err := h.Subscribe(tabs[str(st, "tab")], owner, nil)
					if check(err) {
						continue
					}
					subs[str(st, "as")] = s
					if f := str(exp, "first"); f != "" {
						if ev := recv(t, s); ev.Type != f {
							t.Fatalf("step %d: first %s", i, ev.Type)
						}
					}
				case "push":
					evm, _ := json.Marshal(st["event"])
					var ev Event
					json.Unmarshal(evm, &ev)
					n, err := h.Push(owner, tabs[str(st, "tab")], ev)
					if check(err) {
						continue
					}
					if want, ok := exp["delivered"].(float64); ok && int(want) != n {
						t.Fatalf("step %d: delivered %d want %v", i, n, want)
					}
				case "recv":
					ev := recv(t, subs[str(st, "sub")])
					if ev.Type != str(exp, "type") || (str(exp, "view") != "" && ev.View != str(exp, "view")) {
						t.Fatalf("step %d: %+v", i, ev)
					}
				case "state":
					id := tabs[str(st, "tab")]
					s := subs["s"]
					ans, _ := json.Marshal(st["answerWith"])
					go func() {
						for ev := range s.C {
							if ev.Type == "get" {
								h.Reply(id, owner, ev.RequestID, Report(ans))
								return
							}
						}
					}()
					r, fresh, _, err := h.State(context.Background(), owner, id, false)
					if check(err) {
						continue
					}
					want, _ := json.Marshal(exp["report"])
					if string(r) != string(want) || fresh != exp["fresh"] {
						t.Fatalf("step %d: %s %v", i, r, fresh)
					}
				default:
					t.Fatalf("unknown op %v", st["op"])
				}
			}
		})
	}
}
