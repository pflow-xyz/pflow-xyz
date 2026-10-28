package main

// The bundle section of the /schema reference page.
//
// A PetriNetBundle is the wire format for a composition: independently
// authored nets (subnets) and the typed links between them. The field names
// below are go-pflow's metamodel/compose.go, which is the Go source of truth
// for them (the module pinned in go.mod); schema_bundle_test.go checks every
// name here against that package's JSON tags, the example against its
// validator and Flatten, and the term table against the live context, so the
// page cannot drift from either.
//
// This page does NOT change what the JSON-LD context at /schema defines. The
// bundle terms are documented here and reported as what they are in that
// context (mostly undefined, expanding through its @vocab); aligning the
// published context with the sealer's is a lockstep change (CLAUDE.md,
// "Adding a context term means updating BOTH CID contexts and public/schema").

import (
	"html/template"

	"github.com/pflow-xyz/go-pflow/metamodel"
)

// sealVocab is the @vocab of the context the sealers preload under
// https://pflow.xyz/schema (internal/seal/seal.go, public/seal-cid.mjs). The
// test seals a document to keep this honest.
const sealVocab = "https://pflow.xyz/schema#"

// fieldDoc documents one JSON field.
type fieldDoc struct {
	Name    string // the JSON name, as in the Go struct tag
	Type    string
	Meaning string
}

// enumDoc documents one value of a closed set of strings.
type enumDoc struct {
	Value   string
	Meaning string
}

// bundleTerm is one term of the wire format and where it stands in the context
// this server publishes, next to where it stands in the sealer's.
type bundleTerm struct {
	Name      string
	Role      string
	Defined   bool   // an explicit term definition in the published context
	Published string // the IRI the published context gives it
	Sealing   string // the IRI the sealer's context gives it
	Same      bool
}

// bundleDoc is everything the bundle section renders.
type bundleDoc struct {
	Vocab, SealVocab string // @vocab of the published context, of the sealer's
	Bundle           []fieldDoc
	Subnet           []fieldDoc
	Port             []fieldDoc
	Link             []fieldDoc
	Endpoint         []fieldDoc
	NetTypes         []enumDoc
	PortKinds        []enumDoc
	LinkKinds        []enumDoc
	Lowerings        []enumDoc
	ArcMerges        []enumDoc
	Terms            []bundleTerm
	Example          string
}

