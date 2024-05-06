import * as mm from "./index";

type Version = "v0" | "v1";
const version: Version = "v0";

export interface RoleDef {
    label: string;
}

export interface Position {
    x: number;
    y: number;
    z?: number;
}

export type Dsl = { fn: Fn; cell: Cell; role: Role };
export type Fn = (label: string, role: RoleDef, position: Position) => TxNode
export type Cell = (label: string, initial: number, capacity: number, position: Position) => PlaceNode
export type Role = (label: string) => RoleDef
export type DeclarationFunction = ({fn, cell, role}: Dsl) => void
export type Vector = number[];
export type MetaType = "place" | "transition" | "arc";

interface TypeAnnotation {
    metaType: MetaType;
}

export type MetaObject = Place | Transition | Arc;

export interface Place extends TypeAnnotation {
    metaType: "place";
    label: string;
    offset: number;
    initial: number;
    capacity: number;
    position: Position;
}

export interface Guard {
    label: string;
    delta: Vector;
    inverted?: boolean;
}

export interface Transition extends TypeAnnotation {
    metaType: "transition";
    label: string;
    role: RoleDef;
    delta: Vector;
    guards: Map<string, Guard>;
    allowReentry: boolean;
    position: Position;
    subnet?: {
        m: Model;
        type: "entry" | "exit";
    };
}

export interface Arc extends TypeAnnotation {
    metaType: "arc";
    offset: number;
    source: {
        place?: Place;
        transition?: Transition;
    };
    target: {
        place?: Place;
        transition?: Transition;
    };
    weight: number;
    inhibit?: boolean;
    reentry?: boolean;
    inverted?: boolean;
}

export interface NodeType {
    nodeType: "place" | "transition";
}

export interface PlaceNode extends NodeType {
    nodeType: "place";
    place: Place;
    tx: (weight: number, target: TxNode) => void;
    guard: (weight: number, target: TxNode) => void;
}

export interface TxNode extends NodeType {
    nodeType: "transition";
    transition: Transition;
    tx: (weight: number, target: PlaceNode) => void;
    guard: (weight: number, target: PlaceNode) => void;
    reentry: (target: PlaceNode) => void;
}

export enum ModelType {
    elementary = "elementary",
    workflow = "workflow",
    petriNet = "petriNet",
}

export interface PetriNet {
    roles: Map<string, RoleDef>;
    places: Map<string, Place>;
    transitions: Map<string, Transition>;
    arcs: Array<Arc>;
    type: ModelType;
}

export interface Result {
    out: Vector;
    ok: boolean;
    role: string;
    inhibited?: boolean;
    overflow?: boolean;
    underflow?: boolean;
}

export interface Model {
    addPlace: (coords: { x: number; y: number }) => boolean;
    addTransition: (coords: { x: number; y: number }) => boolean;
    capacityVector: () => Vector;
    def: PetriNet;
    swapArc: (id: number) => void;
    deleteArc: (id: number) => void;
    deletePlace: (id: string) => void;
    deleteTransition: (id: string) => void;
    emptyVector: () => Vector;
    fire: (state: Vector, action: string, multiple: number, resolve?: (res: Result) => void, reject?: (res: Result) => void) => Result;
    getObject: (id: string) => Place | Transition;
    getPlace: (label: string | number) => Place;
    getSize: () => { width: number; height: number };
    guardFails: (state: Vector, action: string, multiple: number) => boolean;
    initialVector: () => Vector;
    newLabel: (label: string, suffix?: number) => string;
    objectExists: (id: string) => boolean;
    pushState: (state: Vector, action: string, multiple: number) => Result;
    renamePlace: (oldLabel: string, newLabel: string) => void;
    renameTransition: (oldLabel: string, newLabel: string) => void;
    setArcWeight: (offset: number, weight: number) => boolean;
    toObject: (mode?: "sparse" | "full") => any;
    toggleInhibitor: (id: number) => boolean;
    transitionSeq: () => string;
}

