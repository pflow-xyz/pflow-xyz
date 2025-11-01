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
