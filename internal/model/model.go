// Package model is pflow.xyz's model-identity rule: which CID names a model.
//
// The sealing contract is untouched (internal/seal: drop the top-level @id,
// URDNA2015 N-Quads under the preloaded pflow.xyz context, sha-256, CIDv1
// dag-json base58btc). This package decides only WHAT is sealed.
//
//   - A net (Shape A editor JSON-LD, coordinates included) is a model. Its
//     model CID is the CID it already has. Nothing is re-minted.
//   - A composition is its own JSON-LD document, @type "PetriNetBundle" (the
//     go-pflow metamodel.Bundle shape). Each subnet is either inline (`model`,
//     the metamodel shape; only for parts that have no net CID) or a reference
//     to a stored net by CID (`cid`). Typed links join them. It seals with the
//     same contract, as written. Changing a link changes only the
//     composition's CID; each part keeps its own.
//   - A composition that is a bare wrapper around one net (one subnet, by
//     reference, no links, no constraints, no name) IS that net: its model CID
//     is the part's CID. This is the only normalisation, and it is what lets
//     "a single net is a degenerate model" hold without a second CID.
//   - A plan is a separate document that names a model by CID; the model
//     never names its plans.
//
// See docs/model-identity.md for the full rule and the backport proof.
package model

import (
	"bytes"
	"encoding/json"
	"fmt"
	"regexp"
	"sort"

	"github.com/pflow-xyz/pflow-xyz/internal/seal"
)

const (
	// Context is the only @context a model document uses.
	Context = "https://pflow.xyz/schema"

	TypeComposition = "PetriNetBundle"
	TypePlan        = "SearchPlan"

	KindNet         = "net"
	KindComposition = "composition"
	KindPlan        = "plan"
)

// cidPattern is the basic shape of a base58btc CIDv1 ("z…"); the store does
// the real lookup. It matches cmd/webserver's cidPattern.
var cidPattern = regexp.MustCompile(`^z[1-9A-HJ-NP-Za-km-z]{20,80}$`)

// IsCID reports whether s has the shape of a pflow CID.
func IsCID(s string) bool { return cidPattern.MatchString(s) }

// Error is a refusal with a stable code, rendered "[CODE] message" as the
// registry's commands do.
type Error struct{ Code, Msg string }

func (e *Error) Error() string { return "[" + e.Code + "] " + e.Msg }

func refuse(code, format string, a ...any) *Error {
	return &Error{Code: code, Msg: fmt.Sprintf(format, a...)}
}

// Refusal codes.
const (
	ErrBundleShape  = "E_BUNDLE_SHAPE"    // the tokenmodel/subnet bundle, not metamodel.Bundle
	ErrNoSubnets    = "E_NO_SUBNETS"      // a composition with no parts
	ErrSubnet       = "E_SUBNET"          // a part that is not an object, has no id, or repeats one
	ErrPart         = "E_PART"            // a part with neither or both of cid and model, or a bad cid
	ErrPattern      = "E_PATTERN"         // pattern/params malformed
	ErrLink         = "E_LINK"            // a link that is not an object, has no kind, or names no known part
	ErrPlan         = "E_PLAN"            // a plan document that is malformed
	ErrPartMissing  = "E_PART_MISSING"    // a referenced part is not in the store
	ErrPartKind     = "E_PART_KIND"       // a referenced part is not a net
	ErrNotAModelDoc = "E_NOT_JSON_OBJECT" // the document is not a JSON object
)

// Kind classifies a parsed document. Everything that is neither a composition
// nor a plan is a net: unknown documents keep the CID they have always had.
func Kind(doc map[string]any) string {
	switch doc["@type"] {
	case TypeComposition:
		return KindComposition
	case TypePlan:
		return KindPlan
	}
	return KindNet
}

// KindOf classifies raw JSON; non-objects are nets (they seal as they always did).
func KindOf(raw []byte) string {
	var doc map[string]any
	if json.Unmarshal(raw, &doc) != nil {
		return KindNet
	}
	return Kind(doc)
}

