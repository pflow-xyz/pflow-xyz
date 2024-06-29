export const basicPlace = {
    "places": {
        "p1": {x: 60, y: 50},
    }
};
export const basicTransition = {
    "transitions": {
        "t1": {x: 60, y: 50},
    }
};
export const basicPlaceToken = {
    "places": {
        "p1": {x: 60, y: 50, initial: 1},
    },
};
export const basicArc = {
    "places": {
        "p1": {x: 22, y: 50, initial: 1},
    },
    "transitions": {
        "t1": {x: 88, y: 50},
    },
    "arcs": [
        {"source": "p1", "target": "t1"},
    ]
};
