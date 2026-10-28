package main

// The /mcp composition tools: pflow_bundle_example, _validate, _add_link,
// _candidates, _flatten, _run and _incidence. A composition is a
// PetriNetBundle (go-pflow's metamodel: independently authored subnets, the
// ports on their boundaries and the typed links between them); these tools let
// an agent get one, check it, ask which links a port could take, add one,
// flatten the composition into one net and fire a script on it. They are the
// composition page's bundle.* commands (public/compose/, pflow-native's
// registry in the wasm) on the server's go-pflow, and they are held to
// pflow-native by parity/native/mcp_goldens.json (mcp_models_parity_test.go),
// as the workbench and game tools are.
//
// Like every registry tool they are stateless and model-in-argument: the
// bundle travels in the call, an edit (pflow_bundle_add_link) returns the
// changed links, nothing is stored. They name no composition by content id and
// mint none: what a composition is called is not decided yet (the CID of a
// bundle is the model-identity work, not this).
//
// They are bounded before anything runs: the request is already capped at
// maxMCPBody, and a bundle is refused past the counts below (subnets, places,
// transitions, arcs, ports, links, constraints), a script past mbMaxScript
// steps, so one call cannot tie up the server whatever the bundle looks like.
// Flattening is a union-find and a pass over the arcs, firing a script is
// linear in it, and a candidates call judges each port against a bundle of
// two subnets and a link, so each is linear in the counts below.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/pflow-xyz/go-pflow/metamodel"
)

const (
	mbMaxSubnets     = 32
	mbMaxPlaces      = 1000 // across the bundle
	mbMaxTransitions = 1000
	mbMaxArcs        = 4000
	mbMaxPorts       = 512
	mbMaxLinks       = 200
	mbMaxConstraints = 200
	mbMaxScript      = 1000
	mbMaxExpect      = 100
)

func init() {
	for name, a := range map[string]mcpAnnotation{
		"pflow_bundle_example":    {"Example composition", true, false, true},
		"pflow_bundle_validate":   {"Validate a composition", true, false, true},
		"pflow_bundle_add_link":   {"Add a link to a composition", true, false, true},
		"pflow_bundle_candidates": {"Links a port could take", true, false, true},
		"pflow_bundle_flatten":    {"Flatten a composition into one net", true, false, true},
		"pflow_bundle_run":        {"Fire a script on a composition", true, false, true},
		"pflow_bundle_incidence":  {"Incidence matrix of a composition", true, false, true},
	} {
		mcpAnnotations[name] = a
	}
}

var (
	bundleArg = map[string]any{
		"type": "object",
		"description": "a composition, a PetriNetBundle: {\"@type\": \"PetriNetBundle\", \"name\", \"subnets\": [{\"id\", \"net_type\" (ResourceNet, WorkflowNet, GameNet, ComputationNet, ClassificationNet or omitted), " +
			"\"model\": {\"places\": [{\"id\", \"initial\", \"exported\", \"capacity\", \"kind\": \"token\"|\"data\"}], \"transitions\": [{\"id\"}], \"arcs\": [{\"from\", \"to\", \"weight\", \"type\": \"read\"|\"inhibitor\"}], \"constraints\": [{\"id\", \"expr\"}]}, " +
			"\"ports\": [{\"id\", \"kind\": \"in\"|\"out\"|\"inout\"|\"observe\", \"place\"|(\"target\": \"transition\", \"transition\"), \"schema\"}]}], " +
			"\"links\": [{\"kind\": \"token\"|\"data\"|\"event\"|\"guard\", \"from\": {\"subnet\", \"port\"}, \"to\": {\"subnet\", \"port\"}, \"id\", \"condition\"}], \"namespace\", \"arc_merge\": \"sum\"|\"max\"}. " +
			"pflow_bundle_example returns one to start from.",
		"properties": map[string]any{
			"subnets": map[string]any{"type": "array", "minItems": 1, "maxItems": mbMaxSubnets, "items": map[string]any{"type": "object"}},
			"links":   map[string]any{"type": "array", "maxItems": mbMaxLinks, "items": map[string]any{"type": "object"}},
		},
		"required": []any{"subnets"},
	}
	endpointArg = func(what string) map[string]any {
		return map[string]any{"description": what + ": \"subnet:port\" or {subnet, port}", "oneOf": []any{map[string]any{"type": "string"}, map[string]any{"type": "object"}}}
	}
	linkKindArg = map[string]any{"type": "string", "enum": []any{"token", "data", "event", "guard"}}
)

