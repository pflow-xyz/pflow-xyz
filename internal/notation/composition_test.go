// SPDX-License-Identifier: MIT

package notation

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pflow-xyz/pflow-xyz/internal/model"
)

const pipelineAbout = "The consumer of the first buffer and the producer of the second are one event: an item moves across."

// The composition example is the design's `compose` statement written out by hand (the
// prototype's parser reads only the core statements). What this test holds is that the
// JSON-LD the design says `compose` compiles to is a composition pflow.xyz accepts: its
// identity is the sealed document, its structure passes internal/model.Check, its parts
// resolve to the very nets the other examples compile to, and go-pflow's Flatten gives
// one net out of the two.
func TestCompositionExample(t *testing.T) {
	var cids map[string]string
	if err := json.Unmarshal(readFile(t, filepath.Join(examplesDir, "cids.json")), &cids); err != nil {
		t.Fatal(err)
	}
	if *update {
		// the parts are named by CID, so the two files follow the part's CID
		bb := cids["bounded-buffer"]
		pnet := "#! pflow 1\ncompose \"Two buffers in series\" namespace arc_merge sum\nabout \"" + pipelineAbout + "\"\n\npart first ResourceNet = " + bb + "\npart second ResourceNet = " + bb + "\n\nlink handoff event first.consume ~ second.produce\n"
		part := func(id string) Obj {
			return Obj{{"@type", "PetriNet"}, {"cid", bb}, {"id", id}, {"net_type", "ResourceNet"}}
		}
		link := Obj{{"from", Obj{{"subnet", "first"}, {"transition", "consume"}}}, {"id", "handoff"}, {"kind", "event"}, {"to", Obj{{"subnet", "second"}, {"transition", "produce"}}}}
		doc := Obj{{"@context", Context}, {"@type", "PetriNetBundle"}, {"arc_merge", "sum"}, {"description", pipelineAbout}, {"links", []any{link}}, {"name", "Two buffers in series"}, {"namespace", true}, {"subnets", []any{part("first"), part("second")}}}
		if err := os.WriteFile(filepath.Join(examplesDir, "pipeline.pnet"), []byte(pnet), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(examplesDir, "pipeline.jsonld"), MarshalJSON(doc), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	raw := readFile(t, filepath.Join(examplesDir, "pipeline.jsonld"))
	id, err := model.Identify(raw)
	if err != nil {
		t.Fatal(err)
	}
	if id.Kind != model.KindComposition || id.Reduced {
		t.Fatalf("identity: %+v", id)
	}
	if len(id.Parts) != 2 || id.Parts[0] != cids["bounded-buffer"] || id.Parts[1] != cids["bounded-buffer"] {
		t.Fatalf("the parts are not the bounded-buffer example's CID: %v", id.Parts)
	}
	if want, ok := cids["pipeline"]; ok && want != id.CID && !*update {
		t.Errorf("cids.json says %s, the composition seals to %s", want, id.CID)
	}
	if *update {
		cids["pipeline"] = id.CID
		b, _ := json.MarshalIndent(cids, "", "  ")
		if err := os.WriteFile(filepath.Join(examplesDir, "cids.json"), append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	fetch := func(cid string) ([]byte, error) {
		for name, c := range cids {
			if c == cid && name != "pipeline" {
				return os.ReadFile(filepath.Join(examplesDir, name+".jsonld"))
			}
		}
		return nil, os.ErrNotExist
	}
	flat, fm, err := model.Flatten(raw, fetch)
	if err != nil {
		t.Fatal(err)
	}
	if fm == nil || flat == nil {
		t.Fatal("no flat net")
	}
	// two buffers of two places and two transitions; the event link fuses first.consume
	// with second.produce into one transition: 4 places, 3 transitions
	if len(flat.Places) != 4 || len(flat.Transitions) != 3 {
		t.Errorf("flat net has %d places and %d transitions, want 4 and 3", len(flat.Places), len(flat.Transitions))
	}
	var names []string
	for _, tr := range flat.Transitions {
		names = append(names, tr.ID)
	}
	if !strings.Contains(strings.Join(names, " "), "handoff") {
		t.Errorf("the fused transition is not named after the link: %v", names)
	}
}