// Identity is what the rule says about one document.
type Identity struct {
	Kind string
	// CID is the model CID.
	CID string
	// Sealed is the CID of the document exactly as given (seal.SealJSONLD).
	// It equals CID except for a reduced bare wrapper.
	Sealed string
	// Reduced is true when CID is a part's CID: the document is a bare
	// wrapper around that net.
	Reduced bool
	// Parts lists the by-reference part CIDs of a composition, in document order.
	Parts []string
}

// Identify applies the rule to raw JSON-LD. Nets are never validated or
// changed: their model CID is seal.SealJSONLD(raw). Compositions and plans are
// checked structurally first (see Check).
func Identify(raw []byte) (Identity, error) {
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil || doc == nil {
		// Not an object: seal() decides, as it always did.
		cid, _, serr := seal.SealJSONLD(raw)
		if serr != nil {
			return Identity{}, serr
		}
		return Identity{Kind: KindNet, CID: cid, Sealed: cid}, nil
	}
	kind := Kind(doc)
	if err := Check(doc); err != nil {
		return Identity{Kind: kind}, err
	}
	sealed, _, err := seal.SealJSONLD(raw)
	if err != nil {
		return Identity{Kind: kind}, err
	}
	id := Identity{Kind: kind, CID: sealed, Sealed: sealed}
	if kind == KindComposition {
		id.Parts = Parts(doc)
		if part, ok := BareWrapper(doc); ok {
			id.Kind = KindNet
			id.CID = part
			id.Reduced = true
		}
	}
	return id, nil
}

// Check is the structural check of a composition or plan document. A net
// passes unexamined. It does not read the store and does not check link
// legality (go-pflow's Bundle.Validate does that when the composition is
// resolved).
func Check(doc map[string]any) error {
	switch Kind(doc) {
	case KindComposition:
		return checkComposition(doc)
	case KindPlan:
		return checkPlan(doc)
	}
	return nil
}

func checkComposition(doc map[string]any) error {
	subs, _ := doc["subnets"].([]any)
	if len(subs) == 0 {
		return refuse(ErrNoSubnets, "a composition needs at least one subnet")
	}
	ids := map[string]bool{}
	for i, s := range subs {
		m, ok := s.(map[string]any)
		if !ok {
			return refuse(ErrSubnet, "subnets[%d] is not an object", i)
		}
		id, _ := m["id"].(string)
		if id == "" {
			return refuse(ErrSubnet, "subnets[%d] has no id", i)
		}
		if ids[id] {
			return refuse(ErrSubnet, "subnet id %q appears twice", id)
		}
		ids[id] = true

		cid, hasCID := m["cid"]
		model, hasModel := m["model"]
		switch {
		case hasCID && hasModel:
			return refuse(ErrPart, "subnet %q has both cid and model: a part is referenced or inline, not both", id)
		case !hasCID && !hasModel:
			return refuse(ErrPart, "subnet %q has neither cid nor model: a pattern recipe alone does not pin a net", id)
		case hasCID:
			c, _ := cid.(string)
			if !IsCID(c) {
				return refuse(ErrPart, "subnet %q: cid %v is not a CID", id, cid)
			}
		default:
			if _, ok := model.(map[string]any); !ok {
				return refuse(ErrPart, "subnet %q: model is not an object", id)
			}
		}
		if p, ok := m["pattern"]; ok {
			if s, isStr := p.(string); !isStr || s == "" {
				return refuse(ErrPattern, "subnet %q: pattern must be a non-empty string", id)
			}
		}
		if p, ok := m["params"]; ok {
			s, isStr := p.(string)
			if !isStr {
				return refuse(ErrPattern, "subnet %q: params must be a canonical-JSON string (arrays inside a sealed document hash as sets, so ordered parameters are embedded as text)", id)
			}
			var obj map[string]any
			if json.Unmarshal([]byte(s), &obj) != nil || obj == nil {
				return refuse(ErrPattern, "subnet %q: params is not a JSON object", id)
			}
		}
	}
	if links, ok := doc["links"].([]any); ok {
		for i, l := range links {
			m, ok := l.(map[string]any)
			if !ok {
				return refuse(ErrLink, "links[%d] is not an object", i)
			}
			// The other PetriNetBundle in go-pflow (tokenmodel/subnet) joins
			// ports by alias: from_subnet/from_port. It means something else.
			for _, k := range []string{"from_subnet", "from_port", "to_subnet", "to_port"} {
				if _, has := m[k]; has {
					return refuse(ErrBundleShape, "links[%d] uses %q: that is go-pflow's tokenmodel/subnet bundle, not metamodel.Bundle (links are {kind, from:{subnet,…}, to:{subnet,…}})", i, k)
				}
			}
			if k, _ := m["kind"].(string); k == "" {
				return refuse(ErrLink, "links[%d] has no kind", i)
			}
			for _, side := range []string{"from", "to"} {
				e, ok := m[side].(map[string]any)
				if !ok {
					return refuse(ErrLink, "links[%d].%s is not an endpoint object", i, side)
				}
				sn, _ := e["subnet"].(string)
				if !ids[sn] {
					return refuse(ErrLink, "links[%d].%s names subnet %q, which is not a part", i, side, sn)
				}
			}
		}
	}
	return nil
}

