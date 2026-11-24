// SPDX-License-Identifier: MIT

package notation

// An order-preserving JSON reader and writer. The notation needs two things
// encoding/json does not give: object keys in document order (a net's places
// print in the order the editor stored them) and numbers as written (so 100
// stays 100 and 0.25 stays 0.25).

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

// KV is one member of an ordered object.
type KV struct {
	Key string
	Val any
}

// Obj is a JSON object that remembers its key order.
type Obj []KV

// Get returns the value of key and whether it is there.
func (o Obj) Get(key string) (any, bool) {
	for _, kv := range o {
		if kv.Key == key {
			return kv.Val, true
		}
	}
	return nil, false
}

// Num is a JSON number kept as the text it was written with.
type Num string

// Float is the number as a float64.
func (n Num) Float() float64 {
	f, _ := strconv.ParseFloat(string(n), 64)
	return f
}

// ParseJSON reads one JSON value: objects as Obj, arrays as []any, numbers as
// Num, strings as string, true/false as bool and null as nil.
func ParseJSON(data []byte) (any, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	v, err := readValue(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, fmt.Errorf("json: unexpected data after the document")
	}
	return v, nil
}

func readValue(dec *json.Decoder) (any, error) {
	t, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := t.(type) {
	case json.Delim:
		switch t {
		case '{':
			obj := Obj{}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				v, err := readValue(dec)
				if err != nil {
					return nil, err
				}
				obj = append(obj, KV{kt.(string), v})
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return obj, nil
		case '[':
			arr := []any{}
			for dec.More() {
				v, err := readValue(dec)
				if err != nil {
					return nil, err
				}
				arr = append(arr, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return arr, nil
		}
	case json.Number:
		return Num(t.String()), nil
	case string, bool, nil:
		return t, nil
	}
	return nil, fmt.Errorf("json: unexpected token %v", t)
}

// FormatNumber writes a float the way JSON.stringify does for the values a net
// holds: integers without a point, others in the shortest form.
func FormatNumber(f float64) string {
	return strconv.FormatFloat(f, 'f', -1, 64)
}

// MarshalJSON writes a value with two-space indentation. Members of an Obj are
// written in order; the notation's compiler puts them in canonical order.
func MarshalJSON(v any) []byte {
	var b bytes.Buffer
	writeJSON(&b, v, 0)
	b.WriteByte('\n')
	return b.Bytes()
}

// CompactJSON writes a value on one line.
func CompactJSON(v any) string {
	var b bytes.Buffer
	writeCompact(&b, v)
	return b.String()
}

func writeScalar(b *bytes.Buffer, v any) bool {
	switch v := v.(type) {
	case nil:
		b.WriteString("null")
	case bool:
		b.WriteString(strconv.FormatBool(v))
	case string:
		b.WriteString(jsonString(v))
	case Num:
		b.WriteString(string(v))
	case float64:
		b.WriteString(FormatNumber(v))
	case int:
		b.WriteString(strconv.Itoa(v))
	default:
		return false
	}
	return true
}

func jsonString(s string) string {
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(s)
	return strings.TrimRight(b.String(), "\n")
}

func writeJSON(b *bytes.Buffer, v any, depth int) {
	if writeScalar(b, v) {
		return
	}
	ind := strings.Repeat("  ", depth+1)
	end := strings.Repeat("  ", depth)
	switch v := v.(type) {
	case Obj:
		if len(v) == 0 {
			b.WriteString("{}")
			return
		}
		b.WriteString("{\n")
		for i, kv := range v {
			b.WriteString(ind + jsonString(kv.Key) + ": ")
			writeJSON(b, kv.Val, depth+1)
			if i < len(v)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(end + "}")
	case []any:
		if len(v) == 0 {
			b.WriteString("[]")
			return
		}
		// short scalar lists stay on one line, as the editor's files have them in spirit
		allScalar := true
		for _, x := range v {
			var tmp bytes.Buffer
			if !writeScalar(&tmp, x) {
				allScalar = false
			}
		}
		if allScalar && len(v) <= 8 {
			writeCompact(b, v)
			return
		}
		b.WriteString("[\n")
		for i, x := range v {
			b.WriteString(ind)
			writeJSON(b, x, depth+1)
			if i < len(v)-1 {
				b.WriteByte(',')
			}
			b.WriteByte('\n')
		}
		b.WriteString(end + "]")
	default:
		panic(fmt.Sprintf("notation: cannot write %T as JSON", v))
	}
}

func writeCompact(b *bytes.Buffer, v any) {
	if writeScalar(b, v) {
		return
	}
	switch v := v.(type) {
	case Obj:
		b.WriteByte('{')
		for i, kv := range v {
			if i > 0 {
				b.WriteByte(',')
			}
			b.WriteString(jsonString(kv.Key) + ":")
			writeCompact(b, kv.Val)
		}
		b.WriteByte('}')
	case []any:
		b.WriteByte('[')
		for i, x := range v {
			if i > 0 {
				b.WriteString(", ")
			}
			writeCompact(b, x)
		}
		b.WriteByte(']')
	default:
		panic(fmt.Sprintf("notation: cannot write %T as JSON", v))
	}
}

// Sorted returns the object with its members in byte order of key: the
// canonical order the compiler writes everything but places and transitions in.
func (o Obj) Sorted() Obj {
	out := append(Obj(nil), o...)
	sort.SliceStable(out, func(i, j int) bool { return out[i].Key < out[j].Key })
	return out
}
