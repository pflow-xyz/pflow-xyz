package image

import (
	"bufio"
	"fmt"
	"github.com/pflow-dev/pflow-xyz/protocol/metamodel"
	"github.com/pflow-dev/pflow-xyz/protocol/vasm"
	"io"
	"math"
	"os"
)

type SvgImage struct {
	stateMachine metamodel.Process
	width        int
	height       int
	writerOut    io.Writer
	onClose      func()
}

func NewSvgFile(outputPath string, xy ...int) *SvgImage {
	f, err := os.Create(outputPath)
	if err != nil {
		panic(err)
	}
	w := bufio.NewWriter(f)
	i := NewSvg(w, xy...)
	i.onClose = func() {
		err := w.Flush()
		if err != nil {
			panic(err)
		}
	}
	return i
}

func NewSvg(out io.Writer, xy ...int) *SvgImage {
	i := new(SvgImage)
	i.writerOut = out
	return i.newSvgImage(xy...)
}

func (i *SvgImage) newSvgImage(xy ...int) *SvgImage {
	if len(xy) >= 2 {
		i.width = xy[0]
		i.height = xy[1]
	} else {
		i.width = 1024
		i.height = 768
	}
	if len(xy) == 6 {
		i.writerOut.Write([]byte(fmt.Sprintf("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"%v\" height=\"%v\" viewBox=\"%v %v %v %v\">\n", xy[0], xy[1], xy[2], xy[3], xy[4], xy[5])))
	} else {
		i.writerOut.Write([]byte(fmt.Sprintf("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"%v\" height=\"%v\" >\n", i.width, i.height)))
	}

	i.writerOut.Write([]byte(
		`<defs><marker id="markerArrow1" markerWidth="23" markerHeight="13" refX="31" refY="6" orient="auto">` +
			`<rect width="28" height="3" fill="white" stroke="white" x="3" y="5"/><path d="M2,2 L2,11 L10,6 L2,2"/></marker>` +
			`<marker id="markerInhibit1" markerWidth="23" markerHeight="13" refX="31" refY="6" orient="auto">` +
			`<rect width="28" height="3" fill="white" stroke="white" x="3" y="5"/><circle cx="5" cy="6.5" r="4"/></marker></defs>` +
			"\n"))
	return i
}

func (i *SvgImage) End() {
	i.writerOut.Write([]byte("</svg>"))
}

func (i *SvgImage) Rect(x int, y int, width int, height int, extra string) {
	i.writerOut.Write([]byte(fmt.Sprintf(`<rect x="%v" y="%v" width="%v" height="%v" %s />`, x, y, width, height, extra)))
}

func (i *SvgImage) Circle(x int, y int, radius int, extra string) {
	i.writerOut.Write([]byte(fmt.Sprintf(`<circle cx="%v" cy="%v" r="%v" %s />`, x, y, radius, extra)))
}

func (i *SvgImage) Text(x int, y int, text string, extra string) {
	i.writerOut.Write([]byte(fmt.Sprintf(`<text x="%v" y="%v" %s>%s</text>`, x, y, extra, text)))
}

func (i *SvgImage) Path(path string) {
	i.writerOut.Write([]byte(fmt.Sprintf(`<path d="%s" />`, path)))
}

func (i *SvgImage) Line(x1 int, y1 int, x2 int, y2 int, extra string) {
	i.writerOut.Write([]byte(fmt.Sprintf("<line x1=\"%v\" y1=\"%v\" x2=\"%v\" y2=\"%v\" %s />\n", x1, y1, x2, y2, extra)))
}

func (i *SvgImage) Group() {
	i.writerOut.Write([]byte("<g>\n"))
}
func (i *SvgImage) Gend() {
	i.writerOut.Write([]byte("\n</g>\n"))
}

func (i *SvgImage) MarkerEnd() {
	i.writerOut.Write([]byte("</marker>\n"))
}
func (i *SvgImage) Render(m metamodel.MetaModel, initialVectors ...metamodel.Vector) {
	net := m.Net()
	i.stateMachine = vasm.Execute(m.Net(), initialVectors...)
	for _, a := range net.Arcs {
		i.arc(a)
	}
	for _, p := range net.Places {
		i.place(p)
	}
	for _, t := range net.Transitions {
		i.transition(t)
	}
	i.End()
	if i.onClose != nil {
		i.onClose()
	}
}

