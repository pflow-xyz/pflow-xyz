// Command cidprobe prints the Go-side (seal.SealJSONLD) CID for each input file.
// Maintenance utility for the JS/Go parity harness: regenerate parity/golden.json
// values with `go run ./cmd/cidprobe parity/fixtures/*.jsonld`.
package main

import (
	"fmt"
	"os"

	"github.com/pflow-xyz/pflow-xyz/internal/seal"
)

func main() {
	for _, path := range os.Args[1:] {
		raw, err := os.ReadFile(path)
		if err != nil {
			fmt.Printf("%-64s ERROR read: %v\n", path, err)
			continue
		}
		cid, _, err := seal.SealJSONLD(raw)
		if err != nil {
			fmt.Printf("%-64s ERROR seal: %v\n", path, err)
			continue
		}
		fmt.Printf("%s\t%s\n", cid, path)
	}
}
