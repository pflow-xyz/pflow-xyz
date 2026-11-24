// Package tabhub is the in-memory hub behind "tab push": a signed-in pflow.xyz
// page registers as a tab, listens on a stream of events, and reports what it
// shows; MCP tools push events to the tabs their caller owns and read the
// reports back.
//
// It is the same machine as BeatScript's hub (beatscript-serve src/hub/state.rs,
// Go btwsite server/sessions.go) with the same wire behaviour and constants:
// owners, subscribers, report / reply / get round trip, caps, sweep, and a clock
// the tests move by hand. docs/design/tab-push.md says what is shared and what is
// not. Nothing here is persisted and nothing here knows HTTP.
package tabhub

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"
)

// The caps and times BeatScript's hub uses (hub/state.rs), except MaxStateBytes
// (pflow's reports are small).
const (
	MaxTabs          = 5000
	MaxTabsPerUser   = 20
	MaxStreamsPerTab = 4
	MaxStreamsPerIP  = 40
	TabTTL           = 10 * time.Minute
	StateFresh       = 1500 * time.Millisecond
	GetWait          = 3 * time.Second
	MaxReportBytes   = 256 << 10
	MaxStateBytes    = 32 << 20
	subBuffer        = 16
)

// Error is a failure with the HTTP status and the machine code the routes and
// the MCP tools answer with.
type Error struct {
	Status int
	Code   string
	Msg    string
}

func (e *Error) Error() string { return e.Msg }

// ErrNoTab is the one answer for a tab that does not exist and for one that is
// someone else's: a caller cannot tell the two apart.
func ErrNoTab() *Error {
	return &Error{404, "no_tab", "no such tab (or it is not yours to drive)"}
}

// Event is what a tab receives. Net and Params are raw JSON (a private push
// carries the net here and nowhere else).
type Event struct {
	Type      string          `json:"type"`
	RequestID string          `json:"request_id,omitempty"`
	View      string          `json:"view,omitempty"`
	CID       string          `json:"cid,omitempty"`
	Net       json.RawMessage `json:"net,omitempty"`
	Params    json.RawMessage `json:"params,omitempty"`
	Note      string          `json:"note,omitempty"`
	Tab       string          `json:"tab,omitempty"`
	Views     []string        `json:"views,omitempty"`
}

// Report is what a page last said it shows: a bounded JSON object, kept as it
// arrived.
type Report = json.RawMessage

// Info is one row of List.
type Info struct {
	ID        string          `json:"id"`
	LastSeen  time.Time       `json:"last_seen"`
	Connected bool            `json:"connected"`
	State     json.RawMessage `json:"state,omitempty"`
}

// Clock is the hub's time source.
type Clock func() time.Time

// Subscription is one open stream of one tab.
type Subscription struct {
	C      <-chan Event
	tab    string
	id     uint64
	hub    *Hub
	closed bool
}

// Close releases the stream. Safe to call more than once.
func (s *Subscription) Close() {
	s.hub.unsubscribe(s.tab, s.id, s)
}

type sub struct {
	ch chan Event
}

type tab struct {
	id       string
	owner    string
	created  time.Time
	seen     time.Time
	subs     map[uint64]*sub
	report   Report
	reportAt time.Time
	pending  map[string]chan Report
}

// Hub holds the tabs.
type Hub struct {
	mu      sync.Mutex
	clock   Clock
	tabs    map[string]*tab
	nextSub uint64
	streams map[string]int
	bytes   int
}

// New returns an empty hub on the given clock (nil: the wall clock).
func New(clock Clock) *Hub {
	if clock == nil {
		clock = time.Now
	}
	return &Hub{clock: clock, tabs: map[string]*tab{}, streams: map[string]int{}}
}

// NewID is 16 random bytes, base64url: 22 characters (BeatScript's newID).
func NewID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b[:])
}

