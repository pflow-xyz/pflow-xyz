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