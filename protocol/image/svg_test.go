package image_test

import (
	"github.com/pflow-dev/pflow-xyz/protocol/image"
	"github.com/pflow-dev/pflow-xyz/protocol/model"
	"github.com/pflow-dev/pflow-xyz/protocol/zblob"
	"testing"
)

const sampleUrl = "GwkCAJwHto1sm0wlY/ApWO0mo82luvuMaSkLZQmYJtMGEenqmzosCqUAMnGuGyZH8UY2wGjCiAYdjeO/WUq3CVp01RVT12z9Uaj70Sex/h7bVHcHRtlqsExce2Q/wx/Uz/PughgHBfEfZE9Qbh+onTnQu1OuejznDb3bxGRqWy+aUcbhSth0mKWcNlSLjY6CjzXeYUZL9jOXttgdzSVthR/UOHhP0g642uaJ3IEiQYF7tEw/zyr2M0tz2oJwr+FAqjXmxylPh9Pyt6t6kjxzeyzr"

func TestNewSvg(t *testing.T) {
	// Load a model from a URL
	zm := new(zblob.Zblob)
	zm.Base64Zipped = sampleUrl
	m := model.FromZblob(zm)
	_, mm := m.MetaModel()
	x1, y1, width, height := mm.GetViewPort()
	i := image.NewSvgFile("/tmp/test.svg", width, height, x1, y1, width, height)
	i.Render(mm)
	i.Rect(x1, y1, width, height, "fill: #fff; stroke: #000; stroke-width: 1px;")
}