var bundleFields = struct{ Bundle, Subnet, Port, Link, Endpoint []fieldDoc }{
	Bundle: []fieldDoc{
		{"@context", "string", `Always "https://pflow.xyz/schema".`},
		{"@type", "string", `"PetriNetBundle".`},
		{"name", "string", "Optional."},
		{"version", "string", "Optional."},
		{"description", "string", "Optional."},
		{"subnets", "array of Subnet", "Required. The nets being composed; ids are unique within the bundle."},
		{"links", "array of Link", "The typed connections between subnets."},
		{"constraints", "array of {id, expr}", "Bundle-level invariants written against flat ids, where cross-subnet conservation laws live."},
		{"namespace", "boolean", `Default true: Flatten prefixes every element id with "<subnet>/". Set false only when ids are already globally unique; a clash is then an error (E_DUPLICATE_ID).`},
		{"arc_merge", `"sum" | "max"`, "Default sum. What Flatten does when transition fusion produces two arcs between the same place and transition (values below)."},
	},
	Subnet: []fieldDoc{
		{"@type", "string", `"PetriNet".`},
		{"id", "string", "Required, unique in the bundle. Links address the subnet by it."},
		{"net_type", "string", "What the net models; constrains which links are legal (values below). Absent means untyped: legal with every link, and Validate warns (W_UNTYPED_SUBNET)."},
		{"model", "Model", "Required. The net itself, in go-pflow's metamodel shape: arrays of {id} for places and transitions, arcs as {from, to, weight, type, kinetic}. This is not the id-keyed editor shape (places and transitions as objects, source/target arcs) the term table above describes."},
		{"ports", "array of Port", "The subnet's boundary. When absent it is derived: one inout port per place the model marks exported. When present, every place port must name an exported place."},
	},
	Port: []fieldDoc{
		{"id", "string", "Unique within the subnet."},
		{"kind", "string", "Direction (values below)."},
		{"target", `"place" | "transition"`, `What the port exposes. Default "place".`},
		{"place", "string", "The exposed place, when target is place. It must be exported."},
		{"transition", "string", "The exposed transition, when target is transition."},
		{"schema", "string", "Optional type tag. When both ends of a link carry one, they must agree (E_SCHEMA_MISMATCH)."},
	},
	Link: []fieldDoc{
		{"id", "string", "Optional. Links that fuse the same transition share one id, because the fused transition is named after the link."},
		{"kind", "string", "token, data, event or guard (values below)."},
		{"from", "Endpoint", "Where the link starts. For a guard link, the gated transition."},
		{"to", "Endpoint", "Where it ends. For a guard link, the observed place."},
		{"rename", "object", "Event links: maps a binding name on the from side to a name on the to side, so two nets that both call something amount compose without either being edited."},
		{"condition", "string", `Guard links: a predicate over the observed place's token count: "> 0" (default), "== 0", ">= 3", and so on.`},
		{"lowering", "string", "Guard links: how the condition becomes arcs or a guard (values below). Default auto."},
	},
	Endpoint: []fieldDoc{
		{"subnet", "string", "Required: the id of a subnet in this bundle."},
		{"port", "string", "The normal form: a port the subnet declares."},
		{"place", "string", "An escape hatch for a place with no declared port."},
		{"transition", "string", "An escape hatch for a transition with no declared port."},
	},
}

// The closed sets are spelled with go-pflow's constants, so a rename there
// breaks this build rather than this page.
var (
	bundleNetTypes = []enumDoc{
		{string(metamodel.WorkflowNet), "Routes a single token along a path; the token is a cursor. Validate warns if it starts with other than one token."},
		{string(metamodel.ResourceNet), "Counts fungible resources and conserves them."},
		{string(metamodel.GameNet), "Turn-taking and positions."},
		{string(metamodel.ComputationNet), "Evolves continuously under rates rather than by discrete firings, so an event link cannot involve it."},
		{string(metamodel.ClassificationNet), "Accumulates evidence toward thresholds."},
	}
	bundlePortKinds = []enumDoc{
		{string(metamodel.PortIn), "Tokens come in."},
		{string(metamodel.PortOut), "Tokens go out. A token link may not end at one."},
		{string(metamodel.PortInOut), "Both."},
		{string(metamodel.PortObserve), "Read-only: for data and guard links."},
	}
	bundleLinkKinds = []enumDoc{
		{string(metamodel.TokenLink), "Between places. Place fusion: tokens transfer between schemas (resource coupling). Both places must be token places, or both data places, with the same type if set. Only nets that count tokens (ResourceNet, GameNet) may take part; a token link may not start at an in-port or end at an out-port."},
		{string(metamodel.DataLink), "Between places. Place fusion for read-only observation across a boundary. The observing (to) side may touch the fused place only with read or inhibitor arcs; an arc that moves tokens is rejected (E_DATALINK_CONSUMES). Legal between every net type."},
		{string(metamodel.EventLink), "Between transitions. Transition fusion: when one fires, the other fires too (a rendezvous). It is transitive: links that name the same transition fuse into one, which is why the café example names its staff transitions per drink."},
		{string(metamodel.GuardLink), "From a transition to a place. Gates the transition on the observed place's token count. It only removes behaviour, so Validate warns (W_RESTRICTIVE_LINK). Legal between every net type."},
	}
	bundleLowerings = []enumDoc{
		{metamodel.LoweringAuto, "Structural for every condition that has a structural form (all but !=), else expr."},
		{metamodel.LoweringStructural, "Read and/or inhibitor arcs, which reachability and verify can see. An error for a condition with no structural form."},
		{metamodel.LoweringInhibitor, "The narrower spelling of structural: an inhibitor arc specifically, so a lower bound (>= n) is rejected."},
		{metamodel.LoweringExpr, "A tokens(...) conjunct on the gated transition's guard, which reachability and verify do not evaluate (W_GUARD_OPAQUE)."},
	}
	bundleArcMerges = []enumDoc{
		{string(metamodel.MergeSum), "Add the weights. Each component still consumes what it declared, which keeps its P-invariants under projection."},
		{string(metamodel.MergeMax), "Take the larger weight: a genuinely shared consumption."},
	}
)

