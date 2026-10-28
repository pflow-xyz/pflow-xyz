package main

// The composition catalog behind pflow_bundle_example: the six pattern
// instances the composition page composes (orders, workers, payment and the
// extras payment2, orders2, workers2), the three idioms that link the first
// three, and the four scenarios that fire the result. It is pflow-native's
// catalog (crates/core/src/composition/mod.rs) in Go: the parameters, the
// reasons for them and the scenarios are that page's judgment, copied; the
// subnets are built by go-pflow's own constructors (metamodel.NewQueue, the
// resource pool's ToSubnet, saga.ToMetaSubnet) where native uses pflow-compose's
// ports of them. parity/native/mcp_goldens.json holds both to the same places,
// transitions, arcs, ports and constraints (TestMCPBundleCatalogMatchesNative).

import (
	"fmt"
	"strings"

	"github.com/pflow-xyz/go-pflow/metamodel"
	"github.com/pflow-xyz/go-pflow/saga"
)

// mbInstanceSpec is one instance of a pattern with the parameters it is built from.
type mbInstanceSpec struct {
	ID      string
	Pattern string
	Extra   bool
	Params  map[string]any
	Why     string
}

// mbParamsNote is native's PARAMS_NOTE.
const mbParamsNote = "Parameters are this page's choice (judgment): the description fixes the patterns, not their sizes."

func mbSagaParams(id string, customer int, shared bool) map[string]any {
	return map[string]any{
		"id": id,
		"accounts": map[string]any{
			"customer": map[string]any{"initial": customer, "shared": shared},
			"merchant": map[string]any{"initial": 0, "shared": shared},
		},
		"steps": []any{
			map[string]any{"id": "reserve", "name": "reserve stock", "compensation": "release stock", "moves": []any{}},
			map[string]any{"id": "charge", "name": "charge card", "compensation": "refund",
				"moves": []any{map[string]any{"from": "customer", "to": "merchant", "amount": 1}}},
		},
	}
}

// mbCatalog lists the six instances, in native's order.
var mbCatalog = []mbInstanceSpec{
	{"orders", "queue", false, map[string]any{"ID": "orders", "Capacity": 3, "Initial": 2, "Payload": ""},
		"Bounded (capacity 3) so the capacity invariant exists; two orders waiting so the one-saga-per-order caveat shows up in a run."},
	{"workers", "resource-pool", false, map[string]any{"id": "workers", "name": "workers", "capacity": 2},
		"\"a fixed number of workers\": two."},
	{"payment", "saga", false, mbSagaParams("payment", 1, false),
		"Two steps so compensation runs in reverse; charge moves one token, so its compensation is the refund. \"A failed payment must refund\" is fail_commit after the charge."},
	{"payment2", "saga", true, mbSagaParams("payment2", 0, true),
		"A second order needs a second saga (one saga is one case). Its accounts are shared, so a token link to payment's accounts makes one balance."},
	{"orders2", "queue", true, map[string]any{"ID": "orders2", "Capacity": 3, "Initial": 0, "Payload": ""},
		"A second queue: out of one into in of the other is a token link (a cospan composite)."},
	{"workers2", "resource-pool", true, map[string]any{"id": "workers2", "name": "workers2", "capacity": 1},
		"A second pool: its available place can be token-linked to the first pool's."},
}

// mbDefaultInstances is the default composition's instances.
var mbDefaultInstances = []string{"orders", "workers", "payment"}

func mbInstance(id string) *mbInstanceSpec {
	for i := range mbCatalog {
		if mbCatalog[i].ID == id {
			return &mbCatalog[i]
		}
	}
	return nil
}

func mbCatalogIDs() []string {
	out := make([]string, len(mbCatalog))
	for i, s := range mbCatalog {
		out[i] = s.ID
	}
	return out
}

// mbQuote lists strings the way Rust's {:?} of a Vec<&str> does, which is the
// text native's refusals carry: ["a", "b"].
func mbQuote(ss []string) string {
	q := make([]string, len(ss))
	for i, s := range ss {
		q[i] = fmt.Sprintf("%q", s)
	}
	return "[" + strings.Join(q, ", ") + "]"
}

func mbInt(p map[string]any, k string) int {
	n, _ := p[k].(int)
	return n
}

