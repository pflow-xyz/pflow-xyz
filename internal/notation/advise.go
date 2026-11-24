// SPDX-License-Identifier: MIT

package notation

import (
	"fmt"
	"sort"
	"strings"

	pflowparser "github.com/pflow-xyz/go-pflow/parser"
	"github.com/pflow-xyz/go-pflow/reachability"
	"github.com/pflow-xyz/go-pflow/verify"
)

// Advise is the third tier of the advisor: the verdicts go-pflow's verifier (the one
// behind the pflow_verify tool and Check net) computes, put on the line of the text that
// is responsible. It adds no analysis of its own. It asks the verifier four questions
// (deadlock-free, bounded, live, l4-live) and the incidence matrix for its P-invariants,
// and anchors each answer to the declaration of a place or a transition, or to the `net`
// line when the answer is about the net as a whole.
//
// The verdicts keep the verifier's three values. A search that stopped at maxStates
// proves nothing, and the diagnostic says "unknown" and carries the bound; only a
// refutation with a witness, or a proof with its method, is stated as fact.
func Advise(f *File, doc Obj, maxStates int) ([]Diagnostic, error) {
	net, err := pflowparser.FromJSON(MarshalJSON(doc))
	if err != nil {
		return nil, err
	}
	net.Token = pflowparser.ShortColorNames(net.Token) // "pool.red", not "pool.https://pflow.xyz/tokens/red"
	spanOf := map[string]Span{}
	order := map[string]int{}
	for _, p := range f.Places {
		spanOf[p.ID.Name] = p.ID.Span
		order[p.ID.Name] = len(order)
	}
	for _, t := range f.Transitions {
		spanOf[t.ID.Name] = t.ID.Span
		order[t.ID.Name] = len(order)
	}
	netSpan := Span{}
	for _, s := range f.Stmts {
		if s.Kind == "net" {
			netSpan = s.Span
		}
	}
	unfolded, cm := net.ExpandColors()
	base := func(id string) string {
		if cm != nil {
			if r, ok := cm.Base[id]; ok {
				return r.Place
			}
		}
		return id
	}
	var ds []Diagnostic
	add := func(sev Severity, sp Span, msg, help string, rel []Related, data Obj) {
		ds = append(ds, Diagnostic{Severity: sev, Source: "analysis", Span: sp, Message: msg, Help: help, Related: rel, Data: data})
	}
	spanFor := func(ids ...string) (Span, []Related) {
		var names []string
		seen := map[string]bool{}
		for _, id := range ids {
			b := base(id)
			if _, ok := spanOf[b]; ok && !seen[b] {
				seen[b] = true
				names = append(names, b)
			}
		}
		if len(names) == 0 {
			return netSpan, nil
		}
		sort.SliceStable(names, func(i, j int) bool { return order[names[i]] < order[names[j]] })
		var rel []Related
		for _, n := range names[1:] {
			rel = append(rel, Related{spanOf[n], "also"})
		}
		return spanOf[names[0]], rel
	}

	// P-invariants: laws that hold at every reachable marking, proved from the incidence
	// matrix with no search. A law whose value is 0 only says a colour copy no arc
	// touches stays empty; it is left out.
	initial := reachability.Marking{}
	for id, p := range unfolded.Places {
		initial[id] = int(p.GetTokenCount())
	}
	invs := reachability.NewInvariantAnalyzer(unfolded).FindPInvariants(initial)
	sort.SliceStable(invs, func(i, j int) bool { return invs[i].String() < invs[j].String() })
	for _, inv := range invs {
		if inv.Value == 0 {
			continue
		}
		sp, rel := spanFor(inv.Places...)
		for i := range rel {
			rel[i].Message = "also in the law"
		}
		add(Info, sp, "conserved: "+inv.String()+", at every reachable marking", "proved from the incidence matrix (a P-invariant): no search was needed", rel,
			Obj{{"kind", "p-invariant"}, {"verdict", "proved"}, {"method", "structural"}, {"law", inv.String()}})
	}

	rep := verify.New(net).WithMaxStates(maxStates).Check(
		verify.Property{Kind: verify.KindBounded},
		verify.Property{Kind: verify.KindDeadlockFree},
		verify.Property{Kind: verify.KindLive},   // L1: every transition fires somewhere
		verify.Property{Kind: verify.KindL4Live}, // L4: and from everywhere, again
	)
	bound := fmt.Sprintf("the search stopped at %d markings", rep.StateCount)
	var unknown []string
	neverFires := map[string]bool{}
	for _, v := range rep.Verdicts {
		if v.Property.Kind == verify.KindLive && v.Status == verify.Refuted {
			for _, t := range namedIn(v.Detail, f) {
				neverFires[t] = true
			}
		}
	}
	for _, v := range rep.Verdicts {
		kind := string(v.Property.Kind)
		data := Obj{{"kind", kind}, {"verdict", string(v.Status)}, {"method", string(v.Method)}}
		if v.Evidence != "" {
			data = append(data, KV{"evidence", v.Evidence})
		}
		var trace []string
		var where []string
		if ce := v.Counterexample; ce != nil {
			trace = ce.Trace
			data = append(data, KV{"witness", toAny(ce.Trace)})
			for p, n := range ce.Marking {
				if n > 0 {
					where = append(where, p)
				}
			}
			sort.Strings(where)
		}
		switch v.Status {
		case verify.Proved:
			if v.Property.Kind == verify.KindL4Live || v.Property.Kind == verify.KindLive {
				continue // said by the lack of a warning on any transition
			}
			add(Info, netSpan, kind+": "+v.Detail, string(v.Method)+evidenceNote(v), nil, data)
		case verify.Refuted:
			switch v.Property.Kind {
			case verify.KindBounded:
				sp, rel := spanFor(where...)
				add(Warning, sp, "unbounded: "+v.Detail, "add a capacity, or let the net give the token back"+traceNote(trace), rel, data)
			case verify.KindLive:
				// the detail names the transitions no reachable marking enables: a warning on each
				for _, t := range namedIn(v.Detail, f) {
					add(Warning, spanOf[t], fmt.Sprintf("`%s` never fires: no reachable marking enables it", t), "its inputs are never all marked together, or an inhibitor arc always blocks it", nil, data)
				}
			case verify.KindL4Live:
				// the transitions that fire somewhere but can be shut out for good: the witness says after what
				for _, t := range namedIn(v.Detail, f) {
					if neverFires[t] {
						continue
					}
					add(Warning, spanOf[t], fmt.Sprintf("`%s` can fire no more once %s has fired", t, replay(trace)), "from there on nothing enables it; the editor can replay the sequence", nil, data)
				}
			default:
				add(Warning, netSpan, kind+" is refuted: "+v.Detail, "firing "+replay(trace)+" shows it", nil, data)
			}
		default:
			unknown = append(unknown, kind)
		}
	}
	if len(unknown) > 0 { // one note, not one for each question the search could not finish
		add(Info, netSpan, strings.Join(unknown, ", ")+": unknown, "+bound, "raise the bound, or add a capacity so the search can finish: an unknown is not a pass", nil,
			Obj{{"kind", "search"}, {"verdict", "unknown"}, {"unknown", toAny(unknown)}, {"states", rep.StateCount}})
	}
	sort.SliceStable(ds, func(i, j int) bool { return ds[i].Span.Start < ds[j].Span.Start })
	return ds, nil
}

func evidenceNote(v verify.Verdict) string {
	if v.Evidence == "" {
		return ""
	}
	return ": " + v.Evidence
}

func traceNote(trace []string) string {
	if len(trace) == 0 {
		return ""
	}
	return " (fire " + strings.Join(trace, ", ") + ")"
}

// namedIn returns the transitions of the file whose names occur in a verifier detail.
func namedIn(detail string, f *File) []string {
	var out []string
	for _, t := range f.Transitions {
		if strings.Contains(detail, t.ID.Name) {
			out = append(out, t.ID.Name)
		}
	}
	return out
}

func replay(trace []string) string {
	if len(trace) == 0 {
		return "nothing: the initial marking itself"
	}
	return strings.Join(trace, ", ")
}

func toAny(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}
