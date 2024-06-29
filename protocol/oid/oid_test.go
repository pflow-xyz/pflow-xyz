package oid

import (
	"testing"
)

func TestCidPrefix(t *testing.T) {
	out := ToOid([]byte("Test Cid Prefix"))
	if out.String() != "zb2rhisByHpwN7yahECwrYt7Uak2vE8ZQeo5SSaMaCyxEs6N2" {
		t.Fatalf("mismatch %v", out.String())
	}
}
