package metamodel

import (
	"encoding/json"
	"fmt"
	"github.com/pflow-dev/pflow-xyz/protocol/compression"
)

// Position defines location of a Place or Transition element
type Position struct {
	X int64 `json:"x"`
	Y int64 `json:"y"`
	Z int64 `json:"z"`
}

type Label = string

// Role defines user permission
type Role = struct {
	Label `json:"label"`
}

type RoleMap = map[string]Role

type Vector = []int64

func VectorToBytes(v Vector) []byte {
	bv := make([]byte, len(v))
	for i, b := range v {
		bv[i] = byte(b)
	}
	return bv
}

func VectorFromBytes(bv []byte) (v Vector) {
	v = make([]int64, len(bv))
	for i, b := range bv {
		byteToInt := int(b)
		if byteToInt > 127 {
			v[i] = int64(byteToInt - 256)
		} else {
			v[i] = int64(byteToInt)
		}
	}
	return v
}

// Place elements contain tokens
type Place struct {
	Label    string `json:"label"`
	Offset   int64  `json:"offset"`
	Position `json:"position"`
	Initial  int64 `json:"initial"`
	Capacity int64 `json:"capacity"`
}

type PlaceMap = map[string]*Place

// Guard attributes inhibit a transition
type Guard struct {
	Label    string `json:"label"`
	Delta    Vector `json:"delta"`
	Inverted bool   `json:"inverted"`
}

type GuardMap = map[string]*Guard

type SubnetNode struct {
	*PetriNet  `json:"-"`
	SubnetType string `json:"subnetType"`
}

// Transition defines a token transfer action
type Transition struct {
	Label        string `json:"label"`
	Position     `json:"position"`
	Role         Role     `json:"role"`
	Delta        Vector   `json:"delta"`
	Guards       GuardMap `json:"guards"`
	AllowReentry bool     `json:"allowReentry"`
	*SubnetNode  `json:"subNet"`
}

type TransitionMap = map[string]*Transition

// Node is an interstitial interface used when composing model elements
type Node interface {
	Tx(weight int64, target Node) Node
	Guard(weight int64, target Node) Node
	IsPlace() bool
	IsTransition() bool
	GetPlace() *Place
	GetTransition() *Transition
	Label(string) Node
	Position(x int64, y int64, z ...int64) Node
	Initial(int64) Node
	Capacity(int64) Node
	Role(string) Node
}

// Add vectors while asserting underflow & capacity checks
func Add(state Vector, delta Vector, multiple int64, capacity ...Vector) (ok bool, msg string, out Vector) {
	out = make([]int64, len(state))
	if multiple <= 0 {
		return ok, msg, out
	} else {
		ok = true
	}
	if len(capacity) == 0 {
		for i, v := range state {
			out[i] = v + delta[i]*multiple
			if out[i] < 0 {
				msg = Underflow
				ok = false
			}
		}
	} else {
		for i, v := range state {
			out[i] = v + delta[i]*multiple
			if out[i] < 0 {
				msg = Underflow
				ok = false
			} else if capacity[0][i] > 0 && out[i] > capacity[0][i] {
				msg = Overflow
				ok = false
			}
		}
	}
	return ok, msg, out
}

type node struct {
	m *Model
	*Place
	*Transition
}

// Initial set the initial token value
func (n *node) Initial(i int64) Node {
	if n.IsPlace() {
		n.Place.Initial = i
	} else {
		panic(ExpectedPlace)
	}
	return n
}

// Capacity sets max tokens a place can store 0 = unlimited
func (n *node) Capacity(i int64) Node {
	if n.IsPlace() {
		n.Place.Capacity = i
	} else {
		panic(ExpectedPlace)
	}
	return n
}

// Tx defines a path between elements
func (n *node) Tx(weight int64, target Node) Node {
	if n.IsPlace() && target.IsPlace() {
		panic(BadArcPlace)
	}
	if n.IsTransition() && target.IsTransition() {
		panic(BadArcTransition)
	}
	if weight < 0 {
		panic(BadWeight)
	}
	n.m.Arcs = append(n.m.Arcs, Arc{
		Source:    n,
		Target:    target,
		Weight:    weight,
		Inhibitor: false,
	})
	return n
}

