package main

// The /mcp composition tools that go further than the composition page's
// bundle.* commands: pflow_bundle_net, pflow_bundle_prove,
// pflow_bundle_check_proof and pflow_bundle_parts. They are go-pflow's
// composite package (a port of pflow-rs's crates/pflow-hosted bundle tools,
// which are their reference: composite/testdata/composite.json in go-pflow is
// the golden), registered here as thinly as the other pflow_bundle_* tools:
// the same bundle argument, the same limits and argument checks, the same
// stateless, model-in-argument shape.
//
// The problem they solve: a flattened bundle is not an ordinary pflow.xyz net,
// so pflow_fire, pflow_simulate, pflow_reachability, pflow_invariants and
// pflow_verify could not read a composite. pflow_bundle_net writes it in the
// editor's JSON-LD; pflow_bundle_prove judges what each link does to the
// parts it joins and leaves a record pflow_bundle_check_proof re-checks.
//
// Answers are bounded like every tool's: a net is refused rather than cut when
// it would pass the result limit (a cut net is not the composite), and a proof
// record that would pass it is answered by its summary alone, saying so, since
// a cut record cannot be checked.

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/pflow-xyz/go-pflow/composite"
	"github.com/pflow-xyz/pflow-xyz/internal/seal"
)

func init() {
	for name, a := range map[string]mcpAnnotation{
		"pflow_bundle_net":         {"A composition as an ordinary net", true, false, true},
		"pflow_bundle_prove":       {"Check what a composition's links do", true, false, true},
		"pflow_bundle_check_proof": {"Re-check a composition proof record", true, false, true},
		"pflow_bundle_parts":       {"Larger parts catalog; build a composition", true, false, true},
	} {
		mcpAnnotations[name] = a
	}
	// The CID of the flat net is the one internal/seal gives every net (the
	// general JSON-LD processor), not composite's small port of it.
	composite.Sealer = func(doc map[string]any) (string, error) {
		raw, err := json.Marshal(doc)
		if err != nil {
			return "", err
		}
		cid, _, err := seal.SealJSONLD(raw)
		return cid, err
	}
}

var (
	bundleNetKinds        = map[string]argKind{"bundle": argAny}
	bundleProveKinds      = map[string]argKind{"bundle": argAny, "max_states": argAny, "max_tokens": argAny, "ablate": argBool}
	bundleCheckProofKinds = map[string]argKind{"bundle": argAny, "proof": argAny}
	bundlePartsKinds      = map[string]argKind{"instances": argAny, "links": argAny}
)

