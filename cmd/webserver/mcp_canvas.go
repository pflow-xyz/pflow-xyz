package main

// The composition canvas as an MCP App: pflow_canvas names a ui:// resource,
// and a host that can show one draws it in a sandboxed frame.
//
// The page (mcpapp/canvas.html) is one self-contained file with no engine in it.
// Every rule it shows comes from calling the pflow_bundle_* tools back through
// the host, and those are held to pflow-native by parity/native/mcp_goldens.json.
// That is deliberate: a host's default sandbox allows inline script but no other
// origin and no WebAssembly, so /compose.html and its wasm cannot be assumed to
// load there, and this page declares no CSP exceptions because it needs none.
//
// A client that cannot show the page gets the same result as text.

import (
	_ "embed"
	"errors"
	"fmt"
	"net/http"
)

const (
	canvasResourceURI = "ui://pflow/canvas"
	mcpAppMIMEType    = "text/html;profile=mcp-app"
	mcpUIExtension    = "io.modelcontextprotocol/ui"
)

//go:embed mcpapp/canvas.html
var canvasHTML string

var canvasKinds = map[string]argKind{"bundle": argAny, "instances": argStrList, "links": argAny}

func canvasTools() []mcpTool {
	return []mcpTool{{
		Name: "pflow_canvas",
		Description: "Open a composition on the snap-together canvas, where the person joins parts by hand: each subnet's ports, the links a port could legally take, and scenario runs. " +
			"Give `bundle` (a PetriNetBundle, as the other pflow_bundle_* tools read it), or `instances` from the parts catalog with optional `links`; with neither it opens orders, workers and payment joined by the three idioms. " +
			"Returns the `bundle` and its `validation`; for a catalog composition also the `catalog`, the `instances` and the `scenarios`. " +
			"A client that cannot show the canvas can read the same result as text.",
		InputSchema: obj(map[string]any{
			"bundle":    bundleArg,
			"instances": map[string]any{"type": "array", "items": map[string]any{"type": "string", "enum": mbStrings(mbCatalogIDs())}, "description": "catalog instance ids (default orders, workers, payment); not with bundle"},
			"links":     map[string]any{"type": "array", "maxItems": mbMaxLinks, "items": obj(map[string]any{"kind": linkKindArg, "from": endpointArg("one end"), "to": endpointArg("the other end")}, "kind", "from", "to"), "description": "[{kind, from, to}] for a catalog composition (default: the three idioms); not with bundle"},
		}),
		meta: map[string]any{
			"ui": map[string]any{"resourceUri": canvasResourceURI},
			// The flat form the MCP Apps SDK still writes for hosts that read only it.
			"ui/resourceUri": canvasResourceURI,
		},
		run: mcpCanvas,
	}}
}

func init() {
	mcpAnnotations["pflow_canvas"] = mcpAnnotation{"Open the composition canvas", true, false, true}
}

func mcpCanvas(s *Server, r *http.Request, args map[string]any) (any, error) {
	const tool = "pflow_canvas"
	if err := checkArgs(tool, args, canvasKinds); err != nil {
		return nil, err
	}
	if b, ok := args["bundle"]; ok && b != nil {
		if args["instances"] != nil || args["links"] != nil {
			return nil, errors.New("pflow_canvas: give bundle, or instances and links, not both")
		}
		validation, err := mcpBundleValidate(s, r, map[string]any{"bundle": b})
		if err != nil {
			return nil, err
		}
		return map[string]any{"bundle": b, "validation": validation}, nil
	}
	exampleArgs := map[string]any{}
	for _, k := range []string{"instances", "links"} {
		if v, ok := args[k]; ok && v != nil {
			exampleArgs[k] = v
		}
	}
	out, err := mcpBundleExample(s, r, exampleArgs)
	if err != nil {
		return nil, err
	}
	example, ok := out.(map[string]any)
	if !ok {
		return nil, fmt.Errorf("%s: unexpected example result", tool)
	}
	validation, err := mcpBundleValidate(s, r, map[string]any{"bundle": example["bundle"]})
	if err != nil {
		return nil, err
	}
	result := map[string]any{"validation": validation}
	for _, k := range []string{"bundle", "catalog", "instances", "scenarios", "dropped_links"} {
		result[k] = example[k]
	}
	return result, nil
}

// canvasResource is the one resource this server has, as resources/list shows it.
func canvasResource() map[string]any {
	return map[string]any{
		"uri":         canvasResourceURI,
		"name":        "Composition canvas",
		"description": "The snap-together canvas that pflow_canvas opens.",
		"mimeType":    mcpAppMIMEType,
		"_meta":       canvasResourceMeta(),
	}
}

// canvasResourceMeta sets no csp, because the page loads nothing from any other
// origin, and no domain: it runs no OAuth of its own, and a wrong domain fails
// where a missing one still renders.
func canvasResourceMeta() map[string]any {
	return map[string]any{"ui": map[string]any{"prefersBorder": true}}
}

// mcpReadResource answers resources/read.
func mcpReadResource(uri string) (map[string]any, *rpcError) {
	if uri != canvasResourceURI {
		return nil, &rpcError{-32002, fmt.Sprintf("resource %q not found", uri)}
	}
	return map[string]any{"contents": []map[string]any{{
		"uri":      canvasResourceURI,
		"mimeType": mcpAppMIMEType,
		"text":     canvasHTML,
		"_meta":    canvasResourceMeta(),
	}}}, nil
}
