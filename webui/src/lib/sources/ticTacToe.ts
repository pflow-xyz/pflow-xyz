export const ticTacToe = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "10": {"offset": 0, "initial": 1, "capacity": 1, "x": 80, "y": 182},
        "11": {"offset": 1, "initial": 1, "capacity": 1, "x": 160, "y": 182},
        "12": {"offset": 2, "initial": 1, "capacity": 1, "x": 240, "y": 182},
        "20": {"offset": 3, "initial": 1, "capacity": 1, "x": 80, "y": 262},
        "21": {"offset": 4, "initial": 1, "capacity": 1, "x": 160, "y": 262},
        "22": {"offset": 5, "initial": 1, "capacity": 1, "x": 240, "y": 262},
        "00": {"offset": 6, "initial": 1, "capacity": 1, "x": 80, "y": 102},
        "01": {"offset": 7, "initial": 1, "capacity": 1, "x": 160, "y": 102},
        "02": {"offset": 8, "initial": 1, "capacity": 1, "x": 240, "y": 102},
        "next": {"offset": 9, "capacity": 1, "x": 480, "y": 502}
    },
    "transitions": {
        "X00": {"x": 400, "y": 102},
        "X01": {"x": 480, "y": 102},
        "X02": {"x": 560, "y": 102},
        "X10": {"x": 400, "y": 182},
        "X11": {"x": 480, "y": 182},
        "X12": {"x": 560, "y": 182},
        "X20": {"x": 400, "y": 262},
        "X21": {"x": 480, "y": 262},
        "X22": {"x": 560, "y": 262},
        "000": {"role": "1", "x": 80, "y": 422},
        "O01": {"role": "1", "x": 160, "y": 422},
        "O02": {"role": "1", "x": 240, "y": 422},
        "O10": {"role": "1", "x": 80, "y": 502},
        "O11": {"role": "1", "x": 160, "y": 502},
        "O12": {"role": "1", "x": 240, "y": 502},
        "O20": {"role": "1", "x": 80, "y": 582},
        "O21": {"role": "1", "x": 160, "y": 582},
        "O22": {"role": "1", "x": 240, "y": 582}
    },
    "arcs": [
        {"source": "00", "target": "X00"},
        {"source": "X00", "target": "next"},
        {"source": "01", "target": "X01"},
        {"source": "X01", "target": "next"},
        {"source": "02", "target": "X02"},
        {"source": "X02", "target": "next"},
        {"source": "10", "target": "X10"},
        {"source": "X10", "target": "next"},
        {"source": "11", "target": "X11"},
        {"source": "X11", "target": "next"},
        {"source": "12", "target": "X12"},
        {"source": "X12", "target": "next"},
        {"source": "20", "target": "X20"},
        {"source": "X20", "target": "next"},
        {"source": "21", "target": "X21"},
        {"source": "X21", "target": "next"},
        {"source": "22", "target": "X22"},
        {"source": "X22", "target": "next"},
        {"source": "00", "target": "000"},
        {"source": "next", "target": "000"},
        {"source": "01", "target": "O01"},
        {"source": "next", "target": "O01"},
        {"source": "02", "target": "O02"},
        {"source": "next", "target": "O02"},
        {"source": "10", "target": "O10"},
        {"source": "next", "target": "O10"},
        {"source": "11", "target": "O11"},
        {"source": "next", "target": "O11"},
        {"source": "12", "target": "O12"},
        {"source": "next", "target": "O12"},
        {"source": "20", "target": "O20"},
        {"source": "next", "target": "O20"},
        {"source": "21", "target": "O21"},
        {"source": "next", "target": "O21"},
        {"source": "22", "target": "O22"},
        {"source": "next", "target": "O22"}
    ]
}