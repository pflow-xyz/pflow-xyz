package seal

import (
	"encoding/json"
	"errors"
	"net/http"
	"sync"

	cid "github.com/ipfs/go-cid"
	"github.com/multiformats/go-multibase"
	mh "github.com/multiformats/go-multihash"
	"github.com/piprate/json-gold/ld"
)

var (
	// cachedLoader is a singleton caching document loader used for deterministic CID calculation
	cachedLoader     ld.DocumentLoader
	cachedLoaderOnce sync.Once
)

// initCachingLoader initializes the caching document loader with preloaded contexts
// to ensure deterministic CID calculation even when using remote context URLs.
func initCachingLoader() {
	cachedLoaderOnce.Do(func() {
		// Create a default HTTP-based document loader
		httpLoader := ld.NewDefaultDocumentLoader(http.DefaultClient)

		// Wrap it with a caching loader
		cachingLoader := ld.NewCachingDocumentLoader(httpLoader)

		// Preload the pflow.xyz schema context to ensure deterministic behavior
		// This context is derived from the examples in the repository
		pflowContext := map[string]interface{}{
			"@context": map[string]interface{}{
				"@vocab": "https://pflow.xyz/schema#",
				"arcs": map[string]interface{}{
					"@id":        "https://pflow.xyz/schema#arcs",
					"@container": "@list",
				},
				"places":      "https://pflow.xyz/schema#places",
				"transitions": "https://pflow.xyz/schema#transitions",
				"token": map[string]interface{}{
					"@id":        "https://pflow.xyz/schema#token",
					"@container": "@list",
				},
				"source": "https://pflow.xyz/schema#source",
				"target": "https://pflow.xyz/schema#target",
				"weight": map[string]interface{}{
					"@id":        "https://pflow.xyz/schema#weight",
					"@container": "@list",
				},
				"inhibitTransition": "https://pflow.xyz/schema#inhibitTransition",
				"capacity": map[string]interface{}{
					"@id":        "https://pflow.xyz/schema#capacity",
					"@container": "@list",
				},
				"initial": map[string]interface{}{
					"@id":        "https://pflow.xyz/schema#initial",
					"@container": "@list",
				},
				"offset": "https://pflow.xyz/schema#offset",
				"x":      "https://pflow.xyz/schema#x",
				"y":      "https://pflow.xyz/schema#y",
			},
		}

		cachingLoader.AddDocument("https://pflow.xyz/schema", pflowContext)

		cachedLoader = cachingLoader
	})
}

// SealJSONLD takes raw JSON-LD bytes, canonicalizes using URDNA2015
// (via piprate/json-gold), computes a CIDv1 (json-ld codec) using SHA2-256,
// and returns (cidString, canonicalBytes, error).
//
// canonicalBytes are the N-Quads string returned by Normalize() encoded as UTF-8 bytes.
// The canonicalization step uses the URDNA2015 algorithm and produces deterministic output.
// The CID is encoded using base58btc (z prefix).
func SealJSONLD(raw []byte) (string, []byte, error) {
	// Initialize the caching document loader for deterministic behavior
	initCachingLoader()

	// parse JSON-LD into a Go interface{}
	var doc interface{}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", nil, err
	}

	// prepare processor and options
	proc := ld.NewJsonLdProcessor()
	opts := ld.NewJsonLdOptions("") // empty base
	// Ensure URDNA2015 algorithm and n-quads output
	opts.Format = "application/n-quads"
	opts.Algorithm = "URDNA2015"
	// Use the caching document loader for deterministic context resolution
	opts.DocumentLoader = cachedLoader

	// Normalize
	normalized, err := proc.Normalize(doc, opts)
	if err != nil {
		return "", nil, err
	}

	// Normalize returns a string containing N-Quads (normalized RDF); assert that
	nqStr, ok := normalized.(string)
	if !ok {
		return "", nil, errors.New("unexpected normalized output type")
	}
	normalizedBytes := []byte(nqStr)

	// Compute multihash (sha2-256)
	multihash, err := mh.Sum(normalizedBytes, mh.SHA2_256, -1)
	if err != nil {
		return "", nil, err
	}

	// Create CIDv1 with json-ld codec (DagJSON = 0x0129)
	c := cid.NewCidV1(cid.DagJSON, multihash)

	// Encode using base58btc (z prefix) for storage in filesystem
	cidStr, err := c.StringOfBase(multibase.Base58BTC)
	if err != nil {
		return "", nil, err
	}

	return cidStr, normalizedBytes, nil
}
