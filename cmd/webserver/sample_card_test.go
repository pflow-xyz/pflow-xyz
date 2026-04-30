package main

import (
	"os"
	"testing"
)

// TestSampleOutput is a development helper — set PFLOW_CARD_OUT=/tmp
// and run `go test -run TestSampleOutput` to dump the rendered card
// to disk for visual inspection. Skipped by default.
func TestSampleOutput(t *testing.T) {
	dir := os.Getenv("PFLOW_CARD_OUT")
	if dir == "" {
		t.Skip("set PFLOW_CARD_OUT=/path to write sample card files")
	}
	raw := loadSample(t)
	p, err := parseCardPayload(raw)
	if err != nil {
		t.Fatal(err)
	}
	summary := summarizeCard(p, sampleCID, "https://pflow.xyz", "")
	svgOut := renderShareCardSVG(summary, "")
	if err := os.WriteFile(dir+"/share-card.svg", svgOut, 0644); err != nil {
		t.Fatal(err)
	}
	pngOut, err := renderShareCardPNG(summary, p)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(dir+"/share-card.png", pngOut, 0644); err != nil {
		t.Fatal(err)
	}
	t.Logf("wrote %s/share-card.{svg,png}", dir)
}
