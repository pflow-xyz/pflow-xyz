package main

// The /mcp workbench tools against pflow-native. parity/native/mcp_goldens.json
// is native's answer to each call in parity/native/mcp_cases.json (generated
// by parity/native/gen, `make native-goldens`); this replays every call
// through the tool's own handler and compares, the way native_parity_test.ts
// holds the wasm to native.
//
// Exact unless a case sets a `tolerance`: strings, booleans, null, structure,
// integers and every double, each of the same JSON type on both sides. The
// SDE and the scenario SSA are seeded portable engines (SplitMix64 →
// xoshiro256**, a ported logarithm, a fixed arithmetic order) that go-pflow
// and pflow-solver share byte for byte, so their answers are the same
// doubles. The optimizer integrates with go-pflow's tableaux in pflow-solver's
// summation order (transitions by id), which makes most of its cases exact
// too; a case that samples a rate on a log scale, or whose steps depend on
// the step controller's x^(1/6), carries a relative 1e-12, because 10^x,
// log10 and pow come from each language's math library and can differ in the
// last bit. Even then a linearly sampled rate (its table column, its entry in
// the front's rates, the scatter's x when it is one) is compared exactly:
// both sides compute min + u × (max − min) from the same sampler draw. Pareto
// flags, the front and every integer are always exact.
//
// Two normalisations, both for place order (native lists places in document
// order; a JSON object's member order does not survive decoding the call, so
// the server lists them in id order): within each group of a time series
// (an SDE has one, a what-if one per arm) series are sorted by name, the
// groups staying in their order; the place columns of the what-if's
// scenario × place table are matched by header and the rows of a finals
// table by place. The place list in an SDE refusal's capacity clause is
// compared as a set.

import (
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"sort"
	"strings"
	"testing"
)

type mcpGoldenCase struct {
	Name      string         `json:"name"`
	Fixture   string         `json:"fixture"`
	Tool      string         `json:"tool"`
	Args      map[string]any `json:"args"`
	Expect    any            `json:"expect"`
	Error     *string        `json:"error"`
	Tolerance float64        `json:"tolerance"`
}

func loadJSON(t *testing.T, path string, v any) {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatalf("%s: %v", path, err)
	}
}

var workbenchHandlers = map[string]func(*Server, *http.Request, map[string]any) (any, error){
	"pflow_sde": mcpSDE, "pflow_what_if": mcpWhatIf, "pflow_optimize": mcpOptimize,
}

// runGoldenCase replays one golden case through the tool's handler.
func runGoldenCase(t *testing.T, c mcpGoldenCase) (any, error) {
	t.Helper()
	run, ok := workbenchHandlers[c.Tool]
	if !ok {
		t.Fatalf("no handler for %s", c.Tool)
	}
	var net map[string]any
	loadJSON(t, "../../parity/"+c.Fixture, &net)
	args := map[string]any{"net": net}
	for k, v := range c.Args {
		args[k] = v
	}
	return run(&Server{}, httptest.NewRequest("POST", "/mcp", nil), args)
}

func loadMCPGoldens(t *testing.T) []mcpGoldenCase {
	t.Helper()
	var golden struct {
		PflowNative string          `json:"pflow_native"`
		Cases       []mcpGoldenCase `json:"cases"`
	}
	loadJSON(t, "../../parity/native/mcp_goldens.json", &golden)
	var lock struct {
		Commit string `json:"commit"`
	}
	loadJSON(t, "../../pflow-native-wasm.lock", &lock)
	if golden.PflowNative != lock.Commit {
		t.Fatalf("mcp_goldens.json was generated against pflow-native %s, but the vendored wasm is %s; re-run `make native-goldens`", golden.PflowNative, lock.Commit)
	}
	// The composition tools' cases are in the same file; mcp_models_parity_test.go
	// replays them.
	var cases []mcpGoldenCase
	for _, c := range golden.Cases {
		if !strings.HasPrefix(c.Tool, "pflow_bundle_") {
			cases = append(cases, c)
		}
	}
	return cases
}