func checkPlan(doc map[string]any) error {
	if mc, _ := doc["model_cid"].(string); !IsCID(mc) {
		return refuse(ErrPlan, "model_cid must be the CID of the model the plan is for")
	}
	s, ok := doc["plan"].(string)
	if !ok {
		return refuse(ErrPlan, "plan must be the plan's canonical JSON as a string (its lists are ordered; a nested array would hash as a set)")
	}
	var obj map[string]any
	if json.Unmarshal([]byte(s), &obj) != nil || obj == nil {
		return refuse(ErrPlan, "plan is not a JSON object")
	}
	return nil
}

// Parts returns the by-reference part CIDs of a composition, in document
// order. Inline parts have none.
func Parts(doc map[string]any) []string {
	var out []string
	subs, _ := doc["subnets"].([]any)
	for _, s := range subs {
		if m, ok := s.(map[string]any); ok {
			if c, ok := m["cid"].(string); ok {
				out = append(out, c)
			}
		}
	}
	return out
}

// bareTop and bareSubnet are the keys a bare wrapper may carry. namespace and
// arc_merge are allowed because go-pflow's Flatten ignores both for one
// subnet and no links (compose_flatten.go, the identity short-circuit).
var (
	bareTop    = map[string]bool{"@context": true, "@id": true, "@type": true, "subnets": true, "namespace": true, "arc_merge": true, "links": true, "constraints": true}
	bareSubnet = map[string]bool{"@type": true, "id": true, "net_type": true, "cid": true}
)

// BareWrapper reports whether a composition is nothing but one net by
// reference, and returns that net's CID. Precisely: one subnet whose only keys
// are @type, id, net_type and cid; no links and no constraints (absent or
// empty); no name, version, description, parents or any other key. Flatten
// returns such a bundle's lone model unchanged, so the wrapper adds nothing
// to the net's identity. A name or a constraint, or a pattern recipe, would
// change what the document says, so those documents stay compositions.
func BareWrapper(doc map[string]any) (string, bool) {
	if Kind(doc) != KindComposition {
		return "", false
	}
	for k, v := range doc {
		if !bareTop[k] {
			return "", false
		}
		if (k == "links" || k == "constraints") && !emptyList(v) {
			return "", false
		}
	}
	subs, _ := doc["subnets"].([]any)
	if len(subs) != 1 {
		return "", false
	}
	m, ok := subs[0].(map[string]any)
	if !ok {
		return "", false
	}
	for k := range m {
		if !bareSubnet[k] {
			return "", false
		}
	}
	cid, ok := m["cid"].(string)
	if !ok || !IsCID(cid) {
		return "", false
	}
	return cid, true
}