// bundleTermRoles lists the wire format's terms in reading order, with the
// object each belongs to. Names that appear on several objects say so.
var bundleTermRoles = []struct{ Name, Role string }{
	{"PetriNetBundle", "@type of the document"},
	{"PetriNet", "@type of each subnet"},
	{"subnets", "bundle"},
	{"links", "bundle"},
	{"constraints", "bundle"},
	{"namespace", "bundle"},
	{"arc_merge", "bundle"},
	{"net_type", "subnet"},
	{"model", "subnet"},
	{"ports", "subnet"},
	{"id", "subnet, port, link"},
	{"kind", "port, link"},
	{"target", "port"},
	{"schema", "port"},
	{"place", "port, endpoint"},
	{"transition", "port, endpoint"},
	{"from", "link"},
	{"to", "link"},
	{"rename", "link"},
	{"condition", "link"},
	{"lowering", "link"},
	{"subnet", "endpoint"},
	{"port", "endpoint"},
}

// bundleExample is a minimal bundle that validates and flattens with the
// pinned go-pflow (the test runs it): a workflow that ships orders, a stock
// that holds items, an event link fusing a shipment with taking an item from
// stock, and a guard link that lets shipping proceed only while at least two
// items are in stock.
const bundleExample = `{
  "@context": "https://pflow.xyz/schema",
  "@type": "PetriNetBundle",
  "name": "shop",
  "namespace": true,
  "arc_merge": "sum",
  "subnets": [
    {
      "@type": "PetriNet",
      "id": "orders",
      "net_type": "WorkflowNet",
      "model": {
        "name": "orders",
        "places": [ {"id": "open", "initial": 1}, {"id": "shipped"} ],
        "transitions": [ {"id": "ship"} ],
        "arcs": [ {"from": "open", "to": "ship"}, {"from": "ship", "to": "shipped"} ]
      }
    },
    {
      "@type": "PetriNet",
      "id": "stock",
      "net_type": "ResourceNet",
      "model": {
        "name": "stock",
        "places": [ {"id": "items", "initial": 5, "exported": true} ],
        "transitions": [ {"id": "take"} ],
        "arcs": [ {"from": "items", "to": "take"} ]
      },
      "ports": [ {"id": "items", "kind": "observe", "place": "items"} ]
    }
  ],
  "links": [
    {
      "id": "ship_takes_stock", "kind": "event",
      "from": {"subnet": "orders", "transition": "ship"},
      "to":   {"subnet": "stock",  "transition": "take"}
    },
    {
      "id": "ship_needs_two", "kind": "guard",
      "from": {"subnet": "orders", "transition": "ship"},
      "to":   {"subnet": "stock",  "port": "items"},
      "condition": ">= 2"
    }
  ]
}`

