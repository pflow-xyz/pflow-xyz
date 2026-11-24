package seal

import (
	"encoding/json"
	"errors"
	"net/http"
	"sync"

	"github.com/ipfs/go-cid"
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
				// parents: provenance chain of parent CIDs this net derives from.
				// Ordered (@list, newest-first) so lineage order is part of the
				// content identity — mirrors beats-bitwrap-io's `parents` field.
				// Not the top-level @id, so it IS included in the CID.
				"parents": map[string]interface{}{
					"@id":        "https://pflow.xyz/schema#parents",
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
	return seal(raw, SealVersion)
}

// SealJSONLDV1 seals under sealing contract version 1, which drops every null
// inside a list term. It exists to check a CID minted before version 2; new
// CIDs come from SealJSONLD.
func SealJSONLDV1(raw []byte) (string, []byte, error) {
	return seal(raw, 1)
}

// SealVersion is the sealing contract SealJSONLD implements.
//
// Version 2 (2026-11-24) changed one thing. JSON-LD drops a null inside a
// @list, so under version 1 capacity [null,3] (colour 0 unbounded, colour 1
// capped at 3) and capacity [3] (colour 0 capped at 3) sealed to the same
// CID. In a document whose @context is the pflow schema, a null that comes
// before a value in a list term (arcs, token, weight, capacity, initial,
// parents) is now sealed as the IRI NullIRI. Trailing nulls are still
// dropped: a null and an absent entry read the same (unbounded capacity,
// 0 tokens, weight 0), so [3,null] and [3] are one net with one CID, and so
// are [null] and [], which is how the editor writes an unbounded place.
//
// So a CID changes only for a document with a null before a value in a list
// term. When the change was made no stored document had one: the 29 objects
// in pflow.xyz's store, the cdn.stackdump.com blobs, and every fixture and
// golden in pflow-xyz, go-pflow and pflow-rs were scanned
// (docs/model-identity.md, "Sealing contract versions"). ChangedByV2 says
// whether a document is one of them. public/seal-cid.mjs and go-pflow's
// composite.SealNet implement the same rule.
const SealVersion = 2

// NullIRI stands for a null that a list term keeps (SealVersion 2).
const NullIRI = "https://pflow.xyz/schema#null"

// listTerms are the pflow context's @list terms.
var listTerms = map[string]bool{"arcs": true, "token": true, "weight": true, "capacity": true, "initial": true, "parents": true}

// ChangedByV2 reports whether raw is a document whose CID version 2 changed:
// a pflow document with a null before a value in a list term.
func ChangedByV2(raw []byte) bool {
	var doc interface{}
	if json.Unmarshal(raw, &doc) != nil {
		return false
	}
	return keepListNulls(doc)
}

// isPflowDoc reports whether doc's top-level @context is the pflow schema.
func isPflowDoc(doc interface{}) bool {
	m, ok := doc.(map[string]interface{})
	if !ok {
		return false
	}
	c, _ := m["@context"].(string)
	return c == "https://pflow.xyz/schema" || c == "https://pflow.xyz/schema#"
}

// keepListNulls rewrites doc in place under version 2's list rule and reports
// whether it changed anything. It does nothing to a document that is not a
// pflow document.
func keepListNulls(doc interface{}) bool {
	if !isPflowDoc(doc) {
		return false
	}
	return rewriteLists(doc)
}

func rewriteLists(v interface{}) bool {
	changed := false
	switch x := v.(type) {
	case map[string]interface{}:
		for k, val := range x {
			if arr, ok := val.([]interface{}); ok && listTerms[k] {
				last := -1
				for i, e := range arr {
					if e != nil {
						last = i
					}
				}
				for i := 0; i < last; i++ {
					if arr[i] == nil {
						arr[i] = map[string]interface{}{"@id": NullIRI}
						changed = true
					}
				}
			}
			if rewriteLists(val) {
				changed = true
			}
		}
	case []interface{}:
		for _, e := range x {
			if rewriteLists(e) {
				changed = true
			}
		}
	}
	return changed
}

func seal(raw []byte, version int) (string, []byte, error) {
	// Initialize the caching document loader for deterministic behavior
	initCachingLoader()

	// parse JSON-LD into a Go interface{}
	var doc interface{}
	if err := json.Unmarshal(raw, &doc); err != nil {
		return "", nil, err
	}

	// Remove the top-level "@id" before canonicalization. A net's @id is
	// self-referential (it equals this CID), so including it in its own
	// preimage would be circular and non-idempotent — re-sealing a stored
	// doc that carries @id would yield a different CID. Stripping it makes
	// the CID depend only on the net's content and keeps Go in lockstep with
	// the JS editor (public/seal-cid.js), which strips @id identically.
	if m, ok := doc.(map[string]interface{}); ok {
		delete(m, "@id")
	}
	if version >= 2 {
		keepListNulls(doc)
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
