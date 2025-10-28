# pflow-xyz

Lightweight web component for building, editing and simulating Petri nets in the browser.

[![js deliver](https://img.shields.io/badge/js%20deliver-pflow--xyz--latest-blue)](https://cdn.stackdump.com/gh/pflow-xyz/pflow-xyz@latest/public/)


Try it out on github pages: https://pflow-xyz.github.io/pflow-xyz/public/

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
  "@version": "1.1",
  "arcs": [
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "txn0",
      "target": "place0",
      "weight": [
        1
      ]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": false,
      "source": "place0",
      "target": "txn1",
      "weight": [
        3
      ]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": true,
      "source": "txn2",
      "target": "place0",
      "weight": [
        3
      ]
    },
    {
      "@type": "Arrow",
      "inhibitTransition": true,
      "source": "place0",
      "target": "txn3",
      "weight": [
        1
      ]
    }
  ],
  "places": {
    "place0": {
      "@type": "Place",
      "capacity": [
        3
      ],
      "initial": [
        3
      ],
      "offset": 0,
      "x": 130,
      "y": 207
    }
  },
  "token": [
    "https://pflow.xyz/tokens/black"
  ],
  "transitions": {
    "txn0": {
      "@type": "Transition",
      "x": 50,
      "y": 120
    },
    "txn1": {
      "@type": "Transition",
      "x": 227,
      "y": 112
    },
    "txn2": {
      "@type": "Transition",
      "x": 43,
      "y": 307
    },
    "txn3": {
      "@type": "Transition",
      "x": 235,
      "y": 306
    }
  }
}
</script>
</petri-view>
```