// buildBundleDoc assembles the section's data. vocab is the @vocab of the
// published context and terms its parsed definitions; the term table is
// computed from them, so it follows the context if the context changes.
func buildBundleDoc(vocab string, terms []schemaTerm) bundleDoc {
	defined := make(map[string]string, len(terms))
	for _, t := range terms {
		defined[t.Name] = t.ID
	}
	rows := make([]bundleTerm, 0, len(bundleTermRoles))
	for _, r := range bundleTermRoles {
		row := bundleTerm{Name: r.Name, Role: r.Role, Sealing: sealVocab + r.Name}
		if id, ok := defined[r.Name]; ok {
			row.Defined, row.Published = true, id
		} else {
			row.Published = vocab + r.Name
		}
		row.Same = row.Published == row.Sealing
		rows = append(rows, row)
	}
	return bundleDoc{
		Vocab:     vocab,
		SealVocab: sealVocab,
		Bundle:    bundleFields.Bundle,
		Subnet:    bundleFields.Subnet,
		Port:      bundleFields.Port,
		Link:      bundleFields.Link,
		Endpoint:  bundleFields.Endpoint,
		NetTypes:  bundleNetTypes,
		PortKinds: bundlePortKinds,
		LinkKinds: bundleLinkKinds,
		Lowerings: bundleLowerings,
		ArcMerges: bundleArcMerges,
		Terms:     rows,
		Example:   bundleExample,
	}
}

// schemaPage is what the /schema HTML template renders.
type schemaPage struct {
	Terms  []schemaTerm
	Bundle bundleDoc
}

func init() {
	template.Must(schemaTpl.New("bundle").Parse(schemaBundleHTML))
}

// Field tables share one shape; this is the markup for one.
const schemaFieldTable = `<table>
<thead><tr><th>Field</th><th>Type</th><th>Meaning</th></tr></thead>
<tbody>
{{range .}}<tr><td class="term">{{.Name}}</td><td class="ftype">{{.Type}}</td><td>{{.Meaning}}</td></tr>
{{end}}</tbody>
</table>`

const schemaEnumTable = `<table>
<thead><tr><th>Value</th><th>Meaning</th></tr></thead>
<tbody>
{{range .}}<tr><td class="term">{{.Value}}</td><td>{{.Meaning}}</td></tr>
{{end}}</tbody>
</table>`

