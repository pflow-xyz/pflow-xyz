import {ModelDeclaration} from "../protocol";

const  solidityHeader = `// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

library Model {

    event SignaledEvent(
        uint8 indexed role,
        uint8 indexed actionId,
        uint256 indexed scalar,
        uint256 sequence
    );

    struct PetriNet {
        Place[] places;
        Transition[] transitions;
    }

    struct Position {
        uint8 x;
        uint8 y;
    }

    struct Transition {
        string label;
        uint8 offset;
        Position position;
        uint8 role;
        int256[] delta;
        int256[] guard;
    }

    struct Place {
        string label;
        uint8 offset;
        Position position;
        uint256 initial;
        uint256 capacity;
    }

    struct Head {
        uint256[10] latestBlocks;
        uint256 sequence;
        int256[] state;
        Place[] places;
        Transition[] transitions;
    }

}

interface ModelInterface {
    function context() external returns (Model.Head memory);

    function signal(uint8 action, uint256 scalar) external;

    function signalMany(uint8[] calldata actions, uint256[] calldata scalars) external;
}

abstract contract PflowDSL {
    Model.Place[] internal places;
    Model.Transition[] internal transitions;

    function cell(string memory label, uint256 initial, uint256 capacity, Model.Position memory position) internal returns (Model.Place memory) {
        Model.Place memory p = Model.Place(label, uint8(places.length), position, initial, capacity);
        places.push(p);
        return p;
    }

    function func(string memory label, uint8 vectorSize, uint8 action, uint8 role, Model.Position memory position) internal returns (Model.Transition memory) {
        require(uint8(transitions.length) == action, "transaction => enum mismatch");
        Model.Transition memory t = Model.Transition(label, action, position, role, new int256[](vectorSize), new int256[](vectorSize));
        transitions.push(t);
        return t;
    }

    function arrow(int256 weight, Model.Place memory p, Model.Transition memory t) internal {
        require(weight > 0, "weight must be > 0");
        transitions[t.offset].delta[p.offset] = 0 - weight;
    }

    function arrow(int256 weight, Model.Transition memory t, Model.Place memory p) internal {
        require(weight > 0, "weight must be > 0");
        transitions[t.offset].delta[p.offset] = weight;
    }

    // inhibit transition after threshold weight is reached
    function guard(int256 weight, Model.Place memory p, Model.Transition memory t) internal {
        require(weight > 0, "weight must be > 0");
        transitions[t.offset].guard[p.offset] = 0 - weight;
    }

    // inhibit transition until threshold weight is reached
    function guard(int256 weight, Model.Transition memory t, Model.Place memory p) internal {
        require(weight > 0, "weight must be > 0");
        transitions[t.offset].guard[p.offset] = weight;
    }
}

abstract contract Metamodel is PflowDSL, ModelInterface {

    // sequence is a monotonically increasing counter for each signal
    uint256 public sequence = 0;

    // latestBlocks stores the last 10 block numbers when a signal was received
    uint256[10] public latestBlocks = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    // transform is a hook for derived contracts to implement state transitions
    function transform(uint8 i, Model.Transition memory t, uint256 scalar) internal virtual;

    // isInhibited is a hook for derived contracts to implement transition guards
    function isInhibited(Model.Transition memory t) internal view virtual returns (bool);

    // hasPermission implements an ACL for transitions based on user roles
    function hasPermission(Model.Transition memory t) internal view virtual returns (bool);

    // context returns the current state of the model
    function context() external view virtual returns (Model.Head memory);

    // signal is the main entry point for signaling transitions
    function _signal(uint8 action, uint256 scalar) internal {
        Model.Transition memory t = transitions[action];
        require(!isInhibited(t), "inhibited");
        assert(action == t.offset);
        for (uint8 i = 0; i < uint8(places.length); i++) {
            transform(i, t, scalar);
        }
        sequence++;
        emit Model.SignaledEvent(t.role, action, scalar, sequence);
    }

    function updateBlocks(uint256 blockNumber) internal {
        for (uint8 i = 0; i < 9; i++) {
            latestBlocks[i] = latestBlocks[i + 1];
        }
        latestBlocks[9] = blockNumber;
    }

    function signal(uint8 action, uint256 scalar) external {
        _signal(action, scalar);
        updateBlocks(block.number);
    }

    function signalMany(uint8[] calldata actions, uint256[] calldata scalars) external {
        require(actions.length == scalars.length, "ModelRegistry: invalid input");
        for (uint256 i = 0; i < actions.length; i++) {
            _signal(actions[i], scalars[i]);
        }
        updateBlocks(block.number);
    }

}
`;