var (
	bundleOnlyKinds     = map[string]argKind{"bundle": argAny}
	bundleExampleKinds  = map[string]argKind{"instances": argStrList, "links": argAny}
	bundleAddLinkKinds  = map[string]argKind{"bundle": argAny, "kind": argStr, "from": argAny, "to": argAny}
	bundleCandidateKind = map[string]argKind{"bundle": argAny, "from": argAny, "prefer": argStr}
	bundleRunKinds      = map[string]argKind{"bundle": argAny, "scenario": argStr, "script": argStrList, "expect": argAny}
)

func modelTools() []mcpTool {
	return []mcpTool{
		{
			Name: "pflow_bundle_example",
			Description: "A composition to start from: a PetriNetBundle of pattern instances (orders, a bounded queue; workers, a resource pool; payment, a two-step saga with compensation; and the extras payment2, orders2, workers2), " +
				"built by go-pflow's constructors, joined by the three idioms (an event link each from orders' dequeue to workers' acquire and payment's do:reserve, and from workers' release to payment's commit) or by `links` you give. " +
				"`instances` picks from the catalog (default orders, workers, payment); a link whose end is not in the composition is dropped and listed; a link Validate refuses fails the call, as pflow_bundle_add_link would. " +
				"Returns `bundle` (pass it to the other pflow_bundle_* tools), the `catalog` with the parameters and the reason for each, and the four `scenarios` (scripts for pflow_bundle_run with the predicates they expect: commit, refund, charge-fails, second-order). " +
				"The same catalog, parameters and scenarios as the composition page (pflow.xyz/compose.html).",
			InputSchema: obj(map[string]any{
				"instances": map[string]any{"type": "array", "items": map[string]any{"type": "string", "enum": mbStrings(mbCatalogIDs())}, "description": "catalog instance ids (default orders, workers, payment)"},
				"links":     map[string]any{"type": "array", "maxItems": mbMaxLinks, "items": obj(map[string]any{"kind": linkKindArg, "from": endpointArg("one end"), "to": endpointArg("the other end")}, "kind", "from", "to"), "description": "[{kind, from, to}] (default: the three idioms)"},
			}),
			run: mcpBundleExample,
		},
		{
			Name: "pflow_bundle_validate",
			Description: "Check a composition (go-pflow's Bundle.Validate): subnets (unique ids, models, ports on exported places, arc types), then every link (endpoints exist, the kind fits the ends, the net types allow it, port schemas agree, token-link direction, a data link's observer moves nothing, guard conditions). " +
				"Returns valid, errors and warnings, each {code, message, element}. Errors name the link as links[i] (or its id). Warnings do not block flattening: an untyped subnet, an unbounded queue, a workflow net without exactly one token, a guard link restricting its subnet.",
			InputSchema: obj(map[string]any{"bundle": bundleArg}, "bundle"),
			run:         mcpBundleValidate,
		},
		{
			Name: "pflow_bundle_add_link",
			Description: "Add a link to a composition: judge it as Validate does on the two subnets it joins and the page's two rules (a link joins two different subnets; the same link is not added twice, an event link either way round), and if legal return the composition's links with it appended. " +
				"A refused link is an error listing each reason as \"[CODE] message\". Ends are ports: \"subnet:port\" or {subnet, port}. Returns the new link's index, key, verdict (ok, errors, warnings: a guard link warns that it restricts) and `links`. Stores nothing: pass the links back in the bundle.",
			InputSchema: obj(map[string]any{"bundle": bundleArg, "kind": linkKindArg, "from": endpointArg("the link's from end (an event link either way round; a guard's from is the gated transition)"), "to": endpointArg("the link's to end (a guard's to is the observed place)")}, "bundle", "kind", "from", "to"),
			run:         mcpBundleAddLink,
		},
		{
			Name: "pflow_bundle_candidates",
			Description: "The snap-together candidates: every other port of the composition, judged as the far end of a link dragged from `from`. Kinds are tried in order (transition to transition: event; transition to place: guard; place to transition: a guard oriented transition to place; place to place: token, then data) and the first legal one wins; " +
				"`prefer` restricts to one kind. Returns `lit` (how many are legal) and for each port its ref, key, ok, the link it would make, its verdict and each kind tried. A port on the same subnet is never legal (PAGE_SAME_SUBNET), nor one the link would repeat (PAGE_DUPLICATE).",
			InputSchema: obj(map[string]any{"bundle": bundleArg, "from": endpointArg("the port the drag starts from"), "prefer": map[string]any{"type": "string", "enum": []any{"auto", "token", "data", "event", "guard"}, "description": "auto (default) or one kind"}}, "bundle", "from"),
			run:         mcpBundleCandidates,
		},
		{
			Name: "pflow_bundle_flatten",
			Description: "Flatten a composition into one net (go-pflow's Bundle.FlattenWithMap): token and data links fuse places (named wire:<canonical member>), event links fuse transitions (named by the link's id, else fused:<members>), a guard link lowers to a read or inhibitor arc; elements are prefixed <subnet>/ unless the bundle sets namespace false. " +
				"Returns the flat places, transitions (each with the members it came from), arcs and constraints, the wires and fused groups, the place and transition maps (subnet to local id to flat id), the warnings and each transition's enablement at the initial marking with go-pflow's reason. " +
				"A bundle Validate refuses answers {ok: false, error}, not an error of the call.",
			InputSchema: obj(map[string]any{"bundle": bundleArg}, "bundle"),
			run:         mcpBundleFlatten,
		},
		{
			Name: "pflow_bundle_run",
			Description: "Fire a script on the flat net from its initial marking (go-pflow's firing rule, weights, read and inhibitor arcs, capacities): `script` is a list of members \"<subnet>/<transition>\" (a member of a fused transition fires the whole fusion), or `scenario` one of the example's four. Stops at the first member that is not in the net or cannot fire and says why, then evaluates the predicates. " +
				"`expect` (with `script`) is a list of {place, n, says}: the place, as \"<subnet>/<place>\", must hold n tokens at the end. Returns the steps (member, the flat transition it fired, enabled, why not), whether the script completed, the final marking and each predicate's actual and pass.",
			InputSchema: obj(map[string]any{
				"bundle":   bundleArg,
				"script":   map[string]any{"type": "array", "maxItems": mbMaxScript, "items": map[string]any{"type": "string"}, "description": "members \"<subnet>/<transition>\" to fire, in order"},
				"scenario": map[string]any{"type": "string", "enum": mbStrings(mbScenarioIDs()), "description": "instead of a script: one of the example's scenarios (its script and predicates; it names the example's members, so on another composition it stops at the first)"},
				"expect":   map[string]any{"type": "array", "maxItems": mbMaxExpect, "items": obj(map[string]any{"place": map[string]any{"type": "string"}, "n": map[string]any{"type": "integer"}, "says": map[string]any{"type": "string"}}, "place", "n"), "description": "predicates on the final marking (with script)"},
			}, "bundle"),
			run: mcpBundleRun,
		},
		{
			Name: "pflow_bundle_incidence",
			Description: "The flat net's incidence matrix C = post − pre (rows: flat places, columns: flat transitions, in the flat net's order; read and inhibitor arcs move nothing), each subnet's own block, and each declared constraint of the form tokens(\"a\") + … == n read as a P-invariant y (1 on each place it names): " +
				"holds is true when y·C = 0 and y·M₀ = n, which proves the constraint for every reachable marking, false when it does not, and null when the constraint is not such a sum. A bundle Validate refuses answers {ok: false, error}.",
			InputSchema: obj(map[string]any{"bundle": bundleArg}, "bundle"),
			run:         mcpBundleIncidence,
		},
	}
}

