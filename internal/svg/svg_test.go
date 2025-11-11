package svg

import (
	"strings"
	"testing"
)

func TestGenerateSVG(t *testing.T) {
	jsonData := []byte(`{
		"@context": "https://pflow.xyz/schema",
		"@type": "PetriNet",
		"@version": "1.1",
		"arcs": [
			{
				"@type": "Arrow",
				"inhibitTransition": false,
				"source": "txn0",
				"target": "place0",
				"weight": [1]
			},
			{
				"@type": "Arrow",
				"inhibitTransition": false,
				"source": "place0",
				"target": "txn1",
				"weight": [3]
			}
		],
		"places": {
			"place0": {
				"@type": "Place",
				"capacity": [3],
				"initial": [1],
				"offset": 0,
				"x": 130,
				"y": 207
			}
		},
		"token": ["https://pflow.xyz/tokens/black"],
		"transitions": {
			"txn0": {
				"@type": "Transition",
				"x": 46,
				"y": 116
			},
			"txn1": {
				"@type": "Transition",
				"x": 227,
				"y": 112
			}
		}
	}`)

	svg, err := GenerateSVG(jsonData)
	if err != nil {
		t.Fatalf("GenerateSVG failed: %v", err)
	}

	// Check that SVG contains expected elements
	if !strings.Contains(svg, "<svg xmlns") {
		t.Error("SVG missing opening tag")
	}
	if !strings.Contains(svg, "</svg>") {
		t.Error("SVG missing closing tag")
	}
	if !strings.Contains(svg, "viewBox") {
		t.Error("SVG missing viewBox attribute")
	}
	if !strings.Contains(svg, "class=\"place\"") {
		t.Error("SVG missing place element")
	}
	if !strings.Contains(svg, "class=\"transition") {
		t.Error("SVG missing transition element")
	}
	if !strings.Contains(svg, "class=\"arc") {
		t.Error("SVG missing arc element")
	}
}

func TestGenerateSVGWithInhibitor(t *testing.T) {
	jsonData := []byte(`{
		"@context": "https://pflow.xyz/schema",
		"@type": "PetriNet",
		"@version": "1.1",
		"arcs": [
			{
				"@type": "Arrow",
				"inhibitTransition": true,
				"source": "place0",
				"target": "txn0",
				"weight": [2]
			}
		],
		"places": {
			"place0": {
				"@type": "Place",
				"capacity": [10],
				"initial": [3],
				"offset": 0,
				"x": 100,
				"y": 100
			}
		},
		"token": ["https://pflow.xyz/tokens/black"],
		"transitions": {
			"txn0": {
				"@type": "Transition",
				"x": 200,
				"y": 100
			}
		}
	}`)

	svg, err := GenerateSVG(jsonData)
	if err != nil {
		t.Fatalf("GenerateSVG failed: %v", err)
	}

	// Check for inhibitor circle
	if !strings.Contains(svg, "class=\"inhibitor") {
		t.Error("SVG missing inhibitor element")
	}

	// txn0 should NOT be active because place0 has 3 tokens >= weight 2
	// Check that the rect element has only "transition" class, not "transition transition-active"
	if strings.Contains(svg, `class="transition transition-active"`) {
		t.Errorf("Transition should not be active when inhibited by input inhibitor")
	}
}

func TestGenerateSVGWithOutputInhibitor(t *testing.T) {
	// Test output inhibitor (transition -> place)
	// Transition is disabled when target place tokens < weight
	jsonData := []byte(`{
		"@context": "https://pflow.xyz/schema",
		"@type": "PetriNet",
		"@version": "1.1",
		"arcs": [
			{
				"@type": "Arrow",
				"inhibitTransition": true,
				"source": "txn0",
				"target": "place0",
				"weight": [3]
			}
		],
		"places": {
			"place0": {
				"@type": "Place",
				"capacity": [10],
				"initial": [1],
				"offset": 0,
				"x": 200,
				"y": 100
			}
		},
		"token": ["https://pflow.xyz/tokens/black"],
		"transitions": {
			"txn0": {
				"@type": "Transition",
				"x": 100,
				"y": 100
			}
		}
	}`)

	svg, err := GenerateSVG(jsonData)
	if err != nil {
		t.Fatalf("GenerateSVG failed: %v", err)
	}

	// txn0 should NOT be active because place0 has 1 token < weight 3
	// Check that the rect element has only "transition" class, not "transition transition-active"
	if strings.Contains(svg, `class="transition transition-active"`) {
		t.Error("Transition should not be active when disabled by output inhibitor")
	}
}