const schemaBundleHTML = `{{define "fields"}}` + schemaFieldTable + `{{end}}{{define "enum"}}` + schemaEnumTable + `{{end}}{{with .Bundle}}
<h2 id="bundle">Bundles: composing nets</h2>
<p>A <code>PetriNetBundle</code> is the wire format for a composition: independently authored nets (<em>subnets</em>) and the typed <em>links</em> between them. Flatten lowers a bundle to one ordinary net that every analysis and solver takes unchanged. The field names below are those of <a href="https://github.com/pflow-xyz/go-pflow/blob/main/metamodel/compose.go">go-pflow's <code>metamodel/compose.go</code></a>, which is the source of truth for them; a complete bundle is <a href="https://github.com/pflow-xyz/pflow-xyz/blob/main/examples/showcase/cafe.bundle.json"><code>examples/showcase/cafe.bundle.json</code></a>.</p>
<p>A subnet's <code>model</code> is go-pflow's metamodel shape, not the editor's: places and transitions are arrays of objects with an <code>id</code>, and an arc is <code>{from, to, weight, type, kinetic}</code> with <code>type</code> absent, <code>"read"</code> or <code>"inhibitor"</code>. The editor's JSON-LD shape, which the term table above documents, keys places and transitions by id and writes arcs as <code>source</code>/<code>target</code>.</p>
<p>The term table also lists <code>CompositeNet</code>, <code>schemas</code> and the <code>TokenLink</code>, <code>DataLink</code>, <code>EventLink</code> and <code>GuardLink</code> types. The wire format below does not use them: a link states its kind in <code>kind</code> (<code>"token"</code>, <code>"data"</code>, <code>"event"</code> or <code>"guard"</code>), and a bundle is <code>PetriNetBundle</code> with <code>subnets</code>.</p>

<h3>Bundle</h3>
{{template "fields" .Bundle}}
<p><code>arc_merge</code> values:</p>
{{template "enum" .ArcMerges}}

<h3>Subnet</h3>
{{template "fields" .Subnet}}
<p><code>net_type</code> values. A net type decides which links it may take part in; an untyped subnet is legal with all of them.</p>
{{template "enum" .NetTypes}}

<h3>Port</h3>
{{template "fields" .Port}}
<p><code>kind</code> values:</p>
{{template "enum" .PortKinds}}

<h3>Link</h3>
{{template "fields" .Link}}
<p><code>kind</code> values:</p>
{{template "enum" .LinkKinds}}
<p><code>lowering</code> values (guard links). Most conditions have a structural lowering: <code>&lt; n</code>, <code>&lt;= n</code> and <code>== 0</code> become inhibitor arcs, <code>&gt;= n</code> and <code>&gt; n</code> become read arcs, and <code>== n</code> (n &gt; 0) both. <code>!=</code> and <code>&lt; 0</code> have none and fall back to a guard expression.</p>
{{template "enum" .Lowerings}}

<h3>Endpoint</h3>
{{template "fields" .Endpoint}}

<h3>Example</h3>
<p>Two subnets, an event link and a guard link. This bundle validates and flattens with go-pflow; this server's tests run it.</p>
<pre><code>{{.Example}}</code></pre>
<p>Flatten fuses by equivalence class, not pairwise, and one subnet with no links flattens to a copy of its net. Composition refines behaviour; it does not extend it: a component's invariants survive by projection, its liveness does not.</p>

<h2 id="vocab">Which context defines these terms</h2>
<p>Two JSON-LD contexts answer to <code>https://pflow.xyz/schema</code>, and they are not the same document.</p>
<ul>
<li><b>This one</b>, the document served at this URL and tabulated above, has <code>@vocab</code> <code>{{.Vocab}}</code>: a key it does not define expands to <code>{{.Vocab}}&lt;key&gt;</code>.</li>
<li><b>The sealer's.</b> A model's CID is not computed from this document. The sealers (<code>internal/seal</code> on the server, <code>seal-cid.mjs</code> in the browser, held equal by shared golden CIDs) preload their own context under this URL and never fetch it. Its <code>@vocab</code> is <code>{{.SealVocab}}</code>, with explicit entries for the editor's net terms (<code>arcs</code>, <code>places</code>, <code>transitions</code>, <code>source</code>, <code>target</code>, <code>weight</code>, <code>token</code>, <code>capacity</code>, <code>initial</code>, <code>inhibitTransition</code>, <code>parents</code>, <code>offset</code>, <code>x</code>, <code>y</code>).</li>
</ul>
<p>What follows from that:</p>
<ul>
<li>Under the sealer's context every key it does not list expands to <code>{{.SealVocab}}&lt;key&gt;</code>. That covers all the bundle terms, every field inside a subnet's <code>model</code>, and, in an editor-format net, every place and transition id used as a key.</li>
<li>Expanding a document against <em>this</em> context gives different IRIs for those keys, and for <code>arcs</code>, <code>transitions</code>, <code>source</code> and <code>target</code>, which this context does not define. A few terms both contexts list differ in type or container (<code>places</code>, <code>token</code>, <code>capacity</code>, <code>offset</code>, <code>x</code>, <code>y</code>, <code>inhibitTransition</code>). So a generic JSON-LD processor pointed at the live <code>/schema</code> does not reproduce the RDF that was hashed, and cannot be used to check a CID. Use the sealer.</li>
<li>The two contexts are not yet aligned. Until they are, treat the sealer's as the one that defines identity and this one as a description of the vocabulary.</li>
</ul>
<p>The wire format's terms, and where each stands today. <b>Defined here</b> means this context has an explicit entry for it; otherwise it falls to <code>@vocab</code>.</p>
<table>
<thead><tr><th>Term</th><th>On</th><th>Defined here</th><th>IRI in this context</th><th>IRI in the sealer's</th></tr></thead>
<tbody>
{{range .Terms}}<tr>
<td class="term">{{.Name}}</td>
<td>{{.Role}}</td>
<td>{{if .Defined}}yes{{else}}no{{end}}</td>
<td class="id">{{.Published}}</td>
<td class="id">{{.Sealing}}{{if not .Same}} <b>(differs)</b>{{end}}</td>
</tr>
{{end}}</tbody>
</table>
{{end}}`