// ---- reading a bundle

// modelBundle checks the arguments and reads the bundle, refusing one past the
// counts above before any engine sees it.
func modelBundle(tool string, args map[string]any, kinds map[string]argKind) (*metamodel.Bundle, error) {
	if err := checkArgs(tool, args, kinds); err != nil {
		return nil, err
	}
	raw, ok := args["bundle"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s: bundle: a PetriNetBundle (a JSON object with subnets and links) is required; pflow_bundle_example returns one", tool)
	}
	if t, ok := raw["@type"].(string); ok && t != "" && t != metamodel.BundleType {
		return nil, fmt.Errorf("%s: bundle: @type is %q, not %q", tool, t, metamodel.BundleType)
	}
	subnets, ok := raw["subnets"].([]any)
	if !ok || len(subnets) == 0 {
		return nil, fmt.Errorf("%s: bundle: needs a non-empty \"subnets\" array", tool)
	}
	if len(subnets) > mbMaxSubnets {
		return nil, fmt.Errorf("%s: bundle: %d subnets; at most %d", tool, len(subnets), mbMaxSubnets)
	}
	if links, ok := raw["links"].([]any); ok && len(links) > mbMaxLinks {
		return nil, fmt.Errorf("%s: bundle: %d links; at most %d", tool, len(links), mbMaxLinks)
	}
	text, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: bundle: not JSON: %v", tool, err)
	}
	b := &metamodel.Bundle{}
	if err := json.Unmarshal(text, b); err != nil {
		return nil, fmt.Errorf("%s: bundle: %v", tool, err)
	}
	return b, mbCheckSize(tool, b)
}