// build makes the instance's subnet.
func (s *mbInstanceSpec) build() (*metamodel.Subnet, error) {
	p := s.Params
	switch s.Pattern {
	case "queue":
		return metamodel.NewQueue(metamodel.QueueSpec{
			ID: p["ID"].(string), Capacity: mbInt(p, "Capacity"), Initial: mbInt(p, "Initial"),
		})
	case "resource-pool":
		return metamodel.NewResourcePool(p["name"].(string), mbInt(p, "capacity"), struct{}{}).ToSubnet(p["id"].(string)), nil
	case "saga":
		b := saga.New(p["id"].(string))
		accounts := p["accounts"].(map[string]any)
		for _, id := range []string{"customer", "merchant"} { // sorted, as native sorts them
			a := accounts[id].(map[string]any)
			if a["shared"] == true {
				b = b.SharedAccount(id)
			} else {
				b = b.Account(id, mbInt(a, "initial"))
			}
		}
		for _, raw := range p["steps"].([]any) {
			st := raw.(map[string]any)
			sb := b.Step(st["id"].(string))
			if name, _ := st["name"].(string); name != "" {
				sb = sb.Name(name)
			}
			if comp, _ := st["compensation"].(string); comp != "" {
				sb = sb.Compensate(comp)
			}
			for _, m := range st["moves"].([]any) {
				mv := m.(map[string]any)
				sb = sb.Move(mv["from"].(string), mv["to"].(string), mbInt(mv, "amount"))
			}
			b = sb.Done()
		}
		sg, err := b.BuildValidated()
		if err != nil {
			return nil, err
		}
		return sg.ToMetaSubnet(), nil
	}
	return nil, fmt.Errorf("unknown pattern %q", s.Pattern)
}

// mbDefaultLinks are the three idioms, on the default instances.
func mbDefaultLinks() []metamodel.Link {
	ev := func(a, ap, b, bp string) metamodel.Link {
		return metamodel.Link{Kind: metamodel.EventLink, From: metamodel.Endpoint{Subnet: a, Port: ap}, To: metamodel.Endpoint{Subnet: b, Port: bp}}
	}
	return []metamodel.Link{
		ev("orders", "dequeue", "workers", "acquire"),
		ev("orders", "dequeue", "payment", "do:reserve"),
		ev("workers", "release", "payment", "commit"),
	}
}

// ---- scenarios

// mbExpect is a predicate on the marking at the end of a run.
type mbExpect struct {
	Place string
	N     int
	Says  string
}

// mbScenario is a firing script in members "<subnet>/<transition>" with its
// expected predicates: judgment, frozen in native from the prototype.
type mbScenario struct {
	ID     string
	Title  string
	Script []string
	Expect []mbExpect
	Note   string
}

var mbScenarios = []mbScenario{
	{"commit", "An order is paid", []string{"orders/dequeue", "payment/do_charge", "payment/commit"},
		[]mbExpect{{"payment/completed", 1, "the saga completes"}, {"workers/available", 2, "the worker returns to the pool"}}, ""},
	{"refund", "The payment fails after the charge (refund)",
		[]string{"orders/dequeue", "payment/do_charge", "payment/fail_commit", "payment/undo_charge", "payment/undo_reserve"},
		[]mbExpect{{"payment/rolled_back", 1, "the saga rolls back"}, {"payment/customer", 1, "the customer is refunded"}, {"workers/available", 2, "the worker returns to the pool"}},
		"Expected to fail on the last predicate: release is fused only with commit (the pool-leak caveat, patterns.ttl:496)."},
	{"charge-fails", "The charge itself fails (nothing to refund)",
		[]string{"orders/dequeue", "payment/fail_charge", "payment/undo_reserve"},
		[]mbExpect{{"payment/rolled_back", 1, "the saga rolls back"}, {"payment/customer", 1, "the customer was never charged"}, {"workers/available", 2, "the worker returns to the pool"}},
		"A step that fails itself moved nothing, so there is nothing to refund (saga caveat). The worker leaks here too."},
	{"second-order", "A second order, one saga",
		[]string{"orders/dequeue", "payment/do_charge", "payment/commit", "orders/dequeue"},
		[]mbExpect{{"orders/items", 0, "both orders are taken off the queue"}},
		"Expected to stop at the last step: the fused dequeue needs next_reserve, which the one-shot saga has spent (saga caveat: one saga is one case)."},
}

func mbScenarioByID(id string) *mbScenario {
	for i := range mbScenarios {
		if mbScenarios[i].ID == id {
			return &mbScenarios[i]
		}
	}
	return nil
}

func mbScenarioIDs() []string {
	out := make([]string, len(mbScenarios))
	for i, s := range mbScenarios {
		out[i] = s.ID
	}
	return out
}

func (s *mbScenario) view() map[string]any {
	expect := make([]any, len(s.Expect))
	for i, e := range s.Expect {
		expect[i] = map[string]any{"place": e.Place, "op": "==", "n": e.N, "says": e.Says}
	}
	out := map[string]any{"id": s.ID, "title": s.Title, "script": mbStrings(s.Script), "expect": expect}
	if s.Note != "" {
		out["note"] = s.Note
	}
	return out
}

func mbStrings(ss []string) []any {
	out := make([]any, len(ss))
	for i, s := range ss {
		out[i] = s
	}
	return out
}
