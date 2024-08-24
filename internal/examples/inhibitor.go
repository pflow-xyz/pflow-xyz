package examples

import (
	"github.com/pflow-dev/pflow-xyz/protocol/metamodel"
	"github.com/pflow-dev/pflow-xyz/protocol/model"
	"github.com/pflow-dev/pflow-xyz/protocol/zblob"
)

var (
	expectCid = "zb2rhnR9pNtHa3jtNzJXV6c1g2MkQmXhbGyNaTsyAsUuquQ4k"
)

func InhibitorModel() *model.Model {
	m := model.Model{
		Zblob: &zblob.Zblob{
			Title:       "InhibitorTest",
			Description: "Test of inhibitor arcs.",
			Keywords:    "inhibitor",
			IpfsCid:     expectCid,
		},
	}

	m.Declare(func(dsl metamodel.Declaration) {
		cell, fn := dsl.Cell, dsl.Fn

		role := "player"
		inc := fn().Label("inc").Role(role).Position(200, 200)
		dec := fn().Label("dec").Role(role).Position(300, 200)
		bar := fn().Label("bar").Role(role).Position(200, 300)
		baz := fn().Label("baz").Role(role).Position(300, 300)
		foo := cell().Label("foo").Initial(1).Capacity(3).Position(250, 250)

		inc.Tx(1, foo)
		foo.Tx(1, dec)
		foo.Guard(1, baz)
		bar.Guard(3, foo)
	})
	return &m
}