export type ModelDeclaration = {
    modelType: ModelType;
    version: Version;
    places: {
        [key: string]: { offset: number; initial?: number; capacity?: number; x: number; y: number };
    };
    transitions: {
        [key: string]: { role?: string; x: number; y: number };
    };
    arcs: {
        source: string;
        target: string;
        weight: number;
        inhibit?: boolean;
        reentry?: boolean;
    }[];
};

export interface ModelOptions {
    declaration?: DeclarationFunction | ModelDeclaration;
    type?: ModelType;
}

export function newModel({declaration, type}: ModelOptions): Model {
    const arcs = Array<Arc>();

    const def = {
        roles: new Map<string, RoleDef>(),
        places: new Map<string, Place>(),
        transitions: new Map<string, Transition>(),
        arcs,
        type: type || ModelType.petriNet,
    };

    function fn(label: string, role: RoleDef, position: Position): TxNode {
        const transition: Transition = {
            metaType: "transition",
            allowReentry: false,
            label,
            role,
            position,
            guards: new Map<string, Guard>(),
            delta: []
        };
        def.transitions.set(label, transition);

        const tx = (weight: number, target: PlaceNode): void => {
            if (def.type === ModelType.elementary && weight !== 1) {
                throw new Error(`elementary models only support weight 1, got ${weight}`);
            }
            arcs.push({
                metaType: "arc",
                offset: arcs.length,
                source: {transition: transition},
                target: {place: target.place},
                weight,
            });
        };

        const reentry = (target: PlaceNode): void => {
            if (def.type !== ModelType.workflow) {
                throw new Error("reentry only supported for workflow models");
            }
            arcs.push({
                metaType: "arc",
                offset: arcs.length,
                source: {transition: transition},
                target: {place: target.place},
                weight: 0,
                reentry: true,
            });
            transition.allowReentry = true;
        };

        function guard(weight: number, target: PlaceNode) {
            if (def.type === ModelType.elementary && weight !== 1) {
                throw new Error(`elementary models only support weight 1, got ${weight}`);
            }
            arcs.push({
                metaType: "arc",
                offset: arcs.length,
                source: {transition},
                target: {place: target.place},
                weight: weight,
                inhibit: true,
                inverted: true
            });
        }

        return {nodeType: "transition", transition, tx, guard, reentry};
    }

    function cell(label: string, initial?: number, capacity?: number, position?: Position): PlaceNode {
        const place: Place = {
            metaType: "place",
            label: label,
            initial: initial || 0,
            capacity: capacity || 0,
            position: position || {x: 0, y: 0, z: 0},
            offset: def.places.size,
        };
        def.places.set(label, place);

        function tx(weight: number, target: TxNode): void {
            if (def.type === ModelType.elementary && weight !== 1) {
                throw new Error(`elementary models only support weight 1, got ${weight}`);
            }
            arcs.push({
                metaType: "arc",
                offset: arcs.length,
                source: {place: place},
                target: {transition: target.transition},
                weight: weight,
            });
        }

        function guard(weight: number, target: TxNode) {
            if (def.type === ModelType.elementary && weight !== 1) {
                throw new Error(`elementary models only support weight 1, got ${weight}`);
            }
            arcs.push({
                metaType: "arc",
                offset: arcs.length,
                source: {place},
                target: {transition: target.transition},
                weight: weight,
                inhibit: true,
                inverted: false
            });
        }

        return {nodeType: "place", place, tx, guard};
    }

    function role(label: string): RoleDef {
        const r: RoleDef = {label};
        if (!def.roles.get(label)) {
            def.roles.set(label, r);
        }
        return r;
    }

    function emptyVector(): Vector {
        const v: Vector = [];
        def.places.forEach((p) => {
            v[p.offset] = 0;
        });
        return v;
    }

    function initialVector(): Vector {
        const v: Vector = [];
        let initialCount = 0;
        def.places.forEach((p) => {
            if (def.type === ModelType.elementary && p.initial > 1) {
                throw new Error("Initial values must be 0 or 1");
            }
            if (p.initial > 0) {
                initialCount++;
            }
            v[p.offset] = p.initial;
        });

        if (def.type === ModelType.elementary && initialCount > 1) {
            throw new Error("Elementary models can only have one initial token");
        }
        return v;
    }

    function capacityVector(): Vector {
        const v: Vector = [];
        def.places.forEach((p) => {
            if (def.type === ModelType.elementary && p.capacity > 1) {
                throw new Error("Elementary models can only have arcs of weight 1");
            }
            v[p.offset] = p.capacity;
        });
        return v;
    }

    /**
     * Build vector index for transitions using defined arcs
     */
    function indexArcs(): boolean {
        for (const label in def.transitions) {
            const t = def.transitions.get(label);
            if (!t) {
                throw new Error(`missing transition: ${label}`);
            }
            t.delta = emptyVector(); // right size all deltas
        }
        let ok = true;
        arcs.forEach((arc) => {
            if (arc.reentry) {
                if (def.type !== ModelType.workflow) {
                    throw new Error("reentry only supported for workflow models");
                }
                return;
            }
            if (def.type === ModelType.elementary && (arc.weight > 1 || arc.weight < -1)) {
                throw new Error("Elementary models can only have arcs of weight 1");
            }
            if (arc.inhibit) {
                const place = arc.inverted ? arc.target.place : arc.source.place;
                const transition = arc.inverted ? arc.source.transition : arc.target.transition;
                const g: Guard = {
                    // @ts-ignore
                    label: place.label,
                    delta: emptyVector(),
                    inverted: !!arc.inverted,
                };
                // @ts-ignore
                g.delta[place.offset] = 0 - arc.weight;
                // @ts-ignore
                transition.guards.set(place.label, g);
            } else if (arc.source.transition && arc.target.place) {
                arc.source.transition.delta[arc.target.place.offset] = arc.weight;
            } else if (arc.target.transition && arc.source.place) {
                arc.target.transition.delta[arc.source.place.offset] = 0 - arc.weight;
            } else {
                ok = false;
            }

        });
        return ok;
    }

    function vectorAdd(state: Vector, delta: Vector, multiple: number): {
        out: Vector; ok: boolean; overflow: boolean; underflow: boolean;
    } {
        let overflow = false;
        let underflow = false;
        const cap = capacityVector();
        const out: Vector = [];
        let ok = true;
        for (const i in state) {
            out[i] = (state[i] + (delta[i] || 0) * multiple);
            if (out[i] < 0) {
                underflow = true;
                ok = false; // underflow: contains negative
            } else if (cap[i] > 0 && cap[i] - out[i] < 0) {
                overflow = true;
                ok = false; // overflow: exceeds capacity
            }
        }
        return {out, ok, overflow, underflow};
    }

    function guardFails(state: Vector, action: string, multiple: number) {
        const t = def.transitions.get(action);
        if (t && t.guards) {
            // @ts-ignore
            for (const [, guard] of t.guards.entries()) {
                const res = vectorAdd(state, guard.delta, multiple);
                if (!guard.inverted && res.ok) {
                    return true; // inhibitor active
                }
                if (guard.inverted && !res.ok) {
                    return true; // inverted inhibitor active
                }
            }
        } else {
            throw new Error("action not found");
        }
        return false; // inhibitor inactive
    }

    function testFire(state: Vector, action: string, multiple: number): Result {
        const t = def.transitions.get(action);
        const inhibited = guardFails(state, action, multiple);
        if (!t || inhibited) {
            return {out: [], ok: false, role: t?.role?.label || "unknown", inhibited};
        }
        const {out, ok, underflow, overflow} = vectorAdd(state, t.delta, multiple);
        return {out, ok, role: t.role.label, inhibited, overflow, underflow};
    }

    function elementaryFire(state: Vector, action: string, multiple: number): Result {
        const res = testFire(state, action, multiple);
        if (!res.ok) {
            return res;
        }
        let elementaryOutputs = 0;
        let failsHardCap = false;
        for (const i in res.out) {
            if (res.out[i] > 1) {
                failsHardCap = true;
            }
            if (res.out[i] > 0) {
                elementaryOutputs++;
            }
        }
        return {...res, ok: !failsHardCap && elementaryOutputs < 2, overflow: failsHardCap};
    }

    function workflowFire(state: Vector, action: string, multiple: number): Result {
        const res = testFire(state, action, multiple);
        let wfOutputs = 0;
        let overflowOutputs = 0;
        const wfOut = emptyVector();
        const t = def.transitions.get(action);
        if (!t) {
            throw new Error("action not found");
        }

        if (res.inhibited) {
            return res;
        }

        for (const i in res.out) {
            if (res.out[i] > 1) {
                wfOut[i] = 1; // correct for overflow
                overflowOutputs++;
            }
            if (res.out[i] > 0) {
                wfOutputs++;
                wfOut[i] = 1;
            }
            if (res.out[i] < 0) {
                wfOut[i] = 0; // correct for underflow
                res.underflow = false;
            }
        }
        if (wfOutputs == 0) {
            res.ok = true;
        } else if (wfOutputs == 1) {
            if (overflowOutputs == 1) {
                if (t.allowReentry) {
                    res.ok = true;
                    res.overflow = false;
                }
            } else if (overflowOutputs == 0) {
                res.ok = true;
            }
        } else if (wfOutputs > 1) {
            res.ok = false;
        }
        return {...res, out: wfOut};
    }

    function fire(state: Vector, action: string, multiple: number, resolve?: (res: Result) => void, reject?: (res: Result) => void): Result {
        let res: Result;
        switch (def.type) {
            case ModelType.petriNet:
                res = testFire(state, action, multiple);
                break;
            case ModelType.elementary:
                res = elementaryFire(state, action, multiple);
                break;
            case ModelType.workflow:
                res = workflowFire(state, action, multiple);
                break;
            default:
                throw new Error("unknown model type");
        }
        if (res.ok) {
            for (const i in res.out) {
                state[i] = res.out[i];
            }
            if (resolve) {
                resolve(res);
            }
        }
        if (!res.ok && reject) {
            reject(res);
        }
        return res;
    }

    function getSize() {
        let limitX = 0;
        let limitY = 0;

        def.places.forEach((p) => {
            if (limitX < p.position.x) {
                limitX = p.position.x;
            }
            if (limitY < p.position.y) {
                limitY = p.position.y;
            }
        });
        def.transitions.forEach((t) => {
            if (limitX < t.position.x) {
                limitX = t.position.x;
            }
            if (limitY < t.position.y) {
                limitY = t.position.y;
            }
        });
        const margin = 60;
        return {width: limitX + margin, height: limitY + margin};
    }

    // Allow OR behavior for optional model paths
    // this allows for workflow models
    function pushState(state: Vector, action: string, multiple: number): Result {
        const res = testFire(state, action, multiple);
        const out = emptyVector();
        let outStates = 0;

        for (const i in res.out) {
            if (res.out[i] > 0) {
                outStates++;
            }
            if (res.out[i] < 0) {
                out[i] = 0; // ignore negative values
            }
            out[i] = res.out[i];
        }
        if (outStates <= 1) {
            res.ok = true;
        }
        return {out, ok: res.ok, role: res.role, inhibited: res.inhibited};
    }

    function getPlace(label: string | number): Place {
        if (typeof label === "number") {
            // @ts-ignore
            for (const [, p] of def.places) {
                if (p.offset === label) {
                    return p;
                }
            }
        }
        if (typeof label === "string") {
            // find place by label
            const p = def.places.get(label);
            if (p) {
                return p;
            }
        }
        throw new Error("invalid place label");
    }

    function renamePlace(oldLabel: string, newLabel: string): void {
        const p = def.places.get(oldLabel);
        if (!p) {
            throw new Error("invalid place label");
        }
        p.label = newLabel;
        def.places.delete(oldLabel);
        def.places.set(newLabel, p);
        def.transitions.forEach((t) => {
            const g = t.guards.get(oldLabel);
            if (g) {
                g.label = newLabel;
                t.guards.delete(oldLabel);
                t.guards.set(newLabel, g);
            }
        });
    }

    function renameTransition(oldLabel: string, newLabel: string): void {
        const t = def.transitions.get(oldLabel);
        if (!t) {
            throw new Error("invalid transition label");
        }
        t.label = newLabel;
        def.transitions.delete(oldLabel);
        def.transitions.set(newLabel, t);
    }

    function deleteTransition(id: string): void {
        def.transitions.delete(id);
        def.arcs = def.arcs.filter((a) => {
            return a.source?.transition?.label !== id && a.target?.transition?.label !== id;
        });
        def.arcs.forEach((a, i) => a.offset = i);
    }

    function deletePlace(id: string): void {
        const p = getPlace(id);
        def.places.delete(id);
        def.transitions.forEach((t) => {
            delete t.delta[p.offset];
            t.delta.forEach((k: number, v: number) => {
                if (k > p.offset) {
                    t.delta[k - 1] = v;
                    delete t.delta[k];
                }
            });
            t.guards.delete(p.label);
        });
        def.arcs = def.arcs.filter((a) => {
            return a.source?.place?.label !== id && a.target?.place?.label !== id;
        });
    }

    function swapArc(id: number): void {
        const arc = def.arcs[id];
        const place = arc.source?.place || arc.target?.place;
        const transition = arc.source?.transition || arc.target?.transition;

        if (arc.inhibit) {
            // @ts-ignore
            const g = transition.guards.get(place.label);
            if (g) {
                g.inverted = !g.inverted;
            }
        } else {
            // @ts-ignore
            transition.delta[place.offset] = 0 - transition.delta[place.offset];
        }

        if (arc.source?.place) {
            arc.source = {transition};
            arc.target = {place};
        } else {
            arc.source = {place};
            arc.target = {transition};
        }
    }

    function deleteArc(id: number): void {
        const arc = def.arcs[id];
        const source = arc.source?.place || arc.source?.transition;
        const target = arc.target?.place || arc.target?.transition;
        if (!source || !target) {
            throw new Error("arc has no source or target: " + id);
        }

        if (source.metaType === "place" && target.metaType === "transition") {
            const place = source as mm.Place;
            const transition = target as mm.Transition;
            transition.delta[place.offset] = 0;
            target.guards.delete(place.label);
        }
        if (source.metaType === "transition" && target.metaType === "place") {
            const place = target as mm.Place;
            const transition = source as mm.Transition;
            transition.delta[place.offset] = 0;
            source.guards.delete(place.label);
        }
        def.arcs.splice(arc.offset, 1);
        def.arcs.forEach((a, i) => a.offset = i);
        // this.m.indexArcs();
    }

    function toggleInhibitor(id: number): boolean {
        const arc = def.arcs[id];
        arc.inhibit = !arc.inhibit;
        const place = arc.source?.place || arc.target?.place;
        const transition = arc.source?.transition || arc.target?.transition;
        if (!place || !transition) {
            throw new Error("arc has no source or target: " + id);
        }
        if (arc.inhibit) { // became inhibitor
            const g = {
                label: place.label,
                delta: emptyVector(),
                inverted: !!arc.target?.place,
                inhibit: true,
            };
            g.delta[place.offset] = 0 - arc.weight;
            transition.guards.set(place.label, g);
            transition.delta[place.offset] = 0;
        } else { // was inhibitor
            transition.guards.delete(place.label);
            if (arc.target?.place) {
                transition.delta[place.offset] = arc.weight;
            } else if (arc.source?.place) {
                transition.delta[place.offset] = 0 - arc.weight;
            } else {
                throw new Error("arc has no source or target: " + id);
            }
        }
        return true;
    }

    function exportObjectFull(): Record<string, any> {
        let places = {};
        let transitions = {};
        const arcs: any = [];
        def.places.forEach((p) => {
            places = {...places, [p.label]: {...p}};
        });
        def.transitions.forEach((t) => {
            let guards = {};
            t.guards.forEach((g, k) => {
                guards = {...guards, [k]: {...g}};
            });
            const {role, position, metaType} = t;
            if (t.role.label !== "default") {
                transitions = {...transitions, [t.label]: {metaType, role, ...position, guards}};
            } else {
                transitions = {...transitions, [t.label]: {metaType, role, ...position}};
            }
        });
        def.arcs.forEach((a) => {
            const {
                source,
                target,
                weight,
                inhibit,
                offset,
                reentry
            } = a;
            let rec: any = {
                metaType: "arc",
                offset,
                weight,
                inhibit,
                reentry
            };
            if (a.source.place) {
                // @ts-ignore
                rec = {...rec, source: source.place.label, target: target.transition.label};
            } else {
                // @ts-ignore
                rec = {...rec, source: source.transition.label, target: target.place.label};
            }
            arcs.push(rec);
        });

        return {
            modelType: def.type,
            version,
            places,
            transitions,
            arcs
        };
    }

    function exportDeclarationObject(): ModelDeclaration {
        let places = {};
        let transitions = {};
        const arcs: any[] = [];
        def.places.forEach((p: Place) => {
            const {label, initial, capacity, offset, position} = p;
            let pl: any = {offset, ...position};
            if (initial) {
                pl = {...pl, initial};
            }
            if (capacity) {
                pl = {...pl, capacity};
            }
            places = {...places, [label]: pl};
        });
        def.transitions.forEach((t: Transition) => {
            const {label, position} = t;
            let guards = {};
            t.guards.forEach((g, k) => {
                const {delta} = g;
                guards = {...guards, [k]: delta};
            });
            const role = t.role.label;
            if (t.role.label !== "default") {
                transitions = {...transitions, [label]: {role, ...position}};
            } else {
                transitions = {...transitions, [label]: {...position}};
            }
        });
        def.arcs.forEach((a: Arc) => {
            let rec: any = {
                source: a.source?.transition?.label || a.source?.place?.label,
                target: a.target?.transition?.label || a.target?.place?.label,
                weight: Math.abs(a.weight)
            };
            if (a.inhibit) {
                rec = {...rec, inhibit: true};
            }
            if (a.reentry) {
                rec = {...rec, reentry: true};
            }
            arcs.push(rec);
        });
        return {
            modelType: def.type,
            version,
            places,
            transitions,
            arcs
        };
    }

    function toObject(mode?: "sparse" | "full"): any {
        if (mode === "full") {
            return exportObjectFull();
        }
        return exportDeclarationObject();
    }

    function placeSeq(): string {
        let x = 0;
        while (def.places.get("place" + x)) {
            x++;
        }
        return "place" + x;
    }

    function transitionSeq() {
        let x = 0;
        while (def.transitions.get("txn" + x)) {
            x++;
        }
        return "txn" + x;
    }

    function addPlace(coords: { x: number; y: number }): boolean {
        const newOffset = def.places.size;
        const label = placeSeq();
        def.places.set(label, {
            metaType: "place",
            label: label,
            initial: 0,
            capacity: 0,
            offset: newOffset,
            position: {x: coords.x, y: coords.y}
        });
        def.transitions.forEach((t: Transition) => {
            t.delta[newOffset] = 0;
        });
        return true;
    }

    function addTransition(coords: { x: number; y: number }): boolean {
        const oid = transitionSeq();
        def.transitions.set(oid, {
            metaType: "transition",
            label: oid,
            role: {label: "default"},
            delta: emptyVector(),
            position: {x: coords.x, y: coords.y},
            guards: new Map<string, mm.Guard>(),
            allowReentry: false,
        });
        return true;
    }

    function objectExists(id: string): boolean {
        return !!def.places.get(id) || !!def.transitions.get(id);
    }

    function getObject(id: string): Place | Transition {
        // @ts-ignore
        return def.places.get(id) || def.transitions.get(id);
    }

    function newLabel(label: string, suffix?: number): string {
        if (suffix) {
            label = label + suffix;
        }
        if (!objectExists(label)) {
            return label;
        } else {
            // if last char is a number, increment it
            // REVIEW: consider supporting multi-digit numbers
            const lastChar = label.slice(-1);
            if (lastChar >= "0" && lastChar <= "9") {
                const newSuffix = parseInt(lastChar) + 1;
                return newLabel(label.slice(0, -1), newSuffix);
            } else {
                return newLabel(label, 1);
            }
        }
    }

    function setArcWeight(offset: number, weight: number): boolean {
        const arc = def.arcs[offset];
        if (!arc) {
            throw new Error("missing arc.offset:" + offset);
        }
        if (weight <= 0) {
            return false;
        }
        arc.weight = weight;
        const place = arc.source?.place || arc.target?.place;
        const transition = arc.source?.transition || arc.target?.transition;
        if (!place || !transition) {
            throw new Error("invalid arc");
        }
        if (arc.inhibit) {
            const g = transition.guards.get(place.label);
            if (g) {
                g.delta[place.offset] = 0 - arc.weight;
            } else {
                throw new Error("invalid arc");
            }
        } else {
            if (arc.target?.place) {
                transition.delta[place.offset] = arc.weight;
            } else if (arc.source?.place) {
                transition.delta[place.offset] = 0 - arc.weight;
            } else {
                throw new Error("invalid arc");
            }
        }
        return true;
    }

    function loadDeclarationObject(obj: ModelDeclaration) {
        if (obj.version !== version) {
            throw new Error("invalid model version: " + obj.version);
        }
        const nodes = new Map<string, PlaceNode | TxNode>();
        const placeList = [];
        for (const label in obj.places) {
            const {
                initial,
                offset,
                capacity,
                x,
                y
            } = obj.places[label];
            placeList.push({label, offset, initial: initial || 0, capacity: capacity || 0, x, y});
        }
        placeList.sort((a, b) => a.offset - b.offset);
        for (const {label, initial, capacity, x, y} of placeList) {
            nodes.set(label, cell(label, initial, capacity, {x, y}));
        }
        for (const label in obj.transitions) {
            const {x, y, role} = obj.transitions[label];
            nodes.set(label, fn(label, {label: role || "default"}, {x, y}));
        }
        for (const arc of obj.arcs) {
            const {source, target, weight, inhibit, reentry} = arc;
            const sourceObj = nodes.get(source);
            const targetObj = nodes.get(target);
            if (!sourceObj) {
                throw new Error("invalid arc source: " + source);
            }
            if (!targetObj) {
                throw new Error("invalid arc target: " + target);
            }
            if (sourceObj.nodeType === "place") {
                if (targetObj.nodeType !== "transition") {
                    throw new Error("invalid arc target: " + target);
                }
                if (inhibit) {
                    sourceObj.guard(weight || 1, targetObj);
                } else {
                    sourceObj.tx(weight || 1, targetObj);
                }
                if (reentry) {
                    throw new Error("reentry must use transition->place arc");
                }
            } else if (sourceObj.nodeType === "transition") {
                if (targetObj.nodeType !== "place") {
                    throw new Error("invalid arc");
                }
                if (inhibit) {
                    sourceObj.guard(weight || 1, targetObj);
                } else {
                    sourceObj.tx(weight || 1, targetObj);
                }
                if (reentry) {
                    sourceObj.reentry(targetObj);
                }
            }
        }

    }

    if (declaration) {
        if (typeof declaration === "function") {
            declaration({fn, cell, role});
        } else {
            loadDeclarationObject(declaration);
        }
        if (!indexArcs()) {
            throw new Error("invalid declaration");
        }
    }

    return {
        addPlace,
        addTransition,
        capacityVector,
        def,
        swapArc,
        deleteArc,
        deletePlace,
        deleteTransition,
        emptyVector,
        fire,
        getObject,
        getPlace,
        getSize,
        guardFails,
        initialVector,
        newLabel,
        objectExists,
        pushState,
        renamePlace,
        renameTransition,
        setArcWeight,
        toObject,
        toggleInhibitor,
        transitionSeq,
    };
}