// mbCheckSize refuses a bundle past the counts above.
func mbCheckSize(tool string, b *metamodel.Bundle) error {
	var places, transitions, arcs, ports, constraints int
	for i := range b.Subnets {
		s := &b.Subnets[i]
		ports += len(s.Ports)
		if s.Model != nil {
			places += len(s.Model.Places)
			transitions += len(s.Model.Transitions)
			arcs += len(s.Model.Arcs)
			constraints += len(s.Model.Constraints)
		}
	}
	constraints += len(b.Constraints)
	for _, c := range []struct {
		what     string
		n, limit int
	}{
		{"places", places, mbMaxPlaces}, {"transitions", transitions, mbMaxTransitions}, {"arcs", arcs, mbMaxArcs},
		{"ports", ports, mbMaxPorts}, {"constraints", constraints, mbMaxConstraints},
	} {
		if c.n > c.limit {
			return fmt.Errorf("%s: bundle: %d %s; at most %d", tool, c.n, c.what, c.limit)
		}
	}
	return nil
}

func mbIssues(is []metamodel.ValidationError) []any {
	out := make([]any, len(is))
	for i, e := range is {
		out[i] = map[string]any{"code": e.Code, "message": e.Message, "element": e.Element}
	}
	return out
}

// mbBundleLinks is the bundle's links as the bundle document spells them.
func mbBundleLinks(ls []metamodel.Link) ([]any, error) {
	text, err := json.Marshal(ls)
	if err != nil {
		return nil, err
	}
	out := []any{}
	if err := json.Unmarshal(text, &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ---- the tools

func mcpBundleValidate(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	b, err := modelBundle("pflow_bundle_validate", args, bundleOnlyKinds)
	if err != nil {
		return nil, err
	}
	res := b.Validate()
	return map[string]any{"valid": res.Valid, "errors": mbIssues(res.Errors), "warnings": mbIssues(res.Warnings)}, nil
}

func mcpBundleFlatten(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	b, err := modelBundle("pflow_bundle_flatten", args, bundleOnlyKinds)
	if err != nil {
		return nil, err
	}
	f, err := mbFlatten(b)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}, nil
	}
	return mbFlatView(f), nil
}

func mcpBundleIncidence(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	b, err := modelBundle("pflow_bundle_incidence", args, bundleOnlyKinds)
	if err != nil {
		return nil, err
	}
	return mbIncidenceView(b), nil
}

func mcpBundleAddLink(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	b, err := modelBundle("pflow_bundle_add_link", args, bundleAddLinkKinds)
	if err != nil {
		return nil, err
	}
	l, err := mbLinkArg(args)
	if err != nil {
		return nil, err
	}
	v := mbVerdictIn(b, l)
	if !v.ok {
		return nil, fmt.Errorf("%s", v.refusal())
	}
	if len(b.Links) >= mbMaxLinks {
		return nil, fmt.Errorf("pflow_bundle_add_link: the composition has %d links; at most %d", len(b.Links), mbMaxLinks)
	}
	links, err := mbBundleLinks(append(append([]metamodel.Link(nil), b.Links...), l))
	if err != nil {
		return nil, err
	}
	return map[string]any{"index": len(b.Links), "link": mbLinkView(l), "key": mbLinkKey(l), "verdict": v.view(), "links": links}, nil
}

// mbLinkArg reads the kind, from and to arguments.
func mbLinkArg(args map[string]any) (metamodel.Link, error) {
	for _, k := range []string{"kind", "from", "to"} {
		if args[k] == nil {
			return metamodel.Link{}, fmt.Errorf("missing argument %q", k)
		}
	}
	return mbParseLink(map[string]any{"kind": args["kind"], "from": args["from"], "to": args["to"]})
}