func compositeTools() []mcpTool {
	partIDs := make([]any, 0, 13)
	for _, id := range composite.PartIDs() {
		partIDs = append(partIDs, id)
	}
	return []mcpTool{
		{
			Name: "pflow_bundle_net",
			Description: "Flatten a composition into an ordinary pflow.xyz net: the same flat net pflow_bundle_flatten returns, written in the editor's JSON-LD format (places and transitions keyed by id, source/target arcs; a read arc is a transition-to-place arc with inhibitTransition, an inhibitor a place-to-transition one; weights are at least 1, a place's capacity is its one-colour capacity, a ':' in an id is written '~', laid out one column per subnet). " +
				"The returned `net` loads in the other net tools: pflow_check, pflow_info, pflow_fire, pflow_simulate, pflow_reachability, pflow_invariants, pflow_incidence, pflow_verify, pflow_validate, pflow_cid and pflow_export read a composite exactly as they read any net, so you can fire it, verify it, find its conservation laws or open it in the editor. " +
				"`members` says which <subnet>/<element> each flat place and transition came from (and the declared constraints, subnet order). A bundle Validate refuses answers {ok: false, error}. A flat net the editor's format cannot say (a transition guard, a data place) answers {ok: false, unrepresentable: [...]} and no net: a net that ran differently from the composite would be worse than none. " +
				"A net whose answer would pass the result limit is an error of the call, not a cut net.",
			InputSchema: obj(map[string]any{"bundle": bundleArg}, "bundle"),
			run:         mcpBundleNet,
		},
		{
			Name: "pflow_bundle_prove",
			Description: "Do the links of a composition keep their promises? Judges what each link does to the parts it joins, by their behaviour, not only their ports (pflow_bundle_validate does ports). " +
				"Returns a proof record (type \"CompositionProof\"): (1) laws: every conservation law of every part (its declared constraints and the minimal P-invariants of the part alone) lifted onto the composite's places and classified preserved (still y·C = 0), extended (it is the part's share of a larger composite law z, which is named) or changed (the composite moves it; the residual says by which transitions); a declared law is also tried on every reachable marking, with a replayable counterexample trace when it breaks. " +
				"(2) claims: bounded, deadlock_free and quasi_live for the composite, each proved, refuted (with a replayable witness) or unknown; a search that stopped at max_states never proves anything. " +
				"(3) links: each link's verdict ok, explained, warn or fail, found by ablation (flatten without the link, search again): a deadlock, unbounded growth or blocked transition that exists with the link and not without it is the link's; a part that finishes on its own (a saga) explains the dead marking it brings. " +
				"(4) an overall verdict: consistent, consistent_with_notes, needs_attention, inconsistent or inconclusive. " +
				"`composite.cid` names the flat net pflow_bundle_net returns, which loads in the other pflow_* net tools. Pass the record to pflow_bundle_check_proof to re-check it. " +
				"Limits: max_states (default 2000, at most 20000) bounds every search; max_tokens (default 1000) is the unboundedness cap; ablate:false skips the per-link searches (at most 60 links are judged by ablation). " +
				"A flat net with a guard or a data place is refused (the analyses do not evaluate them). A record that would pass the result limit is answered by its summary alone (record_omitted), since a cut record cannot be checked: prove a smaller composition or pass ablate:false.",
			InputSchema: obj(map[string]any{
				"bundle":     bundleArg,
				"max_states": map[string]any{"type": "integer", "minimum": 1, "maximum": maxMCPStates, "description": "state budget of every search (default 2000, ≤ 20000)"},
				"max_tokens": map[string]any{"type": "integer", "minimum": 1, "maximum": 1000000, "description": "tokens in one place past which a net counts as unbounded (default 1000)"},
				"ablate":     map[string]any{"type": "boolean", "description": "judge each link by taking it out and searching again (default true; at most 60 links)"},
			}, "bundle"),
			run: mcpBundleProve,
		},
		{
			Name: "pflow_bundle_check_proof",
			Description: "Re-check a record pflow_bundle_prove returned (from this server or another implementation of the tool) against a composition. Every certificate is checked by arithmetic or replay on the flat net: y·C and z·C = 0, z ≥ 0, the bounds, the replay of every counterexample and deadlock witness; the engine's own answers (the composite's CID, searches, link verdicts, the overall verdict) are recomputed and compared. " +
				"Returns valid, the number of checks, the failed ones and every check with its method and detail. A tampered record, or one for a different composition, is not valid. The flat net loads in the other pflow_* net tools through pflow_bundle_net.",
			InputSchema: obj(map[string]any{
				"bundle": bundleArg,
				"proof":  map[string]any{"type": "object", "description": "the record pflow_bundle_prove returned, whole (type \"CompositionProof\")"},
			}, "bundle", "proof"),
			run: mcpBundleCheckProof,
		},
		{
			Name: "pflow_bundle_parts",
			Description: "A 13-part catalog to snap together, larger than pflow_bundle_example's six: queue, resource-pool, saga, mutex, token_bucket, circuit_breaker, batcher, approval, inventory, failover, sir, kanban and traffic_light, each with its parameters (default, range), ports, the conservation law it carries, and the joins that are legal. " +
				"With no `instances` it returns the catalog. With `instances` ([{id, part, params?}]) it builds a composition from them, joined by `links` ([{kind, from:{subnet, port}, to:{subnet, port}}]): a link whose end is not in the composition is dropped and listed, a link Validate refuses fails the call as pflow_bundle_add_link would. " +
				"Returns `bundle`, which the other pflow_bundle_* tools read: pflow_bundle_net turns it into an ordinary net the other pflow_* tools read, pflow_bundle_prove checks what its links do. The queue, resource-pool and saga are go-pflow's own constructors; the other ten are textbook nets whose sizes and ports are the catalog's judgment.",
			InputSchema: obj(map[string]any{
				"instances": map[string]any{"type": "array", "maxItems": mbMaxSubnets, "description": "[{id, part, params?}] (omit for the catalog)", "items": obj(map[string]any{
					"id":     map[string]any{"type": "string", "description": "the subnet's id (default: the part's name); no '/' or ':'"},
					"part":   map[string]any{"type": "string", "enum": partIDs},
					"params": map[string]any{"type": "object", "description": "the part's parameters, integers in the ranges the catalog lists"},
				}, "part")},
				"links": map[string]any{"type": "array", "maxItems": mbMaxLinks, "items": obj(map[string]any{"kind": linkKindArg, "from": endpointArg("one end"), "to": endpointArg("the other end")}, "kind", "from", "to")},
			}),
			run: mcpBundleParts,
		},
	}
}

