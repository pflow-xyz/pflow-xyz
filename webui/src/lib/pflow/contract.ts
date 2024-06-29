export const DEFAULT_CONTRACT = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

// Define the TypeScript interface
export interface DeclarationResult {
    // Add the properties here according to the structure of the returned data
    // For example:
    places: Array<{ label: string, x: BigInt, y: BigInt, initial: BigInt, capacity: BigInt }>;
    transitions: Array<{ label: string, x: BigInt, y: BigInt, role: BigInt }>;
    arcs: Array<{
        source: string,
        target: string,
        weight: BigInt,
        consume: boolean,
        produce: boolean,
        inhibit: boolean,
        read: boolean
    }>;
}

const ScaleX = 80;
const ScaleY = 80;
const MarginY = 22;

// Convert the returned data to the metamodel
export function contractDeclarationToJson(contractDef: DeclarationResult): string {
    let d = {
        modelType: "petriNet",
        version: "v0",
        places: {},
        transitions: {},
        arcs: []
    }

    for (let place of contractDef.places) {
        // @ts-ignore
        d.places[place.label] = {
            x: Number(place.x) * ScaleX,
            y: Number(place.y) * ScaleY + MarginY,
            initial: Number(place.initial),
            capacity: Number(place.capacity),
        }
    }

    for (let transition of contractDef.transitions) {
        // @ts-ignore
        d.transitions[transition.label] = {
            x: Number(transition.x) * ScaleX,
            y: Number(transition.y) * ScaleY + MarginY,
            role: Number(transition.role)
        }
    }

    for (let arc of contractDef.arcs) {
        // @ts-ignore
        d.arcs.push({
            source: arc.source,
            target: arc.target,
            weight: Number(arc.weight),
            consume: arc.consume,
            produce: arc.produce,
            inhibit: arc.inhibit,
            read: arc.read
        })
    }

    return JSON.stringify(d);
}