func TestMCPWorkbenchMatchesNative(t *testing.T) {
	seen := map[string]bool{}
	for _, c := range loadMCPGoldens(t) {
		t.Run(c.Name, func(t *testing.T) {
			out, err := runGoldenCase(t, c)
			if c.Error != nil {
				if err == nil {
					t.Fatalf("native refused (%s); the tool answered", *c.Error)
				}
				if got, want := normalizeRefusal(err.Error()), normalizeRefusal(*c.Error); got != want {
					t.Fatalf("error differs:\n tool:   %s\n native: %s", got, want)
				}
				return
			}
			if err != nil {
				t.Fatalf("tool error: %v", err)
			}
			b, err := json.Marshal(out)
			if err != nil {
				t.Fatalf("the answer is not JSON: %v", err)
			}
			var act any
			if err := json.Unmarshal(b, &act); err != nil {
				t.Fatal(err)
			}
			if c.Tool == "pflow_what_if" {
				act = alignPlaceColumns(c.Expect, act)
			}
			exp := normalizeOrder(c.Expect)
			act = normalizeOrder(act)
			if d := jsonDiff(exp, act, "", caseTolerance(c), nil); len(d) > 0 {
				if len(d) > 20 {
					d = append(d[:20], fmt.Sprintf("… %d more", len(d)-20))
				}
				t.Fatalf("differs from native (tolerance %g):\n%s", c.Tolerance, strings.Join(d, "\n"))
			}
		})
		if c.Error == nil {
			seen[c.Tool] = true
		}
	}
	for tool := range workbenchHandlers {
		if !seen[tool] {
			t.Errorf("%s has no successful golden case", tool)
		}
	}
}

// caseTolerance is the relative tolerance at a path of a case's answer: the
// case's own, except 0 for the numbers an optimize case takes straight from
// a linearly sampled rate.
func caseTolerance(c mcpGoldenCase) func(path string) float64 {
	if c.Tool != "pflow_optimize" || c.Tolerance == 0 {
		return constTolerance(c.Tolerance)
	}
	params, _ := parseParams(c.Args["parameters"])
	objectives, _ := c.Args["objectives"].([]any)
	var exact []*regexp.Regexp
	for i, p := range params {
		if p.log {
			continue
		}
		exact = append(exact,
			regexp.MustCompile(fmt.Sprintf(`^\.table\.rows\[\d+\]\[%d\]$`, i+1)), // after the sample index
			regexp.MustCompile(`^\.pareto\[\d+\]\.rates\.`+regexp.QuoteMeta(p.transition)+`$`))
		if i == 0 && len(objectives) == 1 {
			exact = append(exact, regexp.MustCompile(`^\.scatter\.points\[\d+\]\[0\]$`))
		}
	}
	return func(path string) float64 {
		for _, re := range exact {
			if re.MatchString(path) {
				return 0
			}
		}
		return c.Tolerance
	}
}

func constTolerance(tol float64) func(string) float64 { return func(string) float64 { return tol } }

// jsonDiff mirrors parity/native/diff.ts: integers exact, a number with a
// fraction within tol(path) relative (exact when 0); strings, booleans, null
// and structure exact, and each value of the same JSON type on both sides
// ("3" is not 3).
func jsonDiff(exp, act any, path string, tol func(string) float64, out []string) []string {
	switch e := exp.(type) {
	case float64:
		a, ok := act.(float64)
		if !ok {
			return append(out, fmt.Sprintf("%s: %v != %#v", path, exp, act))
		}
		if e == a {
			return out
		}
		t := tol(path)
		if e == math.Trunc(e) && a == math.Trunc(a) || t == 0 {
			return append(out, fmt.Sprintf("%s: %v != %v", path, e, a))
		}
		scale := math.Max(math.Abs(e), math.Abs(a))
		if math.Abs(e-a) > t*math.Max(scale, 1e-12) {
			return append(out, fmt.Sprintf("%s: %v != %v (rel %.2e > %g)", path, e, a, math.Abs(e-a)/scale, t))
		}
		return out
	case []any:
		a, ok := act.([]any)
		if !ok {
			return append(out, fmt.Sprintf("%s: array vs %T", path, act))
		}
		if len(e) != len(a) {
			return append(out, fmt.Sprintf("%s: length %d != %d", path, len(e), len(a)))
		}
		for i := range e {
			out = jsonDiff(e[i], a[i], fmt.Sprintf("%s[%d]", path, i), tol, out)
		}
		return out
	case map[string]any:
		a, ok := act.(map[string]any)
		if !ok {
			return append(out, fmt.Sprintf("%s: object vs %T", path, act))
		}
		ek, ak := sortedKeys(e), sortedKeys(a)
		if strings.Join(ek, "\x00") != strings.Join(ak, "\x00") {
			out = append(out, fmt.Sprintf("%s: keys differ (native %v, tool %v)", path, ek, ak))
		}
		for _, k := range ek {
			if v, ok := a[k]; ok {
				out = jsonDiff(e[k], v, path+"."+k, tol, out)
			}
		}
		return out
	case string:
		if a, ok := act.(string); !ok || a != e {
			return append(out, fmt.Sprintf("%s: %q != %#v", path, e, act))
		}
		return out
	case bool:
		if a, ok := act.(bool); !ok || a != e {
			return append(out, fmt.Sprintf("%s: %v != %#v", path, e, act))
		}
		return out
	case nil:
		if act != nil {
			return append(out, fmt.Sprintf("%s: null != %#v", path, act))
		}
		return out
	}
	return append(out, fmt.Sprintf("%s: unexpected %T in the golden", path, exp))
}

