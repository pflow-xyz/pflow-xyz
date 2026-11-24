// SPDX-License-Identifier: MIT

// Command pflowtext is the prototype's command line: it reads a pflow net written in the
// notation (docs/pflow-notation.md), or a pflow.xyz JSON-LD net, and says what the notation
// says about it.
//
//	pflowtext check [-advise N] [-json] net.pnet     diagnostics: syntax, check and (with -advise) the verifier's
//	pflowtext compile net.pnet                       the JSON-LD the text means, on stdout
//	pflowtext print net.jsonld                       the notation's canonical text of a JSON-LD net
//	pflowtext cid net.pnet|net.jsonld                the CID it seals to
//	pflowtext roundtrip net.jsonld                   print, compile, seal: exit 1 unless both seal to one CID
//
// It exits 1 when there is an error (or, for roundtrip, a mismatch), 2 on a usage error.
package main

import (
	"flag"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/pflow-xyz/pflow-xyz/internal/notation"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(args []string, out, errw *os.File) int {
	if len(args) < 2 {
		fmt.Fprintln(errw, "usage: pflowtext check|compile|print|cid|roundtrip [flags] file")
		return 2
	}
	cmd := args[0]
	fs := flag.NewFlagSet(cmd, flag.ContinueOnError)
	advise := fs.Int("advise", 0, "check: also ask go-pflow's verifier, searching at most this many markings")
	asJSON := fs.Bool("json", false, "check: diagnostics as JSON, one per line")
	if err := fs.Parse(args[1:]); err != nil || fs.NArg() != 1 {
		return 2
	}
	path := fs.Arg(0)
	raw, err := os.ReadFile(path)
	if err != nil {
		fmt.Fprintln(errw, err)
		return 2
	}
	src := string(raw)
	switch cmd {
	case "check":
		f, ds := notation.Parse(src)
		ds = append(ds, f.Check()...)
		failed := false
		for _, d := range ds {
			failed = failed || d.IsError()
		}
		if *advise > 0 && !failed {
			doc, err := notation.Compile(f)
			if err != nil {
				fmt.Fprintln(errw, err)
				return 1
			}
			ads, err := notation.Advise(f, doc, *advise)
			if err != nil {
				fmt.Fprintln(errw, err)
				return 1
			}
			ds = append(ds, ads...)
		}
		sort.SliceStable(ds, func(i, j int) bool { return ds[i].Span.Start < ds[j].Span.Start })
		for _, d := range ds {
			if *asJSON {
				fmt.Fprintln(out, notation.CompactJSON(d.JSON(src)))
			} else {
				fmt.Fprintln(out, d.Render(src))
				fmt.Fprintln(out)
			}
		}
		if failed {
			return 1
		}
	case "compile":
		doc, ds := notation.CompileText(src)
		if doc == nil {
			for _, d := range ds {
				fmt.Fprintln(errw, d.Render(src))
			}
			return 1
		}
		out.Write(notation.MarshalJSON(doc))
	case "print":
		v, err := notation.ParseJSON(raw)
		if err != nil {
			fmt.Fprintln(errw, err)
			return 1
		}
		text, lossy, err := notation.Print(v)
		if err != nil {
			fmt.Fprintln(errw, err)
			return 1
		}
		fmt.Fprint(out, text)
		for _, l := range lossy {
			fmt.Fprintln(errw, "not carried:", l)
		}
	case "cid":
		cid, err := cidOf(path, src)
		if err != nil {
			fmt.Fprintln(errw, err)
			return 1
		}
		fmt.Fprintln(out, cid)
	case "roundtrip":
		v, err := notation.ParseJSON(raw)
		if err != nil {
			fmt.Fprintln(errw, err)
			return 1
		}
		want, err := notation.CID(v)
		if err != nil {
			fmt.Fprintln(errw, err)
			return 1
		}
		text, lossy, err := notation.Print(v)
		if err != nil {
			fmt.Fprintln(errw, err)
			return 1
		}
		doc, ds := notation.CompileText(text)
		if doc == nil {
			fmt.Fprintln(errw, "the printed text does not compile:", ds[0].Message)
			return 1
		}
		got, _ := notation.CID(doc)
		fmt.Fprintf(out, "json-ld  %s\ntext     %s\n", want, got)
		for _, l := range lossy {
			fmt.Fprintln(out, "not carried:", l)
		}
		if got != want {
			fmt.Fprintln(out, "MISMATCH: the text means a different net")
			return 1
		}
		fmt.Fprintln(out, "same CID")
	default:
		fmt.Fprintln(errw, "unknown command", cmd)
		return 2
	}
	return 0
}

func cidOf(path, src string) (string, error) {
	if strings.HasSuffix(path, ".jsonld") || strings.HasSuffix(path, ".json") {
		v, err := notation.ParseJSON([]byte(src))
		if err != nil {
			return "", err
		}
		return notation.CID(v)
	}
	doc, ds := notation.CompileText(src)
	if doc == nil {
		return "", fmt.Errorf("%s", ds[0].Render(src))
	}
	return notation.CID(doc)
}