func mcpBundleCandidates(_ *Server, r *http.Request, args map[string]any) (any, error) {
	b, err := modelBundle("pflow_bundle_candidates", args, bundleCandidateKind)
	if err != nil {
		return nil, err
	}
	if args["from"] == nil {
		return nil, fmt.Errorf("pflow_bundle_candidates: missing argument \"from\"")
	}
	from, err := mbParseEndpoint(args["from"])
	if err != nil {
		return nil, err
	}
	prefer := "auto"
	if p, ok := args["prefer"].(string); ok {
		prefer = p
	}
	list, err := mbCandidates(r.Context(), b, from, prefer)
	if err != nil {
		return nil, err
	}
	lit := 0
	for _, c := range list {
		if c.(map[string]any)["ok"] == true {
			lit++
		}
	}
	return map[string]any{"from": mbEnd(from), "prefer": prefer, "lit": lit, "candidates": list}, nil
}

func mcpBundleRun(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	b, err := modelBundle("pflow_bundle_run", args, bundleRunKinds)
	if err != nil {
		return nil, err
	}
	scenario, hasScenario := args["scenario"].(string)
	scriptArg, hasScript := args["script"].([]any)
	if hasScenario == hasScript {
		return nil, fmt.Errorf("pass `scenario` or `script`")
	}
	var script []string
	for _, s := range scriptArg {
		script = append(script, s.(string))
	}
	if len(script) > mbMaxScript {
		return nil, fmt.Errorf("pflow_bundle_run: script has %d steps; at most %d", len(script), mbMaxScript)
	}
	id, title := "script", "script"
	var expect []mbExpect
	if hasScenario {
		sc := mbScenarioByID(scenario)
		if sc == nil {
			return nil, fmt.Errorf("no scenario %q; there are %s", scenario, mbQuote(mbScenarioIDs()))
		}
		id, title, script, expect = sc.ID, sc.Title, sc.Script, sc.Expect
		if args["expect"] != nil {
			return nil, fmt.Errorf("pflow_bundle_run: `expect` goes with `script`; a scenario brings its own")
		}
	} else if args["expect"] != nil {
		if expect, err = mbExpectArg(args["expect"]); err != nil {
			return nil, err
		}
	}
	f, err := mbFlatten(b)
	if err != nil {
		return nil, err
	}
	if !hasScenario {
		// A scenario's predicates are native's, and a place that is not there
		// reads as 0 (flat: null says so). Ours are the caller's: a typo with
		// n = 0 would pass, so a place that is not in the composition is refused.
		for i, e := range expect {
			if _, found := f.placeOf(e.Place); !found {
				return nil, fmt.Errorf("pflow_bundle_run: expect[%d]: no place %q in the composition", i, e.Place)
			}
		}
	}
	return mbRun(f, id, title, script, expect), nil
}

// mbExpectArg reads [{place, n, says?}].
func mbExpectArg(v any) ([]mbExpect, error) {
	list, ok := v.([]any)
	if !ok {
		return nil, fmt.Errorf("pflow_bundle_run: expect should be a list of {place, n, says}, got %s", jsonText(v))
	}
	if len(list) > mbMaxExpect {
		return nil, fmt.Errorf("pflow_bundle_run: %d predicates; at most %d", len(list), mbMaxExpect)
	}
	var out []mbExpect
	for i, raw := range list {
		m, _ := raw.(map[string]any)
		place, _ := m["place"].(string)
		n, isNum := m["n"].(float64)
		if place == "" || !isNum || n != float64(int(n)) {
			return nil, fmt.Errorf("pflow_bundle_run: expect[%d] should be {place: \"<subnet>/<place>\", n: an integer, says?}, got %s", i, jsonText(raw))
		}
		for k := range m {
			if k != "place" && k != "n" && k != "says" {
				return nil, fmt.Errorf("pflow_bundle_run: expect[%d]: unknown field %q; takes place, n, says", i, k)
			}
		}
		says, _ := m["says"].(string)
		out = append(out, mbExpect{place, int(n), says})
	}
	return out, nil
}

// ---- the example

// mbOpened is a catalog composition: what bundle.open leaves open.
type mbOpened struct {
	bundle      *metamodel.Bundle
	specs       []*mbInstanceSpec
	unavailable []any
	dropped     []any
}