// Create registers a tab for owner ("provider:subject"). An empty owner is
// refused: an anonymous tab could be driven by anyone who learned its id.
func (h *Hub) Create(owner string) (string, error) {
	if owner == "" {
		return "", &Error{401, "auth_required", "a tab belongs to a signed-in account"}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked()
	if len(h.tabs) >= MaxTabs {
		return "", &Error{503, "too_many_tabs", "this server has as many open tabs as it keeps; try again later"}
	}
	n := 0
	for _, t := range h.tabs {
		if t.owner == owner {
			n++
		}
	}
	if n >= MaxTabsPerUser {
		return "", &Error{429, "too_many_tabs", "you have as many linked tabs as an account may keep; close one and try again"}
	}
	id := NewID()
	now := h.clock()
	h.tabs[id] = &tab{id: id, owner: owner, created: now, seen: now, subs: map[uint64]*sub{}, pending: map[string]chan Report{}}
	return id, nil
}

func (h *Hub) owned(id, owner string) *tab {
	t := h.tabs[id]
	if t == nil || owner == "" || t.owner != owner {
		return nil
	}
	return t
}

// AcquireStream counts an open stream against an address; false past
// MaxStreamsPerIP. Pair it with ReleaseStream.
func (h *Hub) AcquireStream(key string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.streams[key] >= MaxStreamsPerIP {
		return false
	}
	h.streams[key]++
	return true
}

// ReleaseStream undoes AcquireStream.
func (h *Hub) ReleaseStream(key string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.streams[key] > 0 {
		h.streams[key]--
		if h.streams[key] == 0 {
			delete(h.streams, key)
		}
	}
}

// Subscribe opens a stream of owner's tab. The first event is a hello naming
// the tab and the views the server knows.
func (h *Hub) Subscribe(id, owner string, views []string) (*Subscription, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.owned(id, owner)
	if t == nil {
		return nil, ErrNoTab()
	}
	if len(t.subs) >= MaxStreamsPerTab {
		return nil, &Error{429, "too_many_streams", "this tab already has as many open streams as it may; close one"}
	}
	h.nextSub++
	s := &sub{ch: make(chan Event, subBuffer)}
	t.subs[h.nextSub] = s
	t.seen = h.clock()
	s.ch <- Event{Type: "hello", Tab: id, Views: views}
	return &Subscription{C: s.ch, tab: id, id: h.nextSub, hub: h}, nil
}

func (h *Hub) unsubscribe(id string, n uint64, s *Subscription) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if s.closed {
		return
	}
	s.closed = true
	if t := h.tabs[id]; t != nil {
		if sb := t.subs[n]; sb != nil {
			delete(t.subs, n)
			close(sb.ch)
		}
		t.seen = h.clock()
	}
}

// deliver sends ev to every live stream of t; a stream whose buffer is full
// is dropped (its page reconnects) rather than blocking the caller.
func (h *Hub) deliver(t *tab, ev Event) bool {
	ok := false
	for n, s := range t.subs {
		select {
		case s.ch <- ev:
			ok = true
		default:
			delete(t.subs, n)
			close(s.ch)
		}
	}
	return ok
}

// Push delivers ev to owner's tab named by tabID, or, with tabID empty, to
// every tab of owner that has a live stream. It returns how many tabs had a
// live stream to receive it.
func (h *Hub) Push(owner, tabID string, ev Event) (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if owner == "" {
		return 0, &Error{401, "auth_required", "driving a tab needs a signed-in caller"}
	}
	var targets []*tab
	if tabID != "" {
		t := h.owned(tabID, owner)
		if t == nil {
			return 0, ErrNoTab()
		}
		targets = []*tab{t}
	} else {
		for _, t := range h.tabs {
			if t.owner == owner {
				targets = append(targets, t)
			}
		}
	}
	n := 0
	for _, t := range targets {
		if h.deliver(t, ev) {
			n++
		}
	}
	return n, nil
}

func (h *Hub) setReport(t *tab, r Report) {
	h.bytes += len(r) - len(t.report)
	t.report, t.reportAt, t.seen = r, h.clock(), h.clock()
}