// Guard defines an inhibitor rule
func (n *node) Guard(weight int64, target Node) Node {
	var isReadArc = false
	if n.IsTransition() {
		if !target.IsPlace() {
			panic(BadInhibitorTarget)
		}
		isReadArc = true
	}
	if target.IsPlace() {
		if !n.IsTransition() {
			panic(BadInhibitorTarget)
		}
	}
	if weight < 0 {
		panic(BadWeight)
	}
	n.m.Arcs = append(n.m.Arcs, Arc{
		Source:    n,
		Target:    target,
		Weight:    weight,
		Inhibitor: true,
		Read:      isReadArc,
	})
	return n
}

func (n *node) IsPlace() bool {
	return n.Transition == nil
}

func (n *node) IsTransition() bool {
	return n.Place == nil
}

func (n *node) GetPlace() *Place {
	return n.Place
}

func (n *node) GetTransition() *Transition {
	return n.Transition
}

// Position sets the graphical position of an element
func (n *node) Position(x int64, y int64, z ...int64) Node {
	zee := int64(0)
	if len(z) == 1 {
		zee = z[0]
	}
	if n.IsPlace() {
		n.Place.Position = Position{x, y, zee}
	} else if n.IsTransition() {
		n.Transition.Position = Position{x, y, zee}
	}
	return n
}

// Label sets the name of an element
func (n *node) Label(label string) Node {
	if n.IsPlace() {
		n.m.Places[label] = n.Place
		delete(n.m.Places, n.Place.Label)
		n.Place.Label = label
	} else if n.IsTransition() {
		n.m.Transitions[label] = n.Transition
		delete(n.m.Transitions, n.Transition.Label)
		n.Transition.Label = label
	}
	return n
}

// Role sets the role of an element
func (n *node) Role(label string) Node {
	if n.IsTransition() {
		r := Role{Label: label}
		n.m.Roles[label] = r
		n.Transition.Role = r
	} else {
		panic(ExpectedTransition)
	}
	return n
}

type Arc struct {
	Source    Node
	Target    Node
	Weight    int64
	Inhibitor bool
	Read      bool
}

type PetriNet struct {
	ModelType   string        `json:"modelType"`
	Places      PlaceMap      `json:"places"`
	Transitions TransitionMap `json:"transitions"`
	Arcs        []Arc         `json:"-"`
	Roles       RoleMap       `json:"-"`
	Path        string        `json:"path"`
	Cid         string        `json:"cid"`
}

func (n *PetriNet) EmptyVector() (v Vector) {
	return make([]int64, len(n.Places))
}

func (n *PetriNet) InitialVector() (v Vector) {
	v = n.EmptyVector()
	for _, p := range n.Places {
		v[p.Offset] = p.Initial
	}
	return v
}

func (n *PetriNet) CapacityVector() (v Vector) {
	v = n.EmptyVector()
	for _, p := range n.Places {
		v[p.Offset] = p.Capacity
	}
	return v
}

const (
	BadInhibitorSource  = "inhibitor source must be a place"
	BadInhibitorTarget  = "inhibitor target must be a transition"
	BadWeight           = "arc weight must be positive integer"
	BadMultiple         = "multiple must be positive integer"
	BadArcTransition    = "source and target are both transitions"
	BadArcPlace         = "source and target are both places"
	UnknownAction       = "unknown action"
	Underflow           = "output cannot be negative"
	Overflow            = "output exceeds capacity"
	FailedRoleAssertion = "role assertion failed"
	ExpectedTransition  = "element was expected to be a transition"
	ExpectedPlace       = "element was expected to be a place"
	InhibitedTransition = "transition is inhibited by place %s"
	UnexpectedArguments = "expected %v arguments got %v"
	OK                  = "OK"
)

type Op struct {
	Action   string
	Multiple int64
	Role     string
}

type Event struct {
	Seq   int64
	State Vector
	Op
}

type PlaceDefinition struct {
	Offset   int64 `json:"offset"`
	Initial  int64 `json:"initial"`
	Capacity int64 `json:"capacity"`
	X        int64 `json:"x"`
	Y        int64 `json:"y"`
}
type TransitionDefinition struct {
	Role string `json:"role"`
	X    int64  `json:"x"`
	Y    int64  `json:"y"`
}
type ArcDefinition struct {
	Source  string `json:"source"`
	Target  string `json:"target"`
	Weight  int64  `json:"weight"`
	Inhibit bool   `json:"inhibit"`
}