// mbOpen builds `instances` from the catalog and adds `links` whose ends exist,
// each judged as pflow_bundle_add_link judges it. An instance that cannot be
// built is recorded, not fatal; a link with an end that is not there is dropped
// and listed.
func mbOpen(instances []string, links []metamodel.Link) (*mbOpened, error) {
	o := &mbOpened{bundle: metamodel.NewBundle("composition"), unavailable: []any{}, dropped: []any{}}
	have := func(id string) bool {
		for _, s := range o.specs {
			if s.ID == id {
				return true
			}
		}
		return false
	}
	for _, id := range instances {
		spec := mbInstance(id)
		var err error
		switch {
		case spec == nil:
			err = fmt.Errorf("no instance %q; the catalog has %s", id, mbQuote(mbCatalogIDs()))
		case have(id):
			err = fmt.Errorf("instance %q is already in the composition", id)
		default:
			var sub *metamodel.Subnet
			if sub, err = spec.build(); err == nil {
				o.bundle.AddSubnet(*sub)
				o.specs = append(o.specs, spec)
			}
		}
		if err != nil {
			if have(id) || spec == nil {
				return nil, err
			}
			o.unavailable = append(o.unavailable, map[string]any{"instance": id, "reason": err.Error()})
		}
	}
	for _, l := range links {
		var missing []string
		for _, s := range []string{l.From.Subnet, l.To.Subnet} {
			if o.bundle.SubnetByID(s) == nil {
				missing = append(missing, s)
			}
		}
		if len(missing) > 0 {
			o.dropped = append(o.dropped, map[string]any{"link": mbLinkView(l), "reason": "not in the composition: " + strings.Join(missing, ", ")})
			continue
		}
		if v := mbVerdictIn(o.bundle, l); !v.ok {
			return nil, fmt.Errorf("%s", v.refusal())
		}
		o.bundle.AddLink(l)
	}
	return o, nil
}

func mcpBundleExample(_ *Server, _ *http.Request, args map[string]any) (any, error) {
	if err := checkArgs("pflow_bundle_example", args, bundleExampleKinds); err != nil {
		return nil, err
	}
	instances := mbDefaultInstances
	if l, ok := args["instances"].([]any); ok {
		instances = nil
		for _, s := range l {
			instances = append(instances, s.(string))
		}
	}
	if len(instances) > len(mbCatalog) {
		return nil, fmt.Errorf("pflow_bundle_example: %d instances; the catalog has %d", len(instances), len(mbCatalog))
	}
	links := mbDefaultLinks()
	if raw, ok := args["links"]; ok && raw != nil {
		list, isList := raw.([]any)
		if !isList {
			return nil, fmt.Errorf("links must be an array, got %s", mbJSONText(raw))
		}
		if len(list) > mbMaxLinks {
			return nil, fmt.Errorf("pflow_bundle_example: %d links; at most %d", len(list), mbMaxLinks)
		}
		links = nil
		for _, x := range list {
			l, err := mbParseLink(x)
			if err != nil {
				return nil, err
			}
			links = append(links, l)
		}
	}
	o, err := mbOpen(instances, links)
	if err != nil {
		return nil, err
	}
	// The whole bundle, as the other tools read it.
	text, err := json.Marshal(o.bundle)
	if err != nil {
		return nil, err
	}
	var bundle any
	if err := json.Unmarshal(text, &bundle); err != nil {
		return nil, err
	}
	catalog := make([]any, len(mbCatalog))
	for i := range mbCatalog {
		spec := &mbCatalog[i]
		_, buildErr := spec.build()
		entry := map[string]any{"id": spec.ID, "pattern": spec.Pattern, "label": spec.ID, "extra": spec.Extra, "params": spec.Params, "why": spec.Why, "available": buildErr == nil}
		if buildErr != nil {
			entry["reason"] = buildErr.Error()
		} else {
			entry["reason"] = nil
		}
		catalog[i] = entry
	}
	defaultLinks := make([]any, 0, 3)
	for _, l := range mbDefaultLinks() {
		defaultLinks = append(defaultLinks, mbLinkView(l))
	}
	scenarios := make([]any, len(mbScenarios))
	for i := range mbScenarios {
		scenarios[i] = mbScenarios[i].view()
	}
	ids := make([]any, len(o.specs))
	for i, s := range o.specs {
		ids[i] = s.ID
	}
	return map[string]any{
		"bundle": bundle, "instances": ids, "unavailable": o.unavailable, "dropped_links": o.dropped,
		"catalog": catalog, "default": mbStrings(mbDefaultInstances), "default_links": defaultLinks,
		"params_note": mbParamsNote, "scenarios": scenarios,
	}, nil
}
