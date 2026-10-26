package main

// The /mcp workbench tools against pflow-native. parity/native/mcp_goldens.json
// is native's answer to each call in parity/native/mcp_cases.json (generated
// by parity/native/gen, `make native-goldens`); this replays every call
// through the tool's own handler and compares, the way native_parity_test.ts
// holds the wasm to native.
//
// Exact unless a case sets a `tolerance`: strings, structure, integers and
// every double. The SDE and the scenario SSA are seeded portable engines
// (SplitMix64 → xoshiro256**, a ported logarithm, a fixed arithmetic order)
// that go-pflow and pflow-solver share byte for byte, so their answers are the
// same doubles. The optimizer's cases carry a relative 1e-9 on fractions, the
// suite's ODE tolerance, because the two Tsit5 implementations round
// differently (go-pflow's derivative sums in map order) and log sampling takes
// 10^x and log10 from each language's math library; its sampler, the Pareto
// flags and every integer stay exact.
//
// Two normalisations, both for place order (native lists places in document
// order; a JSON object's member order does not survive decoding the call, so
// the server lists them in id order): series are matched by (group, name),
// table columns by header and finals rows by place, and the place list in an
// SDE refusal's capacity clause is compared as a set.

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

func TestMCPWorkbenchMatchesNative(t *testing.T) {
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
	seen := map[string]bool{}
	for _, c := range golden.Cases {
		t.Run(c.Name, func(t *testing.T) {
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
			out, err := run(&Server{}, httptest.NewRequest("POST", "/mcp", nil), args)
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
			b, _ := json.Marshal(out)
			var act any
			json.Unmarshal(b, &act)
			exp := normalizeOrder(c.Expect)
			act = normalizeOrder(alignColumns(c.Expect, act))
			if d := jsonDiff(exp, act, "", c.Tolerance, nil); len(d) > 0 {
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

// jsonDiff mirrors parity/native/diff.ts: integers exact, a number with a
// fraction within tol relative (exact when tol is 0), strings and structure
// exact.
func jsonDiff(exp, act any, path string, tol float64, out []string) []string {
	switch e := exp.(type) {
	case float64:
		a, ok := act.(float64)
		if !ok {
			return append(out, fmt.Sprintf("%s: %v != %v", path, exp, act))
		}
		if e == a {
			return out
		}
		if e == math.Trunc(e) && a == math.Trunc(a) || tol == 0 {
			return append(out, fmt.Sprintf("%s: %v != %v", path, e, a))
		}
		scale := math.Max(math.Abs(e), math.Abs(a))
		if math.Abs(e-a) > tol*math.Max(scale, 1e-12) {
			return append(out, fmt.Sprintf("%s: %v != %v (rel %.2e > %g)", path, e, a, math.Abs(e-a)/scale, tol))
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
	}
	if fmt.Sprint(exp) != fmt.Sprint(act) || (exp == nil) != (act == nil) {
		out = append(out, fmt.Sprintf("%s: %v != %v", path, exp, act))
	}
	return out
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

// alignColumns reorders the tool's tables to native's column order, matching
// columns by header (what_if's scenario × place table lists places).
func alignColumns(exp, act any) any {
	switch e := exp.(type) {
	case map[string]any:
		a, ok := act.(map[string]any)
		if !ok {
			return act
		}
		if e["kind"] == "table" && a["kind"] == "table" {
			return permuteTable(e, a)
		}
		out := make(map[string]any, len(a))
		for k, v := range a {
			out[k] = alignColumns(e[k], v)
		}
		return out
	case []any:
		a, ok := act.([]any)
		if !ok || len(a) != len(e) {
			return act
		}
		out := make([]any, len(a))
		for i := range a {
			out[i] = alignColumns(e[i], a[i])
		}
		return out
	}
	return act
}

func permuteTable(exp, act map[string]any) map[string]any {
	ec, _ := exp["columns"].([]any)
	ac, _ := act["columns"].([]any)
	if len(ec) != len(ac) {
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
	rows, _ := act["rows"].([]any)
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
	out := map[string]any{}
	for k, v := range act {
		out[k] = v
	}
	out["columns"] = ec
	out["rows"] = newRows
	return out
}

// normalizeOrder sorts what is listed per place: time-series series by
// (group, name) and the rows of a finals table (first column "place") by
// place.
func normalizeOrder(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, e := range x {
			out[k] = normalizeOrder(e)
		}
		if out["kind"] == "timeseries" {
			if s, ok := out["series"].([]any); ok {
				s = append([]any(nil), s...)
				key := func(e any) string {
					m, _ := e.(map[string]any)
					return fmt.Sprint(m["group"]) + "\x00" + fmt.Sprint(m["name"])
				}
				sort.SliceStable(s, func(i, j int) bool { return key(s[i]) < key(s[j]) })
				out["series"] = s
			}
		}
		if cols, ok := out["columns"].([]any); ok && len(cols) > 0 && cols[0] == "place" {
			if rows, ok := out["rows"].([]any); ok {
				rows = append([]any(nil), rows...)
				sort.SliceStable(rows, func(i, j int) bool {
					return fmt.Sprint(rows[i].([]any)[0]) < fmt.Sprint(rows[j].([]any)[0])
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