// Report records what a page shows. False when the tab is not owner's. A
// report over MaxReportBytes, or one that would push the hub past
// MaxStateBytes, is refused.
func (h *Hub) Report(id, owner string, r Report) error {
	if len(r) > MaxReportBytes {
		return &Error{413, "too_large", "the report is larger than a tab may send"}
	}
	if !json.Valid(r) {
		return &Error{400, "bad_request", "the report must be JSON"}
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.owned(id, owner)
	if t == nil {
		return ErrNoTab()
	}
	if h.bytes-len(t.report)+len(r) > MaxStateBytes {
		return &Error{503, "busy", "the server holds as many tab reports as it keeps; try again later"}
	}
	h.setReport(t, r)
	return nil
}

// Reply answers a "get": it records the report and wakes the waiter. False
// for an unknown tab; an unknown request id still records the report.
func (h *Hub) Reply(id, owner, requestID string, r Report) error {
	if err := h.Report(id, owner, r); err != nil {
		return err
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if t := h.tabs[id]; t != nil {
		if ch, ok := t.pending[requestID]; ok {
			delete(t.pending, requestID)
			ch <- r
		}
	}
	return nil
}

// State is the latest report of one tab, asking the page with a "get" when
// the report is older than StateFresh, and waiting up to GetWait for the
// reply. tabID empty: owner's most recently seen tab. A page that does not
// answer leaves the last report, with fresh=false; no report at all is an
// error.
func (h *Hub) State(ctx context.Context, owner, tabID string, wantNet bool) (r Report, fresh bool, tabID2 string, err error) {
	h.mu.Lock()
	if owner == "" {
		h.mu.Unlock()
		return nil, false, "", &Error{401, "auth_required", "reading a tab needs a signed-in caller"}
	}
	var t *tab
	if tabID != "" {
		t = h.owned(tabID, owner)
	} else {
		for _, c := range h.tabs {
			if c.owner == owner && (t == nil || c.seen.After(t.seen)) {
				t = c
			}
		}
	}
	if t == nil {
		h.mu.Unlock()
		return nil, false, "", ErrNoTab()
	}
	if !wantNet && t.report != nil && h.clock().Sub(t.reportAt) < StateFresh {
		r, tabID2 = t.report, t.id
		h.mu.Unlock()
		return r, true, tabID2, nil
	}
	rid := NewID()
	ch := make(chan Report, 1)
	t.pending[rid] = ch
	ev := Event{Type: "get", RequestID: rid}
	if wantNet {
		ev.Params = json.RawMessage(`{"net":true}`)
	}
	sent := h.deliver(t, ev)
	last, id := t.report, t.id
	h.mu.Unlock()
	cleanup := func() {
		h.mu.Lock()
		if t := h.tabs[id]; t != nil {
			delete(t.pending, rid)
		}
		h.mu.Unlock()
	}
	if !sent {
		cleanup()
		if last == nil {
			return nil, false, id, &Error{409, "no_stream", "this tab has no open stream and has not reported: open the page and turn the link on"}
		}
		return last, false, id, nil
	}
	timer := time.NewTimer(GetWait)
	defer timer.Stop()
	select {
	case got := <-ch:
		return got, true, id, nil
	case <-timer.C:
	case <-ctx.Done():
	}
	cleanup()
	if last == nil {
		return nil, false, id, &Error{504, "timeout", "the tab did not answer"}
	}
	return last, false, id, nil
}

// List is owner's tabs, most recently seen first.
func (h *Hub) List(owner string) []Info {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked()
	var out []Info
	for _, t := range h.tabs {
		if owner != "" && t.owner == owner {
			out = append(out, Info{ID: t.id, LastSeen: t.seen, Connected: len(t.subs) > 0, State: json.RawMessage(t.report)})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].LastSeen.After(out[j].LastSeen) })
	return out
}

// Count is the number of tabs held.
func (h *Hub) Count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.tabs)
}

// Sweep drops tabs with no stream that have not been seen for TabTTL.
func (h *Hub) Sweep() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.sweepLocked()
}

func (h *Hub) sweepLocked() {
	now := h.clock()
	for id, t := range h.tabs {
		if len(t.subs) == 0 && now.Sub(t.seen) > TabTTL {
			h.bytes -= len(t.report)
			delete(h.tabs, id)
		}
	}
}

// Drop removes a tab (owner's) and closes its streams.
func (h *Hub) Drop(id, owner string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	t := h.owned(id, owner)
	if t == nil {
		return ErrNoTab()
	}
	for n, s := range t.subs {
		delete(t.subs, n)
		close(s.ch)
	}
	h.bytes -= len(t.report)
	delete(h.tabs, id)
	return nil
}

// Is reports whether err is a *Error with the code.
func Is(err error, code string) bool {
	var e *Error
	return errors.As(err, &e) && e.Code == code
}
