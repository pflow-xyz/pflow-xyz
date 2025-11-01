package canonical

import (
	"encoding/json"
	"testing"
)

func TestMarshalJSON_DifferentKeyOrder(t *testing.T) {
	json1 := `{
		"transitions": {},
		"token": ["https://pflow.xyz/tokens/black"],
		"places": {},
		"arcs": [],
		"@version": "1.1",
		"@type": "PetriNet",
		"@context": "https://pflow.xyz/schema"
	}`

	json2 := `{
		"@context": "https://pflow.xyz/schema",
		"@type": "PetriNet",
		"@version": "1.1",
		"arcs": [],
		"places": {},
		"token": ["https://pflow.xyz/tokens/black"],
		"transitions": {}
	}`

	var obj1, obj2 map[string]interface{}
	if err := json.Unmarshal([]byte(json1), &obj1); err != nil {
		t.Fatalf("Failed to unmarshal json1: %v", err)
	}
	if err := json.Unmarshal([]byte(json2), &obj2); err != nil {
		t.Fatalf("Failed to unmarshal json2: %v", err)
	}

	canonical1, err := MarshalJSON(obj1)
	if err != nil {
		t.Fatalf("MarshalJSON failed for obj1: %v", err)
	}

	canonical2, err := MarshalJSON(obj2)
	if err != nil {
		t.Fatalf("MarshalJSON failed for obj2: %v", err)
	}

	if string(canonical1) != string(canonical2) {
		t.Errorf("Expected same canonical JSON for different key orders\nGot:\n%s\n%s", string(canonical1), string(canonical2))
	}
}

func TestMarshalJSON_MultipleRuns(t *testing.T) {
	jsonStr := `{
		"transitions": {},
		"token": ["https://pflow.xyz/tokens/black"],
		"places": {},
		"arcs": [],
		"@version": "1.1",
		"@type": "PetriNet",
		"@context": "https://pflow.xyz/schema"
	}`

	var expected string
	for i := 0; i < 10; i++ {
		var obj map[string]interface{}
		if err := json.Unmarshal([]byte(jsonStr), &obj); err != nil {
			t.Fatalf("Failed to unmarshal: %v", err)
		}

		canonical, err := MarshalJSON(obj)
		if err != nil {
			t.Fatalf("MarshalJSON failed: %v", err)
		}

		if i == 0 {
			expected = string(canonical)
		} else if string(canonical) != expected {
			t.Errorf("Run %d produced different output:\nExpected: %s\nGot: %s", i, expected, string(canonical))
		}
	}
}

func TestMarshalJSON_KeysSorted(t *testing.T) {
	obj := map[string]interface{}{
		"z": "last",
		"a": "first",
		"m": "middle",
	}

	canonical, err := MarshalJSON(obj)
	if err != nil {
		t.Fatalf("MarshalJSON failed: %v", err)
	}

	expected := `{"a":"first","m":"middle","z":"last"}`
	if string(canonical) != expected {
		t.Errorf("Expected keys to be sorted\nExpected: %s\nGot: %s", expected, string(canonical))
	}
}

func TestMarshalJSON_NestedObjects(t *testing.T) {
	obj := map[string]interface{}{
		"outer2": map[string]interface{}{
			"inner2": "b",
			"inner1": "a",
		},
		"outer1": map[string]interface{}{
			"inner2": "d",
			"inner1": "c",
		},
	}

	canonical, err := MarshalJSON(obj)
	if err != nil {
		t.Fatalf("MarshalJSON failed: %v", err)
	}

	// Keys should be sorted at all levels
	expected := `{"outer1":{"inner1":"c","inner2":"d"},"outer2":{"inner1":"a","inner2":"b"}}`
	if string(canonical) != expected {
		t.Errorf("Expected nested keys to be sorted\nExpected: %s\nGot: %s", expected, string(canonical))
	}
}

func TestMarshalJSON_Arrays(t *testing.T) {
	obj := map[string]interface{}{
		"items": []interface{}{"a", "b", "c"},
		"count": 3,
	}

	canonical, err := MarshalJSON(obj)
	if err != nil {
		t.Fatalf("MarshalJSON failed: %v", err)
	}

	expected := `{"count":3,"items":["a","b","c"]}`
	if string(canonical) != expected {
		t.Errorf("Expected:\n%s\nGot:\n%s", expected, string(canonical))
	}
}

func TestMarshalJSON_Primitives(t *testing.T) {
	testCases := []struct {
		name     string
		input    interface{}
		expected string
	}{
		{"string", "hello", `"hello"`},
		{"number", 42, `42`},
		{"float", 3.14, `3.14`},
		{"bool true", true, `true`},
		{"bool false", false, `false`},
		{"null", nil, `null`},
	}

	for _, tc := range testCases {
		t.Run(tc.name, func(t *testing.T) {
			obj := map[string]interface{}{
				"value": tc.input,
			}

			canonical, err := MarshalJSON(obj)
			if err != nil {
				t.Fatalf("MarshalJSON failed: %v", err)
			}

			expected := `{"value":` + tc.expected + `}`
			if string(canonical) != expected {
				t.Errorf("Expected:\n%s\nGot:\n%s", expected, string(canonical))
			}
		})
	}
}