func mcpBundleNet(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	const tool = "pflow_bundle_net"
	b, err := modelBundle(tool, args, bundleNetKinds)
	if err != nil {
		return nil, err
	}
	out, err := composite.Net(b)
	if err != nil {
		return nil, err
	}
	if out["ok"] == true {
		// a net cut to fit the result limit is not the composite: refuse it
		if n := encodedLen(out); n > mcpMaxResultBytes {
			return nil, fmt.Errorf("%s: the net would be %d bytes; the result limit is %d KB, and a cut net is not the composite. pflow_bundle_flatten lists the same flat net (also cut), so use a smaller composition", tool, n, mcpMaxResultBytes>>10)
		}
	}
	return out, nil
}

func mcpBundleProve(_ *Server, r *http.Request, args map[string]any) (any, error) {
	const tool = "pflow_bundle_prove"
	b, err := modelBundle(tool, args, bundleProveKinds)
	if err != nil {
		return nil, err
	}
	o, err := composite.OptsFromArgs(args, tool)
	if err != nil {
		return nil, err
	}
	o.Context = r.Context()
	rec, err := composite.Prove(b, o)
	if err != nil {
		return nil, err
	}
	if n := encodedLen(rec); n > mcpMaxResultBytes {
		return summaryOnly(rec, n), nil
	}
	return rec, nil
}

// summaryOnly is a proof record without the parts that make it checkable
// (laws, certificates, the links' detail), for a record too big to return
// whole: the verdicts and what they say.
func summaryOnly(rec map[string]any, n int) map[string]any {
	claims := []any{}
	for _, c := range rec["claims"].([]any) {
		cm := c.(map[string]any)
		claims = append(claims, map[string]any{"id": cm["id"], "status": cm["status"], "method": cm["method"], "says": cm["says"]})
	}
	links := []any{}
	for _, l := range rec["links"].([]any) {
		lm := l.(map[string]any)
		codes := []any{}
		for _, f := range lm["findings"].([]any) {
			codes = append(codes, f.(map[string]any)["code"])
		}
		links = append(links, map[string]any{"key": lm["key"], "verdict": lm["verdict"], "findings": codes, "says": lm["says"]})
	}
	return map[string]any{
		"type": rec["type"], "version": rec["version"], "options": rec["options"], "bundle": rec["bundle"],
		"composite": rec["composite"], "search": rec["search"], "verdict": rec["verdict"],
		"claims": claims, "links": links, "says": rec["says"],
		"record_omitted": true,
		"note":           fmt.Sprintf("the proof record would be %d bytes, over the %d-byte result limit, and a cut record cannot be checked by pflow_bundle_check_proof, so only the summary is returned. Prove a smaller composition, or pass ablate:false.", n, mcpMaxResultBytes),
	}
}

func mcpBundleCheckProof(_ *Server, r *http.Request, args map[string]any) (any, error) {
	const tool = "pflow_bundle_check_proof"
	b, err := modelBundle(tool, args, bundleCheckProofKinds)
	if err != nil {
		return nil, err
	}
	rec, ok := args["proof"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s: proof: the record pflow_bundle_prove returned is required", tool)
	}
	return composite.CheckProofContext(r.Context(), b, rec)
}

func mcpBundleParts(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	const tool = "pflow_bundle_parts"
	if err := checkArgs(tool, args, bundlePartsKinds); err != nil {
		return nil, err
	}
	out, err := composite.Call(tool, args)
	if err != nil {
		return nil, err
	}
	return out, nil
}

func encodedLen(v any) int {
	text, err := json.Marshal(v)
	if err != nil {
		return 0
	}
	return len(text)
}
