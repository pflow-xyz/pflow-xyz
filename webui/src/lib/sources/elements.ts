export const transitionElement = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {},
    "transitions": {
        "txn0": {"x": 150, "y": 100},
    },
    "arcs": []
}

export const transitionInputDisabled = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 0, "capacity": 0, "x": 50, "y": 100},
        "place1": {"offset": 0, "initial": 0, "capacity": 0, "x": 250, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 150, "y": 100},
    },
    "arcs": [
        {"source": "txn0", "target": "place0", "weight": 1},
        {"source": "place1", "target": "txn0", "weight": 1},
    ]
}

export const transitionInputEnabled = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 0, "capacity": 0, "x": 50, "y": 100},
        "place1": {"offset": 0, "initial": 1, "capacity": 0, "x": 250, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 150, "y": 100},
    },
    "arcs": [
        {"source": "txn0", "target": "place0", "weight": 1},
        {"source": "place1", "target": "txn0", "weight": 1},
    ]
}

export const transitionInputFired = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 1, "capacity": 0, "x": 50, "y": 100},
        "place1": {"offset": 0, "initial": 0, "capacity": 0, "x": 250, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 150, "y": 100},
    },
    "arcs": [
        {"source": "txn0", "target": "place0", "weight": 1},
        {"source": "place1", "target": "txn0", "weight": 1},
    ]
}

export const placeElement = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 0, "capacity": 0, "x": 100, "y": 80},
        "place1": {"offset": 0, "initial": 1, "capacity": 0, "x": 200, "y": 80},
        "place2": {"offset": 0, "initial": 100, "capacity": 0, "x": 150, "y": 120}
    },
    "transitions": {},
    "arcs": []
}

export const arcElement = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 0, "capacity": 0, "x": 100, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 200, "y": 100},
    },
    "arcs": [
        {"source": "txn0", "target": "place0", "weight": 1},
    ]
}

export const firedArc = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 1, "capacity": 0, "x": 100, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 200, "y": 100},
    },
    "arcs": [
        {"source": "txn0", "target": "place0", "weight": 1},
    ]
}

export const arcCapacity = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 2, "capacity": 2, "x": 100, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 200, "y": 100},
    },
    "arcs": [
        {"source": "txn0", "target": "place0", "weight": 2},
    ]
}

export const arcWeight = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 0, "capacity": 0, "x": 100, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 200, "y": 100},
    },
    "arcs": [
        {"source": "txn0", "target": "place0", "weight": 2},
    ]
}

export const arcWeightFired = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 2, "capacity": 0, "x": 100, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 200, "y": 100},
    },
    "arcs": [
        {"source": "txn0", "target": "place0", "weight": 2},
    ]
}

export const inhibitorArcDisabled = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 1, "capacity": 0, "x": 100, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 200, "y": 100},
    },
    "arcs": [
        {"source": "place0", "target": "txn0", "weight": 1, "inhibit": true},
    ]
}

export const inhibitorArcEnabled = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 0, "capacity": 0, "x": 100, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 200, "y": 100},
    },
    "arcs": [
        {"source": "place0", "target": "txn0", "weight": 1, "inhibit": true},
    ]
}

export const inhibitorArcThreshold = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 1, "capacity": 0, "x": 100, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 200, "y": 100},
    },
    "arcs": [
        {"source": "place0", "target": "txn0", "weight": 2, "inhibit": true},
    ]
}

export const inhibitorArcThresholdMet = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 2, "capacity": 0, "x": 100, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 200, "y": 100},
    },
    "arcs": [
        {"source": "place0", "target": "txn0", "weight": 2, "inhibit": true},
    ]
}

export const readArcDisabled = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 1, "capacity": 0, "x": 100, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 200, "y": 100},
    },
    "arcs": [
        {"source": "txn0", "target": "place0", "weight": 2, "inhibit": true},
    ]
}

export const readArcEnabled = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 2, "capacity": 0, "x": 100, "y": 100}
    },
    "transitions": {
        "txn0": {"x": 200, "y": 100},
    },
    "arcs": [
        {"source": "txn0", "target": "place0", "weight": 2, "inhibit": true},
    ]
}