func TestGenerateSVGWithLabels(t *testing.T) {
	jsonData := []byte(`{
		"@context": "https://pflow.xyz/schema",
		"@type": "PetriNet",
		"@version": "1.1",
		"arcs": [],
		"places": {
			"place0": {
				"@type": "Place",
				"capacity": [10],
				"initial": [0],
				"offset": 0,
				"x": 100,
				"y": 100,
				"label": "Input Place"
			}
		},
		"token": ["https://pflow.xyz/tokens/black"],
		"transitions": {
			"txn0": {
				"@type": "Transition",
				"x": 200,
				"y": 100,
				"label": "Process"
			}
		}
	}`)

	svg, err := GenerateSVG(jsonData)
	if err != nil {
		t.Fatalf("GenerateSVG failed: %v", err)
	}

	// Check for labels
	if !strings.Contains(svg, "Input Place") {
		t.Error("SVG missing place label")
	}
	if !strings.Contains(svg, "Process") {
		t.Error("SVG missing transition label")
	}
	if !strings.Contains(svg, "class=\"label-text\"") {
		t.Error("SVG missing label-text class")
	}
}

func TestGenerateSVGWeightDisplay(t *testing.T) {
	jsonData := []byte(`{
		"@context": "https://pflow.xyz/schema",
		"@type": "PetriNet",
		"@version": "1.1",
		"arcs": [
			{
				"@type": "Arrow",
				"inhibitTransition": false,
				"source": "place0",
				"target": "txn0",
				"weight": [1]
			}
		],
		"places": {
			"place0": {
				"@type": "Place",
				"capacity": [10],
				"initial": [5],
				"offset": 0,
				"x": 100,
				"y": 100
			}
		},
		"token": ["https://pflow.xyz/tokens/black"],
		"transitions": {
			"txn0": {
				"@type": "Transition",
				"x": 200,
				"y": 100
			}
		}
	}`)

	svg, err := GenerateSVG(jsonData)
	if err != nil {
		t.Fatalf("GenerateSVG failed: %v", err)
	}

	// Weight 1 should now be displayed
	if !strings.Contains(svg, "class=\"weight-badge\">1</text>") {
		t.Error("SVG should display weight of 1")
	}
}

func TestGenerateSVGInvalidJSON(t *testing.T) {
	jsonData := []byte(`invalid json`)

	_, err := GenerateSVG(jsonData)
	if err == nil {
		t.Error("Expected error for invalid JSON, got nil")
	}
}

func TestGenerateSVGEmptyNet(t *testing.T) {
	jsonData := []byte(`{
		"@context": "https://pflow.xyz/schema",
		"@type": "PetriNet",
		"@version": "1.1",
		"arcs": [],
		"places": {},
		"token": ["https://pflow.xyz/tokens/black"],
		"transitions": {}
	}`)

	svg, err := GenerateSVG(jsonData)
	if err != nil {
		t.Fatalf("GenerateSVG failed: %v", err)
	}

	// Should still generate valid SVG
	if !strings.Contains(svg, "<svg xmlns") {
		t.Error("SVG missing opening tag")
	}
	if !strings.Contains(svg, "</svg>") {
		t.Error("SVG missing closing tag")
	}
}

func TestGenerateSVGWithZeroCapacity(t *testing.T) {
	// Test that capacity=0 is treated as unlimited (Infinity)
	jsonData := []byte(`{
		"@context": "https://pflow.xyz/schema",
		"@type": "PetriNet",
		"@version": "1.1",
		"arcs": [
			{
				"@type": "Arrow",
				"inhibitTransition": false,
				"source": "place0",
				"target": "txn0",
				"weight": [1]
			},
			{
				"@type": "Arrow",
				"inhibitTransition": false,
				"source": "txn0",
				"target": "place1",
				"weight": [1]
			}
		],
		"places": {
			"place0": {
				"@type": "Place",
				"capacity": [10],
				"initial": [1],
				"offset": 0,
				"x": 100,
				"y": 100
			},
			"place1": {
				"@type": "Place",
				"capacity": [0],
				"initial": [0],
				"offset": 1,
				"x": 300,
				"y": 100
			}
		},
		"token": ["https://pflow.xyz/tokens/black"],
		"transitions": {
			"txn0": {
				"@type": "Transition",
				"x": 200,
				"y": 100
			}
		}
	}`)

	svg, err := GenerateSVG(jsonData)
	if err != nil {
		t.Fatalf("GenerateSVG failed: %v", err)
	}

	// txn0 should be active because:
	// - place0 has 1 token >= weight 1
	// - place1 has capacity=0 which should be treated as unlimited (not block the transition)
	if !strings.Contains(svg, `class="transition transition-active"`) {
		t.Error("Transition should be active when output place has capacity=0 (unlimited)")
	}
}

