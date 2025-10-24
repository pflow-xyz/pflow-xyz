# pflow-xyz

Lightweight web component for building, editing and simulating Petri nets in the browser.

The component is implemented as an ES module (`public/petri-view.js`)
and exposes a small API and events for integration.

## Features

- Visual editor for places, transitions and arcs
- Click / context actions to add/remove tokens and arcs
- Live simulation with manual firing and play/stop mode
- JSON LD persistence in a `<script type="application/ld+json">` or `localStorage`
- Optional in-page JSON editor (Ace) with download / fullscreen toolbar
- Undo/redo history, pan & zoom, scale meter

## Quick start

Include the module in a page (module script) or import it in your bundler:

```html
<script type="module" src="./public/petri-view.js"></script>

<petri-view id="pv" data-json-editor>
<script type="application/ld+json">
    {
      "@context": "https://pflow.xyz/schema",
      "@type": "PetriNet",
      "places": [
        { "@id": "p1", "label": "Place 1", "tokens": 1 },
        { "@id": "p2", "label": "Place 2", "tokens": 0 }
      ],
      "transitions": [
        { "@id": "t1", "label": "Transition 1" }
      ],
      "arcs": [
        { "@type": "Arc", "source": "p1", "target": "t1", "weight": 1 },
        { "@type": "Arc", "source": "t1", "target": "p2", "weight": 1 }
      ]
    }
</script>
</petri-view>
``
