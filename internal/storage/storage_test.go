package storage

import (
	. "github.com/pflow-dev/pflow-xyz/internal/examples"
	"github.com/pflow-dev/pflow-xyz/protocol/oid"
	"testing"
)

func TestNewStorage(t *testing.T) {
	s := New(ResetDb("/tmp/pflow_test.db", true))
	for _, m := range ExampleModels {
		m.IpfsCid = oid.ToOid([]byte(m.Base64Zipped)).String()
		// if m.IpfsCid != newCid {
		// 	t.Errorf("Cid mismatch: %s %s", m.IpfsCid, newCid)
		// }

		id, err := s.Model.Create(
			m.Title,
			m.Description,
			m.Keywords,
			m.Base64Zipped,
			m.IpfsCid,
			"http://localhost:8083/p/",
		)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("inserted id: %v %v %v", m.Title, id, m.IpfsCid)

		// found := s.Model.GetByCid(m.IpfsCid)
		// if found.IpfsCid != m.IpfsCid {
		// 	t.Errorf("Failed to find model by cid: %s", m.IpfsCid)
		// }
	}
}

const (
	snippetUrl = "http://localhost:8083/sandbox/?z=UEsDBAoAAAAAABAFnVeLV9AO5wIAAOcCAAAOAAAAZGVjbGFyYXRpb24uanMgY29uc3QgZGVjbGFyYXRpb24gPSB7CiAgICAibW9kZWxUeXBlIjogInBldHJpTmV0IiwKICAgICJ2ZXJzaW9uIjogInYwIiwKICAgICJwbGFjZXMiOiB7CiAgICAgICAiZm9vIjogeyAib2Zmc2V0IjogMCwgIngiOiA0ODAsICJ5IjogMzIwLCAiaW5pdGlhbCI6IDEsICJjYXBhY2l0eSI6IDMgfQogICAgfSwKICAgICJ0cmFuc2l0aW9ucyI6IHsKICAgICAgICAgImJhciI6IHsgIngiOiA0MDAsICJ5IjogNDAwIH0sCiAgICAgICAgICJiYXoiOiB7ICJ4IjogNTYwLCAieSI6IDQwMCB9LAogICAgICAgICAiYWRkIjogeyAieCI6IDQwMCwgInkiOiAyNDAgfSwKICAgICAgICAgInN1YiI6IHsgIngiOiA1NjAsICJ5IjogMjQwIH0KICAgIH0sCiAgICAiYXJjcyI6IFsKICAgICAgICAgeyAic291cmNlIjogImFkZCIsICJ0YXJnZXQiOiAiZm9vIiwgIndlaWdodCI6IDEgfSwKICAgICAgICAgeyAic291cmNlIjogImZvbyIsICJ0YXJnZXQiOiAic3ViIiwgIndlaWdodCI6IDEgfSwKICAgICAgICAgeyAic291cmNlIjogImJhciIsICJ0YXJnZXQiOiAiZm9vIiwgIndlaWdodCI6IDMsICJpbmhpYml0IjogdHJ1ZSB9LAogICAgICAgICB7ICJzb3VyY2UiOiAiZm9vIiwgInRhcmdldCI6ICJiYXoiLCAid2VpZ2h0IjogMSwgImluaGliaXQiOiB0cnVlIH0KICAgIF0KfTsKLy8gUkVWSUVXOiBEU0wgZnVuY3Rpb24gYWxzbyBzdXBwb3J0ZWQKLy8gZnVuY3Rpb24gZGVjbGFyYXRpb24oe2ZuLCBjZWxsLCByb2xlfSkgeyB9ClBLAQIUAAoAAAAAABAFnVeLV9AO5wIAAOcCAAAOAAAAAAAAAAAAAAAAAAAAAABkZWNsYXJhdGlvbi5qc1BLBQYAAAAAAQABADwAAAATAwAAAAA="
)
