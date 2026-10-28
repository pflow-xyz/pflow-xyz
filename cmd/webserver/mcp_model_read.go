package main

// Reading a bundle for the pflow_bundle_* tools: the arguments, the document,
// and the limits it is held to before any engine sees it.
//
// A bundle arrives as the JSON-RPC layer decoded it: numbers are doubles, member
// order is gone. So this refuses what that layer cannot carry exactly (a count
// of 2^53 or more), what pflow-native refuses to read at all (a name for a
// kind, a net type or a merge policy that is not one), what would make a call
// expensive (a name of more than mbMaxIDBytes bytes: flattening repeats the
// name of a fused transition in every map and arc that mentions it).

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/pflow-xyz/go-pflow/metamodel"
)

const (
	mbMaxIDBytes = 128 // a subnet, place, transition, port, link or constraint id, an arc end, a schema

	// JSON-RPC numbers are doubles: 2^53 and up cannot be told from their
	// neighbours, so a token count or weight there would be silently another
	// number (9007199254740993 arrives as 9007199254740992).
	mbExactInt = float64(1 << 53)
)

// modelBundle checks the arguments and reads the bundle, refusing one past the
// limits before any engine sees it.
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
	if err := mbCheckNumbers(tool, raw); err != nil {
		return nil, err
	}
	if err := mbCheckEnums(tool, raw); err != nil {
		return nil, err
	}
	text, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: bundle: not JSON: %v", tool, err)
	}
	b := &metamodel.Bundle{}
	if err := json.Unmarshal(text, b); err != nil {
		return nil, fmt.Errorf("%s: bundle: %v", tool, err)
	}
	if err := mbCheckSize(tool, b); err != nil {
		return nil, err
	}
	return b, nil
}

// ---- numbers

// mbCheckNumbers refuses a number of 2^53 or more anywhere in the bundle.
func mbCheckNumbers(tool string, raw map[string]any) error {
	var path []string
	var walk func(v any) error
	walk = func(v any) error {
		switch x := v.(type) {
		case float64:
			if math.Abs(x) >= mbExactInt {
				return fmt.Errorf("%s: bundle: %s is %s; a count or weight is at most 9007199254740991 (2^53 - 1), the largest integer JSON-RPC carries exactly (a bigger one would arrive rounded)",
					tool, strings.TrimPrefix(strings.Join(path, ""), "."), mbNumber(x))
			}
		case map[string]any:
			for _, k := range sortedKeys(x) {
				path = append(path, "."+k)
				if err := walk(x[k]); err != nil {
					return err
				}
				path = path[:len(path)-1]
			}
		case []any:
			for i, e := range x {
				path = append(path, fmt.Sprintf("[%d]", i))
				if err := walk(e); err != nil {
					return err
				}
				path = path[:len(path)-1]
			}
		}
		return nil
	}
	return walk(raw)
}

// mbNumber prints a double as the integer it is (9223372036854775808, not
// 9223372036854776000 or 9.223372036854776e+18).
func mbNumber(x float64) string {
	if math.Abs(x) < 1e19 {
		return strconv.FormatFloat(x, 'f', 0, 64)
	}
	return strconv.FormatFloat(x, 'g', -1, 64)
}

// ---- names for kinds

// mbEnum is a field that names a kind: a value outside `allowed` is refused,
// as pflow-native refuses to read a document that spells one wrongly.
func mbEnum(tool, path string, m map[string]any, key string, allowed ...string) error {
	v, present := m[key]
	if !present || v == nil {
		return nil
	}
	if s, ok := v.(string); ok {
		for _, a := range allowed {
			if s == a {
				return nil
			}
		}
	}
	quoted := make([]string, len(allowed))
	for i, a := range allowed {
		quoted[i] = fmt.Sprintf("%q", a)
	}
	return fmt.Errorf("%s: bundle: %s.%s is %s; it is one of %s", tool, path, key, jsonText(v), strings.Join(quoted, ", "))
}

func mbObjects(v any) []map[string]any {
	list, _ := v.([]any)
	out := make([]map[string]any, len(list))
	for i, e := range list {
		out[i], _ = e.(map[string]any)
	}
	return out
}