func (i *SvgImage) place(place *metamodel.Place) {
	i.Group()
	i.Circle(int(place.X), int(place.Y), 16, `strokeWidth="1.5" fill="#ffffff" stroke="#000000" orient="0" shapeRendering="auto"`)
	i.Text(int(place.X)-18, int(place.Y)-20, place.Label, `font-size="small"`)
	x := int(place.X)
	y := int(place.Y)

	tokens := i.stateMachine.TokenCount(place.Label)
	if tokens > 0 {
		if tokens == 1 {
			i.Circle(x, y, 2, `fill="#000000" stroke="#000000" orient="0" className="tokens"`)
		} else if tokens < 10 {
			i.Text(x-4, y+5, fmt.Sprintf("%v", tokens), `font-size="large"`)
		} else if tokens >= 10 {
			i.Text(x-7, y+5, fmt.Sprintf("%v", tokens), `font-size="small"`)
		}
	}
	i.Gend()
}

func (i *SvgImage) arc(arc metamodel.Arc) {
	i.Group()

	var (
		y1     int64 = 0
		x1     int64 = 0
		y2     int64 = 0
		x2     int64 = 0
		weight int64 = 0
		marker       = "url(#markerArrow1)"
	)
	if arc.Inhibitor {
		marker = "url(#markerInhibit1)"
		if arc.Target.IsTransition() {
			p := arc.Source.GetPlace()
			t := arc.Target.GetTransition()
			g, ok := t.Guards[p.Label]
			if !ok {
				panic("missing guard: " + p.Label)
			}
			weight = g.Delta[p.Offset]
		} else {
			p := arc.Target.GetPlace()
			t := arc.Source.GetTransition()
			g, ok := t.Guards[p.Label]
			if !ok {
				panic("missing guard: " + p.Label)
			}
			weight = g.Delta[p.Offset]
		}
	} else {
		if arc.Source.IsTransition() {
			t := arc.Source.GetTransition()
			p := arc.Target.GetPlace()
			weight = t.Delta[p.Offset]
		} else if arc.Target.IsTransition() {
			p := arc.Source.GetPlace()
			t := arc.Target.GetTransition()
			weight = t.Delta[p.Offset]
		} else {
			panic("invalid arc")
		}
	}
	if arc.Source.IsPlace() {
		p := arc.Source.GetPlace()
		y1 = p.Y
		x1 = p.X
		t := arc.Target.GetTransition()
		y2 = t.Y
		x2 = t.X
	} else if arc.Source.IsTransition() {
		t := arc.Source.GetTransition()
		y1 = t.Y
		x1 = t.X
		p := arc.Target.GetPlace()
		y2 = p.Y
		x2 = p.X
	} else {
		panic("invalid arc declaration")
	}

	var midX = (x2 + x1) / 2
	var midY = (y2+y1)/2 - 8
	var offsetX int64 = 4
	var offsetY int64 = 4

	if math.Abs(float64(x2-midX)) < 8 {
		offsetX = 8
	}

	if math.Abs(float64(x2-midY)) < 8 {
		offsetY = 0
	}

	if weight < 0 {
		weight = 0 - weight
	}

	i.Line(int(x1), int(y1), int(x2), int(y2), `stroke="#000000" marker-end="`+marker+`"`)
	i.Text(int(midX-offsetX), int(midY+offsetY), fmt.Sprintf("%v", weight), `font-size="small"`)
	i.Gend()
}

func (i *SvgImage) transition(transition *metamodel.Transition) {
	i.Group()

	op := metamodel.Op{Action: transition.Label, Multiple: 1, Role: transition.Role.Label}

	var fill = "#ffffff"
	{
		valid, _, _ := i.stateMachine.TestFire(op)
		inhibited, _ := i.stateMachine.Inhibited(op)

		if !valid && inhibited {
			fill = "#fab5b0"
		} else if valid {
			fill = "#62fa75"
		}
	}

	x := int(transition.X - 17)
	y := int(transition.Y - 17)
	i.Rect(x, y, 30, 30, `stroke="#000000" fill="`+fill+`" rx="4"`)
	i.Text(x, y-8, transition.Label, `font-size="small"`)
	i.Gend()
}