const solidityFooter = `contract MyStateMachine is MyModelContract {

    function isInhibited(Model.Transition memory t) internal view override returns (bool) {
        for (uint8 i = 0; i < uint8(Properties.SIZE); i++) {
            if (t.guard[i] != 0) {
                if (t.guard[i] < 0) {
                    // inhibit unless condition is met
                    if ((state[i] + t.guard[i]) >= 0) {
                        return true;
                    }
                } else {
                    // inhibit until condition is met
                    if ((state[i] - t.guard[i]) < 0) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    function hasPermission(Model.Transition memory t) internal view override returns (bool) {
        return t.role < uint8(Roles.HALT);
    }

    function transform(uint8 i, Model.Transition memory t, uint256 scalar) internal override {
        require(scalar > 0, "invalid scalar");
        if (t.delta[i] != 0) {
            state[i] = state[i] + t.delta[i] * int256(scalar);
            require(state[i] >= 0, "underflow");
            if (places[i].capacity > 0) {
                require(state[i] <= int256(places[i].capacity), "overflow");
            }
        }
    }

    function context() external view override returns (Model.Head memory) {
        return Model.Head(latestBlocks, sequence, state, places, transitions);
    }

}`;

const ScaleX = 80;
const ScaleY = 80;
const Margin = 22;

function scaleX(x: number) {
    return Math.floor((x -Margin) / ScaleX);
}

function scaleY(y: number) {
    return Math.floor((y - Margin) / ScaleY);
}

export function jsonToSolidity(json: string) {
    const model = JSON.parse(json) as ModelDeclaration;

    let placeMap = new Map<string, number>();
    let transitionMap = new Map<string, number>();

    let rolesEnum = 'enum Roles {'; // FIXME: roles enum doesn't produce compile-able code
    let propertiesEnum = 'enum Properties {';
    let actionsEnum = 'enum Actions {';

    for (const place in model.places) {
        const p = model.places[place];
        if (p) {
            placeMap.set(place, p.offset);
            propertiesEnum += `${place}, `;
        }
    }

    const roles = new Set<string>();
    const rolesMap = new Map<string, number>();

    for (const transition in model.transitions) {
        const t = model.transitions[transition];
        if (t) {
            transitionMap.set(transition, transitionMap.size);
            if (t.role && !roles.has(t.role)) {
                rolesMap.set(t.role, roles.size);
                roles.add(t.role);
            }
            actionsEnum += `${transition}, `;
        }
    }

    if (roles.size == 0) {
        rolesMap.set('DEFAULT', roles.size);
        roles.add('DEFAULT');
    }

    for (const role of Array.from(roles)) {
        rolesEnum += `${role}, `;
    }

    rolesEnum += 'HALT}';
    propertiesEnum += 'SIZE}';
    actionsEnum += 'HALT}';

    let funcDeclarations = '';
    let cellDeclarations = '';
    let arcDeclarations = '';

    // REVIEW: make sure capacity is set to 0 if not specified
    for (const key in model.places) {
        const place = model.places[key];
        cellDeclarations += `        cell("${key}", ${place.initial || 0}, ${place.capacity || 0}, Model.Position(${scaleX(place.x)}, ${scaleY(place.y)}));\n`;
    }

    for (const key in model.transitions) {
        const t = model.transitions[key];
        funcDeclarations += `        func("${key}", uint8(Properties.SIZE), uint8(${transitionMap.get(key)}), uint8(Roles.${t.role || 'Roles.DEFAULT'}), Model.Position(${scaleX(t.x)}, ${scaleY(t.y)}));\n`;
    }

    for (const key in model.arcs) {
        const arc = model.arcs[key];
        const source = arc.source;
        const target = arc.target;
        const arrowFunc = arc.inhibit ? 'guard' : 'arrow';
        if (source in model.places) {
            arcDeclarations += `        ${arrowFunc}(${arc.weight || 1}, places[${placeMap.get(source)}], transitions[${transitionMap.get(target)}]);\n`;
        } else {
            arcDeclarations += `        ${arrowFunc}(${arc.weight || 1}, transitions[${transitionMap.get(source)}], places[${placeMap.get(target)}]);\n`;
        }
    }

    return `${solidityHeader}\n\nabstract contract MyModelContract is Metamodel {`+
        `\n    ${rolesEnum}`+
        `\n    ${propertiesEnum}`+
        `\n    ${actionsEnum}\n\n`+

        `    int256[] public state = new int256[](uint8(Properties.SIZE));\n\n`+

        `    constructor() {\n`+
        `${cellDeclarations}\n\n`+
        `${funcDeclarations}\n\n`+
        `${arcDeclarations}\n\n`+
        `        for (uint8 i = 0; i < uint8(Properties.SIZE); i++) {\n`+
        `            state[i] = int256(places[i].initial);\n`+
        `        }\n`+
        `    }\n`+
        `}\n\n${solidityFooter}`;
}
