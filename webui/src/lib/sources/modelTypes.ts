export const optionalChioce = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place1": { "offset": 0, "x": 41, "y": 105 },
        "place2": { "offset": 1, "initial": 1, "x": 41, "y": 185 }
    },
    "transitions": {
        "txn1": { "x": 158, "y": 139 }
    },
    "arcs": [
        { "source": "place1", "target": "txn1" },
        { "source": "place2", "target": "txn1" }
    ]
}
export const wf = {
    "modelType": "workflow",
    "version": "v0",
    "places": {
        "place1": { "offset": 0, "x": 41, "y": 105 },
        "place2": { "offset": 1, "initial": 1, "x": 41, "y": 185 }
    },
    "transitions": {
        "txn1": { "x": 158, "y": 139 }
    },
    "arcs": [
        { "source": "place1", "target": "txn1" },
        { "source": "place2", "target": "txn1" }
    ]
}

export const output2 = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place1": { "offset": 0, "x": 287, "y": 208 },
        "place2": { "offset": 1, "x": 291, "y": 109 },
        "place0": { "offset": 2, "initial": 1, "x": 45, "y": 138 }
    },
    "transitions": {
        "txn1": { "x": 158, "y": 139 }
    },
    "arcs": [
        { "source": "txn1", "target": "place1" },
        { "source": "txn1", "target": "place2" },
        { "source": "place0", "target": "txn1" }
    ]
}
export const output2wf = {
    "modelType": "workflow",
    "version": "v0",
    "places": {
        "place1": { "offset": 0, "x": 287, "y": 208 },
        "place2": { "offset": 1, "x": 291, "y": 109 },
        "place0": { "offset": 2, "initial": 1, "x": 45, "y": 138 }
    },
    "transitions": {
        "txn1": { "x": 158, "y": 139 }
    },
    "arcs": [
        { "source": "txn1", "target": "place1" },
        { "source": "txn1", "target": "place2" },
        { "source": "place0", "target": "txn1" }
    ]
}
export const sandwich= {
    "modelType": "workflow",
    "version": "v0",
    "places": {
        "start": { "offset": 0, "initial": 1, "x": 50, "y": 100 },
        "getBread": { "offset": 1, "x": 250, "y": 100 },
        "addFilling": { "offset": 2, "x": 450, "y": 100 },
        "closeSandwich": { "offset": 3, "x": 650, "y": 100 },
        "end": { "offset": 4, "x": 850, "y": 100 }
    },
    "transitions": {
        "startToBread": { "x": 150, "y": 100 },
        "breadToFilling": { "x": 350, "y": 100 },
        "fillingToClose": { "x": 550, "y": 100 },
        "closeToEnd": { "x": 750, "y": 100 }
    },
    "arcs": [
        { "source": "start", "target": "startToBread" },
        { "source": "startToBread", "target": "getBread" },
        { "source": "getBread", "target": "breadToFilling" },
        { "source": "breadToFilling", "target": "addFilling" },
        { "source": "addFilling", "target": "fillingToClose" },
        { "source": "fillingToClose", "target": "closeSandwich" },
        { "source": "closeSandwich", "target": "closeToEnd" },
        { "source": "closeToEnd", "target": "end" }
    ]
}

export const wfNet= {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": { "offset": 0, "initial": 1, "x": 89, "y": 186 },
        "place1": { "offset": 1, "x": 314, "y": 228 },
        "place2": { "offset": 2, "x": 312, "y": 151 },
        "place3": { "offset": 3, "x": 581, "y": 202 }
    },
    "transitions": {
        "txn0": { "x": 214, "y": 151 },
        "txn1": { "x": 213, "y": 226 },
        "txn2": { "x": 433, "y": 274 },
        "txn3": { "x": 433, "y": 198 },
        "txn4": { "x": 432, "y": 121 }
    },
    "arcs": [
        { "source": "place0", "target": "txn0" },
        { "source": "place0", "target": "txn1" },
        { "source": "txn1", "target": "place1" },
        { "source": "place1", "target": "txn2" },
        { "source": "place1", "target": "txn3" },
        { "source": "txn0", "target": "place2" },
        { "source": "place2", "target": "txn4" },
        { "source": "txn4", "target": "place3" },
        { "source": "txn3", "target": "place3" },
        { "source": "txn2", "target": "place3" },
        { "source": "place2", "target": "txn3" }
    ]
}