type PlaceMapDefinition map[string]PlaceDefinition
type TransitionMapDefinition map[string]TransitionDefinition
type ArcListDefinition []ArcDefinition

type DeclarationObject struct {
	ModelType   string                  `json:"modelType"`
	Version     string                  `json:"version"`
	Places      PlaceMapDefinition      `json:"places"`
	Transitions TransitionMapDefinition `json:"transitions"`
	Arcs        ArcListDefinition       `json:"arcs"`
}

type Process interface {
	GetState() Vector
	TokenCount(string) int64
	Inhibited(Op) (flag bool, label string)
	TestFire(Op) (flag bool, msg string, out Vector)
	Fire(Op) (ok bool, msg string, out Vector)
}

type Declaration interface {
	Cell(...func(p *Place)) Node
	Fn(...func(t *Transition)) Node
}

type Editor interface {
	PlaceSeq() Label
	TransitionSeq() Label
	Index() Editor
	Graph() Editor
}

type MetaModel interface {
	Net() *PetriNet
	Define(...func(Declaration)) MetaModel
	Edit() Editor
	Node(oid string) Node
	UnpackFromUrl(url string) (obj string, ok bool)
	ZipUrl(...string) (url string, ok bool)
	GetViewPort() (int, int, int, int)
	ToDeclaration() (obj []byte, ok bool)
	ToDeclarationObject() DeclarationObject
}

type Model struct {
	*PetriNet
}

func (m *Model) GetViewPort() (x1 int, y1 int, width int, height int) {
	var minX int64 = 0
	var minY int64 = 0
	var limitX int64 = 0
	var limitY int64 = 0

	for _, p := range m.Places {
		if limitX < p.X {
			limitX = p.X
		}
		if limitY < p.Y {
			limitY = p.Y
		}
		if minX == 0 || minX > p.X {
			minX = p.X
		}
		if minY == 0 || minY > p.Y {
			minY = p.Y
		}
	}
	for _, t := range m.Transitions {
		if limitX < t.X {
			limitX = t.X
		}
		if limitY < t.Y {
			limitY = t.Y
		}
		if minX == 0 || minX > t.X {
			minX = t.X
		}
		if minY == 0 || minY > t.Y {
			minY = t.Y
		}
	}
	const margin = 60
	x1 = int(minX) - margin
	y1 = int(minY) - margin
	x2 := int(limitX) + margin
	y2 := int(limitY) + margin

	return x1, y1, x2 - x1, y2 - y1
}
func (m *Model) ToDeclaration() ([]byte, bool) {
	modelObj := m.ToDeclarationObject()
	data, err := json.Marshal(modelObj) // TODO write a custom encoder to match front end style
	return data, err == nil
}

func (m *Model) ToDeclarationObject() DeclarationObject {
	modelObject := DeclarationObject{
		ModelType:   m.ModelType,
		Version:     "v0",
		Places:      PlaceMapDefinition{},
		Transitions: TransitionMapDefinition{},
		Arcs:        ArcListDefinition{},
	}
	for label, p := range m.Places {
		modelObject.Places[label] = PlaceDefinition{
			Offset:   p.Offset,
			Initial:  p.Initial,
			Capacity: p.Capacity,
			X:        p.X,
			Y:        p.Y,
		}
	}
	for label, t := range m.Transitions {
		modelObject.Transitions[label] = TransitionDefinition{
			Role: t.Role.Label,
			X:    t.X,
			Y:    t.Y,
		}
	}
	for _, a := range m.Arcs {
		if a.Weight == 0 {
			a.Weight = 1
		}
		if a.Source.IsTransition() {
			modelObject.Arcs = append(modelObject.Arcs, ArcDefinition{
				Source:  a.Source.GetTransition().Label,
				Target:  a.Target.GetPlace().Label,
				Weight:  a.Weight,
				Inhibit: a.Inhibitor,
			})
		} else {
			modelObject.Arcs = append(modelObject.Arcs, ArcDefinition{
				Source:  a.Source.GetPlace().Label,
				Target:  a.Target.GetTransition().Label,
				Weight:  a.Weight,
				Inhibit: a.Inhibitor,
			})

		}
	}
	return modelObject
}

