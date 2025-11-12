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
	if !strings.Contains(svg, "<line") && !strings.Contains(svg, "stroke=") {
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

	// Check for inhibitor circle (now uses inline stroke instead of class)
	if !strings.Contains(svg, "<circle") || !strings.Contains(svg, `fill="#fff"`) {
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
	if !strings.Contains(svg, ">1</text>") {
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

func TestGenerateSVGWithColoredTokens(t *testing.T) {
	// Test colored Petri nets with multiple token types
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
				"weight": [1, 0, 0]
			},
			{
				"@type": "Arrow",
				"inhibitTransition": false,
				"source": "place1",
				"target": "txn0",
				"weight": [0, 1, 0]
			},
			{
				"@type": "Arrow",
				"inhibitTransition": false,
				"source": "txn0",
				"target": "place2",
				"weight": [0, 0, 1]
			}
		],
		"places": {
			"place0": {
				"@type": "Place",
				"capacity": [10, 0, 0],
				"initial": [2, 0, 0],
				"offset": 0,
				"x": 100,
				"y": 100
			},
			"place1": {
				"@type": "Place",
				"capacity": [0, 10, 0],
				"initial": [0, 3, 0],
				"offset": 0,
				"x": 100,
				"y": 200
			},
			"place2": {
				"@type": "Place",
				"capacity": [0, 0, 10],
				"initial": [0, 0, 0],
				"offset": 0,
				"x": 300,
				"y": 150
			}
		},
		"token": [
			"https://pflow.xyz/tokens/red",
			"https://pflow.xyz/tokens/blue",
			"https://pflow.xyz/tokens/green"
		],
		"transitions": {
			"txn0": {
				"@type": "Transition",
				"x": 200,
				"y": 150
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

	// Check for arcs with colored strokes
	// The first arc should use red color (#dc3545)
	if !strings.Contains(svg, "#dc3545") {
		t.Error("SVG should contain red color for red token arcs")
	}

	// Check that arcs exist
	arcCount := strings.Count(svg, "<line")
	if arcCount != 3 {
		t.Errorf("Expected 3 arcs, got %d", arcCount)
	}

	// Check that transition is active (has tokens in both input places)
	if !strings.Contains(svg, `class="transition transition-active"`) {
		t.Error("Transition should be active when all input places have sufficient tokens")
	}
}

func TestGenerateSVGWithHexColorTokens(t *testing.T) {
	// Test that hex colors work as token URLs
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
				"initial": [1],
				"offset": 0,
				"x": 100,
				"y": 100
			}
		},
		"token": ["#ff5500"],
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

	// Check that the custom hex color is used
	if !strings.Contains(svg, "#ff5500") {
		t.Error("SVG should contain custom hex color #ff5500")
	}
}

func TestColorExtraction(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"Red token URL", "https://pflow.xyz/tokens/red", "#dc3545"},
		{"Blue token URL", "https://pflow.xyz/tokens/blue", "#007bff"},
		{"Green token URL", "https://pflow.xyz/tokens/green", "#28a745"},
		{"Hex color", "#ff5500", "#ff5500"},
		{"Black token", "https://pflow.xyz/tokens/black", "#000000"},
		{"Unknown color", "https://pflow.xyz/tokens/unknown", ""},
		{"Empty string", "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := extractColor(tt.input)
			if result != tt.expected {
				t.Errorf("extractColor(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestLightenColor(t *testing.T) {
	// Test color lightening
	result := lightenColor("#000000", 0.5)
	if result != "#7f7f7f" && result != "#808080" {
		t.Errorf("lightenColor(#000000, 0.5) = %s, want #7f7f7f or #808080", result)
	}

	// Test with red
	result = lightenColor("#dc3545", 0.6)
	if !strings.HasPrefix(result, "#") || len(result) != 7 {
		t.Errorf("lightenColor should return valid hex color, got %s", result)
	}

	// Test with invalid input
	result = lightenColor("invalid", 0.5)
	if result != "invalid" {
		t.Errorf("lightenColor(invalid) should return input unchanged, got %s", result)
	}
}

func TestGenerateSVGCoffeeShop(t *testing.T) {
	// Test with the actual coffee shop example from the issue
	jsonData := []byte(`{
  "@context": "https://pflow.xyz/schema",
  "@type": "PetriNet",
  "@version": "1.1",
  "arcs": [
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "WaitingCustomers",
      "target": "BrewCoffee",
      "weight": [1, 0, 0]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "CoffeeBeans",
      "target": "BrewCoffee",
      "weight": [0, 1, 0]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "RestockBeans",
      "target": "CoffeeBeans",
      "weight": [0, 3, 0]
    }
  ],
  "places": {
    "WaitingCustomers": {
      "@type": "Place",
      "capacity": [10, 0, 0],
      "initial": [2, 0, 0],
      "offset": 0,
      "x": 200,
      "y": 150
    },
    "CoffeeBeans": {
      "@type": "Place",
      "capacity": [0, 10, 0],
      "initial": [0, 5, 0],
      "offset": 0,
      "x": 200,
      "y": 300
    }
  },
  "token": [
    "https://pflow.xyz/tokens/red",
    "https://pflow.xyz/tokens/brown",
    "https://pflow.xyz/tokens/blue"
  ],
  "transitions": {
    "BrewCoffee": {
      "@type": "Transition",
      "x": 350,
      "y": 300
    },
    "RestockBeans": {
      "@type": "Transition",
      "x": 50,
      "y": 300
    }
  }
}`)

	svg, err := GenerateSVG(jsonData)
	if err != nil {
		t.Fatalf("GenerateSVG failed: %v", err)
	}

	// Log the SVG for inspection
	t.Logf("Generated SVG:\n%s", svg)

	// Check that weights are displayed correctly
	// The arc from WaitingCustomers->BrewCoffee has weight [1,0,0], should show 1
	// The arc from CoffeeBeans->BrewCoffee has weight [0,1,0], should show 1 (not 0!)
	// The arc from RestockBeans->CoffeeBeans has weight [0,3,0], should show 3 (not 0!)
	
	// Count weight badges - should not show 0
	if strings.Contains(svg, ">0</text>") {
		t.Error("SVG contains weight badge with value 0, which is incorrect for colored Petri nets")
	}
}

func TestGetArcWeight(t *testing.T) {
	tests := []struct {
		name     string
		arc      Arc
		expected int
	}{
		{
			name:     "Empty weight array",
			arc:      Arc{Weight: []int{}},
			expected: 1,
		},
		{
			name:     "Weight [1]",
			arc:      Arc{Weight: []int{1}},
			expected: 1,
		},
		{
			name:     "Weight [3]",
			arc:      Arc{Weight: []int{3}},
			expected: 3,
		},
		{
			name:     "Colored weight [1, 0, 0]",
			arc:      Arc{Weight: []int{1, 0, 0}},
			expected: 1,
		},
		{
			name:     "Colored weight [0, 1, 0]",
			arc:      Arc{Weight: []int{0, 1, 0}},
			expected: 1,
		},
		{
			name:     "Colored weight [0, 3, 0]",
			arc:      Arc{Weight: []int{0, 3, 0}},
			expected: 3,
		},
		{
			name:     "Colored weight [0, 0, 5]",
			arc:      Arc{Weight: []int{0, 0, 5}},
			expected: 5,
		},
		{
			name:     "All zeros defaults to 1",
			arc:      Arc{Weight: []int{0, 0, 0}},
			expected: 1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := getArcWeight(tt.arc)
			if result != tt.expected {
				t.Errorf("getArcWeight(%v) = %d, want %d", tt.arc.Weight, result, tt.expected)
			}
		})
	}
}

