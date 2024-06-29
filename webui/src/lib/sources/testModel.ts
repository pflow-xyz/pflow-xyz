export const testModel = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "place0": {"offset": 0, "initial": 1, "capacity": 3, "x": 130, "y": 207}
    },
    "transitions": {
        "txn0": {"x": 46, "y": 116},
        "txn1": {"x": 227, "y": 112},
        "txn2": {"x": 43, "y": 307},
        "txn3": {"x": 235, "y": 306}
    },
    "arcs": [
        {"source": "txn0", "target": "place0"},
        {"source": "place0", "target": "txn1", "weight": 3},
        {"source": "txn2", "target": "place0", "weight": 3, "inhibit": true},
        {"source": "place0", "target": "txn3", "inhibit": true}
    ]
};

export function testModelWithState(state: Array<number>) {
    const model = JSON.parse(JSON.stringify(testModel))
    state.forEach((tokens, index) => {
        model.places[`place${index}`].initial = tokens
    })
    return model
}