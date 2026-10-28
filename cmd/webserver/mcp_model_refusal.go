package main

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/pflow-xyz/go-pflow/metamodel"
)

// mbRefusal is a refusal of a value whose words are pflow-native's (a link
// Validate refuses, a subnet or port that is not there, a scenario that does
// not exist). Native has no tool name and no advice, so the tool adds both:
// its name in front, and a hint behind that says what to do about it. What the
// parity test compares with native's text is `native`.
type mbRefusal struct{ tool, native, hint string }

func (e *mbRefusal) Error() string {
	s := e.native
	if e.tool != "" {
		s = e.tool + ": " + s
	}
	if e.hint != "" {
		s += ". " + e.hint
	}
	return s
}

// mbRefuse makes `err`, a refusal in native's words, the tool's own: named for
// the tool (a refusal that already carries a hint keeps it).
func mbRefuse(tool string, err error) error {
	if err == nil {
		return nil
	}
	var r *mbRefusal
	if errors.As(err, &r) {
		if r.tool == "" {
			r.tool = tool
		}
		return r
	}
	return &mbRefusal{tool: tool, native: err.Error()}
}

// mbNativeText is the words of a refusal without the tool's name and hint: what
// pflow-native would say.
func mbNativeText(err error) string {
	var r *mbRefusal
	if errors.As(err, &r) {
		return r.native
	}
	return err.Error()
}

// mbPortsHint says which ports a subnet has and how to get one. `derived` is
// whether a subnet that declares none has one per exported place (everything
// but pflow_bundle_candidates).
func mbPortsHint(s *metamodel.Subnet, derived bool) string {
	ids := make([]string, 0, len(s.Ports))
	for _, p := range s.Ports {
		ids = append(ids, fmt.Sprintf("%q", p.ID))
	}
	sort.Strings(ids)
	switch {
	case len(ids) > 0 && len(ids) <= 40:
		return fmt.Sprintf("subnet %q has the ports %s", s.ID, strings.Join(ids, ", "))
	case len(ids) > 40:
		return fmt.Sprintf("subnet %q has %d ports (%s, ...)", s.ID, len(ids), strings.Join(ids[:40], ", "))
	case derived:
		return fmt.Sprintf("subnet %q has no ports: declare them in its \"ports\" (a port names an exported place, or a transition with \"target\": \"transition\"), or export places, whose ids become its ports", s.ID)
	}
	return fmt.Sprintf("subnet %q declares no ports, so it offers no candidates: declare them in its \"ports\" (a port names an exported place, or a transition with \"target\": \"transition\")", s.ID)
}