// mbCheckEnums refuses a misspelt arc_merge, net_type, place kind, port kind or
// target, or link kind. (An arc type is Validate's to judge: E_UNKNOWN_ARC_TYPE.)
func mbCheckEnums(tool string, raw map[string]any) error {
	if err := mbEnum(tool, "bundle", raw, "arc_merge", "sum", "max"); err != nil {
		return err
	}
	for i, s := range mbObjects(raw["subnets"]) {
		path := fmt.Sprintf("subnets[%d]", i)
		if err := mbEnum(tool, path, s, "net_type", "", "WorkflowNet", "ResourceNet", "GameNet", "ComputationNet", "ClassificationNet"); err != nil {
			return err
		}
		model, _ := s["model"].(map[string]any)
		for j, p := range mbObjects(model["places"]) {
			if err := mbEnum(tool, fmt.Sprintf("%s.model.places[%d]", path, j), p, "kind", "token", "data"); err != nil {
				return err
			}
		}
		for j, p := range mbObjects(s["ports"]) {
			pp := fmt.Sprintf("%s.ports[%d]", path, j)
			if err := mbEnum(tool, pp, p, "kind", "in", "out", "inout", "observe"); err != nil {
				return err
			}
			if err := mbEnum(tool, pp, p, "target", "place", "transition"); err != nil {
				return err
			}
		}
	}
	for i, l := range mbObjects(raw["links"]) {
		if err := mbEnum(tool, fmt.Sprintf("links[%d]", i), l, "kind", "token", "data", "event", "guard"); err != nil {
			return err
		}
	}
	return nil
}

// ---- size

// mbCheckSize refuses a bundle past the counts in mcp_model.go and a name past
// mbMaxIDBytes.
func mbCheckSize(tool string, b *metamodel.Bundle) error {
	var places, transitions, arcs, ports, constraints int
	long := func(path, id string) error {
		if len(id) > mbMaxIDBytes {
			return fmt.Errorf("%s: bundle: %s is %d bytes; names are at most %d bytes", tool, path, len(id), mbMaxIDBytes)
		}
		return nil
	}
	check := func(path string, ids ...string) error {
		for i := 0; i+1 < len(ids); i += 2 {
			if err := long(path+ids[i], ids[i+1]); err != nil {
				return err
			}
		}
		return nil
	}
	for i := range b.Subnets {
		s := &b.Subnets[i]
		sp := fmt.Sprintf("subnets[%d]", i)
		if err := check(sp, ".id", s.ID); err != nil {
			return err
		}
		ports += len(s.Ports)
		for j := range s.Ports {
			p := &s.Ports[j]
			if err := check(fmt.Sprintf("%s.ports[%d]", sp, j), ".id", p.ID, ".place", p.Place, ".transition", p.Transition, ".schema", p.Schema); err != nil {
				return err
			}
		}
		if s.Model == nil {
			continue
		}
		places += len(s.Model.Places)
		transitions += len(s.Model.Transitions)
		arcs += len(s.Model.Arcs)
		constraints += len(s.Model.Constraints)
		for j := range s.Model.Places {
			p := &s.Model.Places[j]
			if err := check(fmt.Sprintf("%s.model.places[%d]", sp, j), ".id", p.ID, ".type", p.Type); err != nil {
				return err
			}
		}
		for j := range s.Model.Transitions {
			if err := check(fmt.Sprintf("%s.model.transitions[%d]", sp, j), ".id", s.Model.Transitions[j].ID); err != nil {
				return err
			}
		}
		for j := range s.Model.Arcs {
			a := &s.Model.Arcs[j]
			if err := check(fmt.Sprintf("%s.model.arcs[%d]", sp, j), ".from", a.From, ".to", a.To); err != nil {
				return err
			}
		}
		for j := range s.Model.Constraints {
			if err := check(fmt.Sprintf("%s.model.constraints[%d]", sp, j), ".id", s.Model.Constraints[j].ID); err != nil {
				return err
			}
		}
	}
	constraints += len(b.Constraints)
	for j := range b.Constraints {
		if err := check(fmt.Sprintf("constraints[%d]", j), ".id", b.Constraints[j].ID); err != nil {
			return err
		}
	}
	for i := range b.Links {
		l := &b.Links[i]
		lp := fmt.Sprintf("links[%d]", i)
		if err := check(lp, ".id", l.ID,
			".from.subnet", l.From.Subnet, ".from.port", l.From.Port, ".from.place", l.From.Place, ".from.transition", l.From.Transition,
			".to.subnet", l.To.Subnet, ".to.port", l.To.Port, ".to.place", l.To.Place, ".to.transition", l.To.Transition); err != nil {
			return err
		}
	}
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
