package canonical

import (
	"bytes"
	"encoding/json"
	"sort"
)

// MarshalJSON returns a canonical JSON encoding of v with sorted keys.
// This ensures that the same object always produces the same JSON string,
// regardless of the original key order in the map.
func MarshalJSON(v interface{}) ([]byte, error) {
	return marshalCanonical(v)
}

func marshalCanonical(v interface{}) ([]byte, error) {
	switch val := v.(type) {
	case map[string]interface{}:
		// Sort keys alphabetically
		keys := make([]string, 0, len(val))
		for k := range val {
			keys = append(keys, k)
		}
		sort.Strings(keys)

		buf := bytes.NewBufferString("{")
		for i, k := range keys {
			if i > 0 {
				buf.WriteString(",")
			}
			// Marshal the key
			keyJSON, err := json.Marshal(k)
			if err != nil {
				return nil, err
			}
			buf.Write(keyJSON)
			buf.WriteString(":")

			// Recursively marshal the value
			valJSON, err := marshalCanonical(val[k])
			if err != nil {
				return nil, err
			}
			buf.Write(valJSON)
		}
		buf.WriteString("}")
		return buf.Bytes(), nil

	case []interface{}:
		buf := bytes.NewBufferString("[")
		for i, item := range val {
			if i > 0 {
				buf.WriteString(",")
			}
			itemJSON, err := marshalCanonical(item)
			if err != nil {
				return nil, err
			}
			buf.Write(itemJSON)
		}
		buf.WriteString("]")
		return buf.Bytes(), nil

	default:
		// For primitives (string, number, bool, null), use standard JSON marshaling
		return json.Marshal(v)
	}
}
