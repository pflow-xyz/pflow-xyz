package zblob

import (
	"github.com/pflow-dev/pflow-xyz/protocol/metamodel"
	"github.com/pflow-dev/pflow-xyz/protocol/oid"
	"time"
)

// Zblob is a data wrapper for encapsulating a model
type Zblob struct {
	ID           int64     `json:"-"`
	IpfsCid      string    `json:"cid"`
	Base64Zipped string    `json:"data"`
	Title        string    `json:"title"`
	Description  string    `json:"description"`
	Keywords     string    `json:"keywords"`
	Referer      string    `json:"-"`
	CreatedAt    time.Time `json:"created"`
}

func GetMetamodel(data string) metamodel.MetaModel {
	mm := metamodel.New()
	_, ok := mm.UnpackFromUrl("?z=" + data)
	if !ok {
		panic("Failed to unzip model")
	}
	return mm
}

type Document struct {
	ModelCid    string                      `json:"model_cid"`
	Title       string                      `json:"title"`
	Description string                      `json:"description"`
	Keywords    string                      `json:"keywords"`
	Declaration metamodel.DeclarationObject `json:"declaration"`
}

func (z *Zblob) ToDocument() Document {
	mm := GetMetamodel(z.Base64Zipped)
	return Document{
		ModelCid:    z.IpfsCid,
		Title:       z.Title,
		Description: z.Description,
		Keywords:    z.Keywords,
		Declaration: mm.ToDeclarationObject(),
	}
}
func assertValid(data string) {
	_ = GetMetamodel(data)
}

func (d Document) Cid() string {
	return oid.ToOid(oid.Marshal(d)).String()
}