func (m *Model) loadJsonDefinition(obj string) (ok bool) {
	ok = false
	if obj == "" {
		return false
	}
	modelObject := DeclarationObject{}
	err := json.Unmarshal([]byte(obj), &modelObject)
	if err != nil {
		panic(err)
	}
	m.ModelType = modelObject.ModelType
	m.Places = PlaceMap{}
	m.Transitions = TransitionMap{}
	m.Arcs = []Arc{}

	for label, p := range modelObject.Places {
		place := &Place{
			Label:    label,
			Offset:   p.Offset,
			Position: Position{X: p.X, Y: p.Y},
			Initial:  p.Initial,
			Capacity: p.Capacity,
		}
		m.Places[label] = place
	}

	for label, t := range modelObject.Transitions {
		var role = "default"
		if t.Role != "" {
			role = t.Role
		}
		m.Transitions[label] = &Transition{
			Label:    label,
			Position: Position{X: t.X, Y: t.Y},
			Role:     Role{Label: role},
			Delta:    m.EmptyVector(),
			Guards:   GuardMap{},
		}
	}

	for _, a := range modelObject.Arcs {
		source := m.Node(a.Source)
		target := m.Node(a.Target)
		if a.Weight == 0 {
			a.Weight = 1
		}
		if a.Inhibit {
			if source.IsPlace() {
				if !target.IsTransition() {
					panic(BadInhibitorTarget)
				}
				source.Guard(a.Weight, target)
			}
			if source.IsTransition() {
				if !target.IsPlace() {
					panic(BadInhibitorTarget)
				}
				source.Guard(a.Weight, target)
			}
		} else {
			source.Tx(a.Weight, target)
		}
	}

	m.Index()

	return true
}

func (m *Model) ZipUrl(path ...string) (urlString string, ok bool) {
	jsonObj, ok := m.ToDeclaration()
	if !ok {
		return "", false
	}

	// Compress the JSON object using Brotli
	compressedData, ok := compression.CompressBrotliEncode([]byte(jsonObj))
	if !ok {
		return "", false
	}

	if len(path) > 0 {
		urlString = path[0] + "?z=" + compressedData
		return urlString, true
	}
	return "?z=" + compressedData, true
}

func (m *Model) UnpackFromUrl(url string) (sourceJson string, ok bool) {
	sourceJson, ok = compression.DecompressEncodedUrl(url)
	if ok {
		ok = m.loadJsonDefinition(sourceJson)
	}
	return sourceJson, ok
}

func (m *Model) Guard(source Node, target Node, weight int64) {
	if weight < 0 {
		panic(BadWeight)
	}
	if source.IsTransition() {
		if !target.IsPlace() {
			panic(BadInhibitorSource)
		}
		m.Arcs = append(m.Arcs, Arc{
			Source:    source,
			Target:    target,
			Weight:    weight,
			Inhibitor: true,
			Read:      true,
		})
	}
	if source.IsPlace() {
		if !target.IsTransition() {
			panic(BadInhibitorTarget)
		}
		m.Arcs = append(m.Arcs, Arc{
			Source:    source,
			Target:    target,
			Weight:    weight,
			Inhibitor: true,
			Read:      false,
		})
	}
}

func (m *Model) Node(oid string) Node {
	if m.Places[oid] != nil {
		return &node{
			m:     m,
			Place: m.Places[oid],
		}
	}
	if m.Transitions[oid] != nil {
		return &node{
			m:          m,
			Transition: m.Transitions[oid],
		}
	}
	return nil
}

// Graph repopulates Arcs using delta vectors and guards
func (m *Model) Graph() Editor {
	placeMap := make(map[int64]string)
	for label, p := range m.Places {
		placeMap[p.Offset] = label
	}
	m.Arcs = []Arc{}
	for _, t := range m.Transitions {
		for offset, d := range t.Delta {
			if d < 0 {
				m.Arcs = append(m.Arcs, Arc{
					Source: &node{
						m:     m,
						Place: m.Places[placeMap[int64(offset)]],
					},
					Target: &node{
						m:          m,
						Transition: t,
					},
					Weight: 0 - d,
				})
			} else if d > 0 {
				m.Arcs = append(m.Arcs, Arc{
					Target: &node{
						m:     m,
						Place: m.Places[placeMap[int64(offset)]],
					},
					Source: &node{
						m:          m,
						Transition: t,
					},
					Weight: d,
				})
			}
		}
		for _, g := range t.Guards {
			for offset, d := range g.Delta {
				if d < 0 {
					m.Arcs = append(m.Arcs, Arc{
						Source: &node{
							m:     m,
							Place: m.Places[placeMap[int64(offset)]],
						},
						Target: &node{
							m:          m,
							Transition: t,
						},
						Weight:    0 - d,
						Inhibitor: true,
					})

				} else if d != 0 {
					panic(BadInhibitorTarget)
				}
			}
		}
	}
	return m
}

