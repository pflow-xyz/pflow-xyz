// Command modelprobe prints what the model-identity rule says about each input
// file: its kind, the CID of the document as written (sealed), the model CID,
// and whether the document reduced to a part's CID. Maintenance utility for
// parity/model/golden.json:
//
//	go run ./cmd/modelprobe parity/model/fixtures/*.jsonld examples/showcase/cafe.bundle.json
//
// Output is tab-separated: file, kind, sealed, model, reduced.
package main

import (
	"fmt"
	"os"

	"github.com/pflow-xyz/pflow-xyz/internal/model"
)

func main() {
	for _, path := range os.Args[1:] {
		raw, err := os.ReadFile(path)
		if err != nil {
			fmt.Printf("%s\tERROR\tread: %v\n", path, err)
			continue
		}
		id, err := model.Identify(raw)
		if err != nil {
			fmt.Printf("%s\tERROR\t%v\n", path, err)
			continue
		}
		fmt.Printf("%s\t%s\t%s\t%s\t%v\n", path, id.Kind, id.Sealed, id.CID, id.Reduced)
	}
}
