package oid

import (
	json "github.com/gibson042/canonicaljson-go"
	"github.com/ipfs/go-cid"
	"github.com/multiformats/go-multibase"
	"github.com/multiformats/go-multihash"
)

type Oid struct {
	cid.Cid
}

func (o Oid) String() string {
	return o.Encode(encoder)
}

func (o Oid) Bytes() []byte {
	return []byte(o.Encode(encoder))
}

func toCid(data []byte) (cid.Cid, error) {
	return cid.Prefix{
		Version:  1,
		Codec:    0x55,
		MhType:   multihash.SHA2_256,
		MhLength: -1, // default length
	}.Sum(data)
}

func ToOid(b ...[]byte) *Oid {
	data := []byte{}
	for _, v := range b {
		data = append(data, v...)
	}
	newCid, err := toCid(data)
	if err != nil {
		panic(err)
	}
	return &Oid{newCid}
}

var encoder, _ = multibase.EncoderByName("base58btc")

func Marshal(i interface{}) []byte {
	data, err := json.Marshal(i)
	if err != nil {
		panic(err)
	}
	return data
}

func Unmarshal(data []byte, any interface{}) error {
	return json.Unmarshal(data, any)
}