func emptyList(v any) bool {
	l, ok := v.([]any)
	return ok && len(l) == 0
}

// CanonicalJSON renders a JSON value with sorted object keys, no whitespace
// and unescaped <, > and &: the text embedded as a subnet's `params` or a
// plan's `plan`, where the hash must cover exact bytes. Lists keep their
// order. Numbers are doubles in JSON.stringify's form; keep them within
// ±2^53 and avoid exponents, which the three implementations spell alike only
// in that range.
func CanonicalJSON(raw []byte) (string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := writeCanonical(&buf, v); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func writeCanonical(buf *bytes.Buffer, v any) error {
	switch t := v.(type) {
	case map[string]any:
		keys := make([]string, 0, len(t))
		for k := range t {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		buf.WriteByte('{')
		for i, k := range keys {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeString(buf, k); err != nil {
				return err
			}
			buf.WriteByte(':')
			if err := writeCanonical(buf, t[k]); err != nil {
				return err
			}
		}
		buf.WriteByte('}')
	case []any:
		buf.WriteByte('[')
		for i, e := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := writeCanonical(buf, e); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
	case string:
		return writeString(buf, t)
	case json.Number:
		// Numbers are IEEE doubles written as JSON.stringify writes them
		// (shortest round-trip, 1 not 1.0), so every language agrees.
		f, err := t.Float64()
		if err != nil {
			return err
		}
		if f == 0 {
			buf.WriteByte('0')
			break
		}
		b, err := json.Marshal(f)
		if err != nil {
			return err
		}
		buf.Write(b)
	case bool:
		if t {
			buf.WriteString("true")
		} else {
			buf.WriteString("false")
		}
	case nil:
		buf.WriteString("null")
	default:
		return fmt.Errorf("canonical json: unexpected %T", v)
	}
	return nil
}

// writeString escapes as JSON.stringify and serde_json do: only `"`, `\` and
// control characters below 0x20. encoding/json cannot be used: it always
// escapes U+2028 and U+2029, and escapes < > & unless told not to.
func writeString(buf *bytes.Buffer, s string) error {
	buf.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			buf.WriteString(`\"`)
		case '\\':
			buf.WriteString(`\\`)
		case '\b':
			buf.WriteString(`\b`)
		case '\f':
			buf.WriteString(`\f`)
		case '\n':
			buf.WriteString(`\n`)
		case '\r':
			buf.WriteString(`\r`)
		case '\t':
			buf.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(buf, `\u%04x`, r)
			} else {
				buf.WriteRune(r)
			}
		}
	}
	buf.WriteByte('"')
	return nil
}

// NewPlan builds the sealed document for a search plan on a model:
//
//	{"@context": …, "@type": "SearchPlan", "model_cid": <model CID>, "plan": <canonical JSON text>}
//
// planJSON is the SearchPlan exactly as pflow-rs accepts it. It is embedded as
// canonical text because a plan's lists are ordered (order, drivers, filters)
// and a nested array would hash as an unordered set. The plan never changes
// the model's CID; the same plan on another model is another document.
func NewPlan(modelCID string, planJSON []byte) ([]byte, error) {
	if !IsCID(modelCID) {
		return nil, refuse(ErrPlan, "model_cid %q is not a CID", modelCID)
	}
	text, err := CanonicalJSON(planJSON)
	if err != nil {
		return nil, refuse(ErrPlan, "plan is not JSON: %v", err)
	}
	doc := map[string]any{
		"@context":  Context,
		"@type":     TypePlan,
		"model_cid": modelCID,
		"plan":      text,
	}
	if err := checkPlan(doc); err != nil {
		return nil, err
	}
	return json.Marshal(doc)
}
