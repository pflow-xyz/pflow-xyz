package svg

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"strings"
)

// Visual constants for rendering
const (
	placeRadius        = 16.0
	transitionWidth    = 30.0
	transitionHeight   = 30.0
	placePadding       = 18.0  // placeRadius + 2
	transitionPadding  = 17.0  // transitionWidth/2 + 2
	arrowheadSize      = 8.0
	inhibitorRadius    = 6.0
	tipOffsetMultiplier = 0.9
	minDistance        = 1.0   // Minimum distance to prevent division by zero
	transitionRadius   = 4.0   // Border radius for rounded corners
)

// PetriNet represents a Petri net JSON-LD structure
type PetriNet struct {
	Arcs        []Arc                 `json:"arcs"`
	Places      map[string]Place      `json:"places"`
	Transitions map[string]Transition `json:"transitions"`
	Token       []string              `json:"token"`
}

// Label returns the label for a place, falling back to the ID if no label is set
func (p Place) Label(id string) string {
	if p.LabelText != "" {
		return p.LabelText
	}
	return id
}

// Label returns the label for a transition, falling back to the ID if no label is set
func (t Transition) Label(id string) string {
	if t.LabelText != "" {
		return t.LabelText
	}
	return id
}

// Arc represents an arrow in the Petri net
type Arc struct {
	Type              string  `json:"@type"`
	Source            string  `json:"source"`
	Target            string  `json:"target"`
	Weight            []int   `json:"weight"`
	InhibitTransition bool    `json:"inhibitTransition"`
}

// Place represents a place in the Petri net
type Place struct {
	Type      string    `json:"@type"`
	Initial   []int     `json:"initial"`
	Capacity  []float64 `json:"capacity"`
	Offset    int       `json:"offset"`
	X         float64   `json:"x"`
	Y         float64   `json:"y"`
	LabelText string    `json:"label,omitempty"`
}

// Transition represents a transition in the Petri net
type Transition struct {
	Type      string  `json:"@type"`
	X         float64 `json:"x"`
	Y         float64 `json:"y"`
	LabelText string  `json:"label,omitempty"`
}

// NodePosition represents the position and type of a node
type NodePosition struct {
	X       float64
	Y       float64
	IsPlace bool
}