var capacityClause = regexp.MustCompile(`capacity is declared on \[([^\]]*)\]`)

// normalizeRefusal sorts the place list of an SDE refusal's capacity clause.
func normalizeRefusal(s string) string {
	return capacityClause.ReplaceAllStringFunc(s, func(m string) string {
		names := strings.Fields(capacityClause.FindStringSubmatch(m)[1])
		sort.Strings(names)
		return "capacity is declared on [" + strings.Join(names, " ") + "]"
	})
}

// alignPlaceColumns reorders the place columns of the what-if's scenario ×
// place table (`table`, first column "scenario") to native's order, matching
// them by header. Nothing else is permuted.
func alignPlaceColumns(exp, act any) any {
	e, _ := exp.(map[string]any)
	a, ok := act.(map[string]any)
	if !ok || e == nil {
		return act
	}
	et, _ := e["table"].(map[string]any)
	at, _ := a["table"].(map[string]any)
	if et == nil || at == nil {
		return act
	}
	ec, _ := et["columns"].([]any)
	ac, _ := at["columns"].([]any)
	if len(ec) != len(ac) || len(ec) == 0 || ec[0] != "scenario" || ac[0] != "scenario" {
		return act
	}
	pos := map[any]int{}
	for i, c := range ac {
		pos[c] = i
	}
	perm := make([]int, len(ec))
	for i, c := range ec {
		j, ok := pos[c]
		if !ok {
			return act
		}
		perm[i] = j
	}
	rows, _ := at["rows"].([]any)
	newRows := make([]any, len(rows))
	for r, row := range rows {
		cells, _ := row.([]any)
		if len(cells) != len(perm) {
			return act
		}
		nr := make([]any, len(perm))
		for i, j := range perm {
			nr[i] = cells[j]
		}
		newRows[r] = nr
	}
	table := map[string]any{}
	for k, v := range at {
		table[k] = v
	}
	table["columns"], table["rows"] = ec, newRows
	out := map[string]any{}
	for k, v := range a {
		out[k] = v
	}
	out["table"] = table
	return out
}

// normalizeOrder sorts what is listed per place: within each group of a
// time series (the groups in the order they first appear) the series by
// name, and the rows of a finals table (first column "place") by place.
func normalizeOrder(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = normalizeOrder(e)
		}
		if out["kind"] == "timeseries" {
			if s, ok := out["series"].([]any); ok {
				out["series"] = sortWithinGroups(s)
			}
		}
		if cols, ok := out["columns"].([]any); ok && len(cols) > 0 && cols[0] == "place" {
			if rows, ok := out["rows"].([]any); ok {
				rows = append([]any(nil), rows...)
				sort.SliceStable(rows, func(i, j int) bool {
					a, _ := rows[i].([]any)[0].(string)
					b, _ := rows[j].([]any)[0].(string)
					return a < b
				})
				out["rows"] = rows
			}
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = normalizeOrder(e)
		}
		return out
	}
	return v
}

// sortWithinGroups sorts time series by name within each group, keeping the
// groups in the order they first appear (so a what-if's arms stay in order).
func sortWithinGroups(s []any) []any {
	group := map[string]int{}
	type keyed struct {
		g    int
		name string
		v    any
	}
	ks := make([]keyed, len(s))
	for i, e := range s {
		m, _ := e.(map[string]any)
		g, _ := m["group"].(string)
		if _, seen := group[g]; !seen {
			group[g] = len(group)
		}
		name, _ := m["name"].(string)
		ks[i] = keyed{group[g], name, e}
	}
	sort.SliceStable(ks, func(i, j int) bool {
		if ks[i].g != ks[j].g {
			return ks[i].g < ks[j].g
		}
		return ks[i].name < ks[j].name
	})
	out := make([]any, len(ks))
	for i, k := range ks {
		out[i] = k.v
	}
	return out
}