// NOTE: extracted from the contract ABI
export const abi = [{
    "anonymous": false,
    "inputs": [{"indexed": true, "internalType": "uint8", "name": "role", "type": "uint8"}, {
        "indexed": true,
        "internalType": "uint8",
        "name": "actionId",
        "type": "uint8"
    }, {"indexed": true, "internalType": "uint256", "name": "scalar", "type": "uint256"}],
    "name": "SignalEvent",
    "type": "event"
},
    {
        "inputs": [], "name": "declaration", "outputs": [{
            "components": [{
                "components": [{
                    "internalType": "string",
                    "name": "label",
                    "type": "string"
                }, {"internalType": "uint8", "name": "x", "type": "uint8"}, {
                    "internalType": "uint8",
                    "name": "y",
                    "type": "uint8"
                }, {"internalType": "uint256", "name": "initial", "type": "uint256"}, {
                    "internalType": "uint256",
                    "name": "capacity",
                    "type": "uint256"
                }], "internalType": "struct Declaration.place[]", "name": "places", "type": "tuple[]"
            }, {
                "components": [{"internalType": "string", "name": "label", "type": "string"}, {
                    "internalType": "uint8",
                    "name": "x",
                    "type": "uint8"
                }, {"internalType": "uint8", "name": "y", "type": "uint8"}, {
                    "internalType": "uint8",
                    "name": "role",
                    "type": "uint8"
                }], "internalType": "struct Declaration.transition[]", "name": "transitions", "type": "tuple[]"
            }, {
                "components": [{"internalType": "string", "name": "source", "type": "string"}, {
                    "internalType": "string",
                    "name": "target",
                    "type": "string"
                }, {"internalType": "uint256", "name": "weight", "type": "uint256"}, {
                    "internalType": "bool",
                    "name": "consume",
                    "type": "bool"
                }, {"internalType": "bool", "name": "produce", "type": "bool"}, {
                    "internalType": "bool",
                    "name": "inhibit",
                    "type": "bool"
                }, {"internalType": "bool", "name": "read", "type": "bool"}],
                "internalType": "struct Declaration.arc[]",
                "name": "arcs",
                "type": "tuple[]"
            }], "internalType": "struct Declaration.PetriNet", "name": "", "type": "tuple"
        }], "stateMutability": "view", "type": "function"
    },
    {
        "inputs": [{"internalType": "uint8", "name": "action", "type": "uint8"}, {
            "internalType": "uint256",
            "name": "scalar",
            "type": "uint256"
        }], "name": "dryRun", "outputs": [], "stateMutability": "view", "type": "function"
    },
    {
        "inputs": [], "name": "model", "outputs": [{
            "components": [{
                "components": [{
                    "internalType": "string",
                    "name": "label",
                    "type": "string"
                }, {"internalType": "uint8", "name": "offset", "type": "uint8"}, {
                    "components": [{
                        "internalType": "uint8",
                        "name": "x",
                        "type": "uint8"
                    }, {"internalType": "uint8", "name": "y", "type": "uint8"}],
                    "internalType": "struct Model.Position",
                    "name": "position",
                    "type": "tuple"
                }, {"internalType": "uint256", "name": "initial", "type": "uint256"}, {
                    "internalType": "uint256",
                    "name": "capacity",
                    "type": "uint256"
                }], "internalType": "struct Model.Place[]", "name": "places", "type": "tuple[]"
            }, {
                "components": [{"internalType": "string", "name": "label", "type": "string"}, {
                    "internalType": "uint8",
                    "name": "offset",
                    "type": "uint8"
                }, {
                    "components": [{"internalType": "uint8", "name": "x", "type": "uint8"}, {
                        "internalType": "uint8",
                        "name": "y",
                        "type": "uint8"
                    }], "internalType": "struct Model.Position", "name": "position", "type": "tuple"
                }, {"internalType": "uint8", "name": "role", "type": "uint8"}, {
                    "internalType": "int256[]",
                    "name": "delta",
                    "type": "int256[]"
                }, {"internalType": "int256[]", "name": "guard", "type": "int256[]"}],
                "internalType": "struct Model.Transition[]",
                "name": "transitions",
                "type": "tuple[]"
            }, {
                "components": [{
                    "internalType": "uint256",
                    "name": "weight",
                    "type": "uint256"
                }, {
                    "components": [{"internalType": "string", "name": "label", "type": "string"}, {
                        "internalType": "uint8",
                        "name": "offset",
                        "type": "uint8"
                    }, {"internalType": "enum Model.NodeKind", "name": "kind", "type": "uint8"}],
                    "internalType": "struct Model.Node",
                    "name": "source",
                    "type": "tuple"
                }, {
                    "components": [{"internalType": "string", "name": "label", "type": "string"}, {
                        "internalType": "uint8",
                        "name": "offset",
                        "type": "uint8"
                    }, {"internalType": "enum Model.NodeKind", "name": "kind", "type": "uint8"}],
                    "internalType": "struct Model.Node",
                    "name": "target",
                    "type": "tuple"
                }, {"internalType": "bool", "name": "inhibitor", "type": "bool"}, {
                    "internalType": "bool",
                    "name": "read",
                    "type": "bool"
                }], "internalType": "struct Model.Arc[]", "name": "arcs", "type": "tuple[]"
            }], "internalType": "struct Model.PetriNet", "name": "", "type": "tuple"
        }], "stateMutability": "view", "type": "function"
    }, {
        "inputs": [],
        "name": "sequence",
        "outputs": [{"internalType": "int256", "name": "", "type": "int256"}],
        "stateMutability": "view",
        "type": "function"
    }, {
        "inputs": [{"internalType": "uint8", "name": "action", "type": "uint8"}, {
            "internalType": "uint256",
            "name": "scalar",
            "type": "uint256"
        }], "name": "signal", "outputs": [], "stateMutability": "nonpayable", "type": "function"
    }, {
        "inputs": [{"internalType": "uint8[]", "name": "actions", "type": "uint8[]"}, {
            "internalType": "uint256[]",
            "name": "scalars",
            "type": "uint256[]"
        }], "name": "signalMany", "outputs": [], "stateMutability": "nonpayable", "type": "function"
    }, {
        "inputs": [{"internalType": "uint256", "name": "", "type": "uint256"}],
        "name": "state",
        "outputs": [{"internalType": "int256", "name": "", "type": "int256"}],
        "stateMutability": "view",
        "type": "function"
    }];