// Index loads Arcs into delta vectors and guards
func (m *Model) Index() Editor {
	for _, t := range m.Transitions {
		t.Delta = m.EmptyVector()
	}
	for _, arc := range m.Arcs {
		if arc.Inhibitor {
			if arc.Read {
				g := &Guard{
					Label:    arc.Target.GetPlace().Label,
					Delta:    m.EmptyVector(),
					Inverted: true,
				}
				g.Delta[arc.Target.GetPlace().Offset] = 0 - arc.Weight
				arc.Source.GetTransition().Guards[g.Label] = g
			} else {
				g := &Guard{
					Label:    arc.Source.GetPlace().Label,
					Delta:    m.EmptyVector(),
					Inverted: false,
				}
				g.Delta[arc.Source.GetPlace().Offset] = 0 - arc.Weight
				arc.Target.GetTransition().Guards[g.Label] = g
			}
		} else {
			if arc.Source.IsPlace() {
				arc.Target.GetTransition().Delta[arc.Source.GetPlace().Offset] = 0 - arc.Weight
			} else {
				arc.Source.GetTransition().Delta[arc.Target.GetPlace().Offset] = arc.Weight
			}
		}
	}
	return m
}

func (m *Model) Net() *PetriNet {
	return m.PetriNet
}

func New(netType ...string) MetaModel {
	modelType := "petriNet"
	if len(netType) == 1 {
		modelType = netType[0]
	}
	return &Model{
		PetriNet: &PetriNet{
			ModelType:   modelType,
			Places:      PlaceMap{},
			Transitions: TransitionMap{},
			Arcs:        []Arc{},
			Roles:       RoleMap{defaultRole.Label: defaultRole},
		},
	}
}

func (m *Model) Define(def ...func(declaration Declaration)) MetaModel {
	for _, definition := range def {
		definition(m)
	}
	m.Index()
	return m
}

// Edit returns the internal interface used to edit and reindex a model
func (m *Model) Edit() Editor {
	return m
}

// Cell declares a new transition element
func (m *Model) Cell(def ...func(p *Place)) Node {
	p := &Place{
		Label:    m.PlaceSeq(),
		Offset:   int64(len(m.Places)),
		Position: Position{},
		Initial:  0,
		Capacity: 0,
	}
	for _, definition := range def {
		definition(p)
	}
	m.Places[p.Label] = p
	return &node{
		m:     m,
		Place: p,
	}
}

var defaultRole = Role{Label: "default"}

// Fn declares a new transition element
func (m *Model) Fn(def ...func(t *Transition)) Node {
	t := &Transition{
		Label:        m.TransitionSeq(),
		Position:     Position{},
		Role:         defaultRole,
		Delta:        Vector{},
		Guards:       GuardMap{},
		AllowReentry: false,
	}
	for _, definition := range def {
		definition(t)
	}
	m.Roles[t.Role.Label] = t.Role
	m.Transitions[t.Label] = t
	return &node{
		m:          m,
		Transition: t,
	}
}

// Arc connects places and transitions
// at runtime Arcs are indexed as adjacency matrix by converting Arcs to vectors
func (m *Model) Arc(source Node, target Node, weight int64) {
	if source.IsPlace() && target.IsPlace() {
		panic(BadArcPlace)
	}
	if source.IsTransition() && target.IsTransition() {
		panic(BadArcTransition)
	}
	if weight < 0 {
		panic(BadWeight)
	}
	m.Arcs = append(m.Arcs, Arc{
		Source:    source,
		Target:    target,
		Weight:    weight,
		Inhibitor: false,
	})
}

// PlaceSeq generates unique labels for places
func (m *Model) PlaceSeq() Label {
	i := 0
	for {
		label := fmt.Sprintf("place%v", i)
		if m.Places[label] == nil {
			return label
		} else {
			i++
		}
	}
}

// TransitionSeq generate unique labels for transitions
func (m *Model) TransitionSeq() Label {
	i := 0
	for {
		label := fmt.Sprintf("txn%v", i)
		if m.Transitions[label] == nil {
			return label
		} else {
			i++
		}
	}
}