// GenerateSVG generates an SVG representation of a Petri net from JSON-LD data
func GenerateSVG(jsonData []byte) (string, error) {
	var petriNet PetriNet
	if err := json.Unmarshal(jsonData, &petriNet); err != nil {
		return "", fmt.Errorf("failed to parse JSON-LD: %w", err)
	}

	// Calculate bounds
	minX, minY, maxX, maxY := calculateBounds(petriNet)
	
	// Add padding
	padding := 30.0
	minX -= padding
	minY -= padding
	maxX += padding
	maxY += padding
	
	width := maxX - minX
	height := maxY - minY
	
	// Minimum size
	if width < 100 {
		width = 100
	}
	if height < 100 {
		height = 100
	}

	var buf bytes.Buffer
	
	// SVG header
	buf.WriteString(fmt.Sprintf(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="%.1f %.1f %.1f %.1f" width="%.0f" height="%.0f">`, 
		minX, minY, width, height, width, height))
	buf.WriteString("\n")
	
	// Define styles
	buf.WriteString(`<defs>`)
	buf.WriteString(`<style>`)
	buf.WriteString(`.place { fill: #fff; stroke: #333; stroke-width: 2; }`)
	buf.WriteString(`.place-cap-full { fill: #ffebee; }`)
	buf.WriteString(`.transition { fill: #ffffff; stroke: #000; stroke-width: 1; }`)
	buf.WriteString(`.transition-active { fill: #62fa75; stroke: #000; }`)
	buf.WriteString(`.arc { stroke: #cfcfcf; stroke-width: 1; fill: none; }`)
	buf.WriteString(`.arc-active { stroke: #2a6fb8; }`)
	buf.WriteString(`.arrowhead { fill: #cfcfcf; }`)
	buf.WriteString(`.arrowhead-active { fill: #2a6fb8; }`)
	buf.WriteString(`.inhibitor { fill: #fff; stroke: #cfcfcf; stroke-width: 1.3; }`)
	buf.WriteString(`.inhibitor-active { stroke: #2a6fb8; }`)
	buf.WriteString(`.token-dot { fill: #333; }`)
	buf.WriteString(`.token-text { font-family: system-ui, Arial; font-size: 12px; fill: #333; text-anchor: middle; dominant-baseline: middle; }`)
	buf.WriteString(`.weight-badge { font-family: system-ui, Arial; font-size: 10px; fill: #666; text-anchor: middle; dominant-baseline: middle; }`)
	buf.WriteString(`.weight-bg { fill: #fafafa; stroke: #ddd; stroke-width: 1; }`)
	buf.WriteString(`.weight-bg-active { fill: #e8f0fb; stroke: #2a6fb8; }`)
	buf.WriteString(`.label-text { font-family: system-ui, Arial; font-size: 11px; fill: #333; text-anchor: middle; dominant-baseline: hanging; }`)
	buf.WriteString(`</style>`)
	buf.WriteString(`</defs>`)
	buf.WriteString("\n")
	
	// Create node position map
	nodes := make(map[string]NodePosition)
	for id, place := range petriNet.Places {
		nodes[id] = NodePosition{X: place.X, Y: place.Y, IsPlace: true}
	}
	for id, transition := range petriNet.Transitions {
		nodes[id] = NodePosition{X: transition.X, Y: transition.Y, IsPlace: false}
	}
	
	// Calculate marking for determining enabled transitions
	marks := calculateMarking(petriNet)
	
	// Draw arcs
	for i, arc := range petriNet.Arcs {
		srcNode, srcOk := nodes[arc.Source]
		trgNode, trgOk := nodes[arc.Target]
		if !srcOk || !trgOk {
			continue
		}
		
		// Determine if this arc's related transition is active
		relatedTransitionID := arc.Source
		if srcNode.IsPlace {
			relatedTransitionID = arc.Target
		}
		active := isEnabled(relatedTransitionID, petriNet, marks)
		
		drawArc(&buf, srcNode, trgNode, arc, active, i)
	}
	
	// Draw places
	for id, place := range petriNet.Places {
		tokenCount := 0
		for _, count := range place.Initial {
			tokenCount += count
		}
		capacity := getCapacity(place)
		isFull := capacity != math.Inf(1) && float64(tokenCount) >= capacity
		label := place.Label(id)
		drawPlace(&buf, place.X, place.Y, tokenCount, isFull, label)
	}
	
	// Draw transitions
	for id, transition := range petriNet.Transitions {
		active := isEnabled(id, petriNet, marks)
		label := transition.Label(id)
		drawTransition(&buf, transition.X, transition.Y, active, label)
	}
	
	buf.WriteString("</svg>\n")
	
	return buf.String(), nil
}

func calculateBounds(net PetriNet) (minX, minY, maxX, maxY float64) {
	first := true
	
	for _, place := range net.Places {
		if first {
			minX, maxX = place.X, place.X
			minY, maxY = place.Y, place.Y
			first = false
		} else {
			if place.X < minX {
				minX = place.X
			}
			if place.X > maxX {
				maxX = place.X
			}
			if place.Y < minY {
				minY = place.Y
			}
			if place.Y > maxY {
				maxY = place.Y
			}
		}
	}
	
	for _, transition := range net.Transitions {
		if first {
			minX, maxX = transition.X, transition.X
			minY, maxY = transition.Y, transition.Y
			first = false
		} else {
			if transition.X < minX {
				minX = transition.X
			}
			if transition.X > maxX {
				maxX = transition.X
			}
			if transition.Y < minY {
				minY = transition.Y
			}
			if transition.Y > maxY {
				maxY = transition.Y
			}
		}
	}
	
	return
}

func drawPlace(buf *bytes.Buffer, x, y float64, tokenCount int, isFull bool, label string) {
	class := "place"
	if isFull {
		class += " place-cap-full"
	}
	
	buf.WriteString(fmt.Sprintf(`<circle cx="%.1f" cy="%.1f" r="%.1f" class="%s"/>`, x, y, placeRadius, class))
	buf.WriteString("\n")
	
	// Draw tokens
	if tokenCount > 1 {
		// Draw count as text
		buf.WriteString(fmt.Sprintf(`<text x="%.1f" y="%.1f" class="token-text">%d</text>`, x, y, tokenCount))
		buf.WriteString("\n")
	} else if tokenCount == 1 {
		// Draw single dot
		buf.WriteString(fmt.Sprintf(`<circle cx="%.1f" cy="%.1f" r="3" class="token-dot"/>`, x, y))
		buf.WriteString("\n")
	}
	
	// Draw label below the place
	if label != "" {
		labelY := y + placeRadius + 6
		buf.WriteString(fmt.Sprintf(`<text x="%.1f" y="%.1f" class="label-text">%s</text>`, x, labelY, escapeXML(label)))
		buf.WriteString("\n")
	}
}

func drawTransition(buf *bytes.Buffer, x, y float64, active bool, label string) {
	class := "transition"
	if active {
		class += " transition-active"
	}
	
	buf.WriteString(fmt.Sprintf(`<rect x="%.1f" y="%.1f" width="%.1f" height="%.1f" rx="%.1f" ry="%.1f" class="%s"/>`, 
		x-transitionWidth/2, y-transitionHeight/2, transitionWidth, transitionHeight, transitionRadius, transitionRadius, class))
	buf.WriteString("\n")
	
	// Draw label below the transition
	if label != "" {
		labelY := y + transitionHeight/2 + 6
		buf.WriteString(fmt.Sprintf(`<text x="%.1f" y="%.1f" class="label-text">%s</text>`, x, labelY, escapeXML(label)))
		buf.WriteString("\n")
	}
}

func drawArc(buf *bytes.Buffer, src, trg NodePosition, arc Arc, active bool, arcIndex int) {
	// Calculate padding based on node type
	padSrc := placePadding
	if !src.IsPlace {
		padSrc = transitionPadding
	}
	padTrg := placePadding
	if !trg.IsPlace {
		padTrg = transitionPadding
	}
	
	// Calculate arc endpoints
	dx := trg.X - src.X
	dy := trg.Y - src.Y
	dist := math.Sqrt(dx*dx + dy*dy)
	if dist == 0 {
		dist = minDistance
	}
	ux := dx / dist
	uy := dy / dist
	
	tipOffset := arrowheadSize * tipOffsetMultiplier
	if arc.InhibitTransition {
		tipOffset = inhibitorRadius + 2.0
	}
	
	ex := src.X + ux*padSrc
	ey := src.Y + uy*padSrc
	fx := trg.X - ux*(padTrg+tipOffset)
	fy := trg.Y - uy*(padTrg+tipOffset)
	
	// Draw line
	arcClass := "arc"
	if active {
		arcClass += " arc-active"
	}
	buf.WriteString(fmt.Sprintf(`<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" class="%s"/>`, ex, ey, fx, fy, arcClass))
	buf.WriteString("\n")
	
	// Draw arrowhead or inhibitor
	if arc.InhibitTransition {
		inhibitorClass := "inhibitor"
		if active {
			inhibitorClass += " inhibitor-active"
		}
		buf.WriteString(fmt.Sprintf(`<circle cx="%.1f" cy="%.1f" r="%.1f" class="%s"/>`, fx, fy, inhibitorRadius, inhibitorClass))
		buf.WriteString("\n")
	} else {
		// Draw arrowhead
		ahx := fx + (-ux*arrowheadSize - uy*arrowheadSize*0.45)
		ahy := fy + (-uy*arrowheadSize + ux*arrowheadSize*0.45)
		bhx := fx + (-ux*arrowheadSize + uy*arrowheadSize*0.45)
		bhy := fy + (-uy*arrowheadSize - ux*arrowheadSize*0.45)
		
		arrowClass := "arrowhead"
		if active {
			arrowClass += " arrowhead-active"
		}
		buf.WriteString(fmt.Sprintf(`<path d="M %.1f %.1f L %.1f %.1f L %.1f %.1f Z" class="%s"/>`, 
			fx, fy, ahx, ahy, bhx, bhy, arrowClass))
		buf.WriteString("\n")
	}
	
	// Draw weight badge (always show weight, including 1)
	weight := 1
	if len(arc.Weight) > 0 {
		weight = arc.Weight[0]
	}
	
	bx := (ex + fx) / 2
	by := (ey + fy) / 2
	
	badgeBgClass := "weight-bg"
	if active {
		badgeBgClass += " weight-bg-active"
	}
	
	// Draw badge background
	buf.WriteString(fmt.Sprintf(`<circle cx="%.1f" cy="%.1f" r="10" class="%s"/>`, bx, by, badgeBgClass))
	buf.WriteString("\n")
	
	// Draw weight text
	buf.WriteString(fmt.Sprintf(`<text x="%.1f" y="%.1f" class="weight-badge">%d</text>`, bx, by, weight))
	buf.WriteString("\n")
}

func calculateMarking(net PetriNet) map[string]int {
	marks := make(map[string]int)
	for id, place := range net.Places {
		count := 0
		for _, c := range place.Initial {
			count += c
		}
		marks[id] = count
	}
	return marks
}

func isEnabled(transitionID string, net PetriNet, marks map[string]int) bool {
	// Check all arcs connected to this transition
	for _, arc := range net.Arcs {
		weight := 1
		if len(arc.Weight) > 0 {
			weight = arc.Weight[0]
		}
		
		if arc.InhibitTransition {
			// Inhibitor arc logic (matches JavaScript implementation)
			if arc.Target == transitionID {
				// Input inhibitor (from place to transition)
				// Transition is disabled when source place tokens >= weight
				if tokens, ok := marks[arc.Source]; ok {
					if tokens >= weight {
						return false // Inhibited
					}
				}
			} else if arc.Source == transitionID {
				// Output inhibitor (from transition to place)
				// Transition is disabled when target place has fewer than 'weight' tokens
				if tokens, ok := marks[arc.Target]; ok {
					if tokens < weight {
						return false // Target place doesn't have enough tokens
					}
				} else {
					return false // Target place not in marking
				}
			}
		} else {
			// Normal arc logic
			if arc.Target == transitionID {
				// Input arc (from place to transition)
				if tokens, ok := marks[arc.Source]; ok {
					if tokens < weight {
						return false // Not enough tokens
					}
				} else {
					return false
				}
			} else if arc.Source == transitionID {
				// Output arc (from transition to place)
				if place, ok := net.Places[arc.Target]; ok {
					capacity := getCapacity(place)
					if tokens, ok := marks[arc.Target]; ok {
						if capacity != math.Inf(1) && float64(tokens+weight) > capacity {
							return false // Would exceed capacity
						}
					}
				}
			}
		}
	}
	
	return true
}

func getCapacity(place Place) float64 {
	if len(place.Capacity) > 0 {
		return place.Capacity[0]
	}
	return math.Inf(1)
}

// escapeXML escapes special XML characters in text
func escapeXML(s string) string {
	s = strings.ReplaceAll(s, "&", "&amp;")
	s = strings.ReplaceAll(s, "<", "&lt;")
	s = strings.ReplaceAll(s, ">", "&gt;")
	s = strings.ReplaceAll(s, "\"", "&quot;")
	s = strings.ReplaceAll(s, "'", "&apos;")
	return s
}
