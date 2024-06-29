import {ModelDeclaration} from "../protocol";

const  solidityHeader = `// SPDX-License-Identifier: MIT
pragma solidity >=0.8.0;

library Declaration {

   struct place {
       string label;
       uint8 x;
       uint8 y;
       uint256 initial;
       uint256 capacity;
   }

   struct transition {
       string label;
       uint8 x;
       uint8 y;
       uint8 role;
   }

   struct arc {
       string source;
       string target;
       uint256 weight;
       bool consume;
       bool produce;
       bool inhibit;
       bool read;
   }

   struct PetriNet {
       place[] places;
       transition[] transitions;
       arc[] arcs;
   }

}

library Model {

    event SignaledEvent(
        uint8 indexed role,
        uint8 indexed actionId,
        uint256 indexed scalar
    );

    struct PetriNet {
        Place[] places;
        Transition[] transitions;
        Arc[] arcs;
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

    enum NodeKind {
        PLACE,
        TRANSITION
    }

    struct Node {
        string label;
        uint8 offset;
        NodeKind kind;
    }

    struct Arc {
        uint256 weight;
        Node source;
        Node target;
        bool inhibitor;
        bool read;
    }

}

interface ModelInterface {
    function model() external returns (Model.PetriNet memory);

    function declaration() external returns (Declaration.PetriNet memory);

    function signal(uint8 action, uint256 scalar) external;

    function signalMany(uint8[] calldata actions, uint256[] calldata scalars) external;
}

abstract contract PflowDSL {
    Model.Place[] internal places;
    Model.Transition[] internal transitions;
    Model.Arc[] internal arcs;

    function placeNode(string memory label, uint8 offset) internal pure returns (Model.Node memory) {
        return Model.Node(label, offset, Model.NodeKind.PLACE);
    }

    function transitionNode(string memory label, uint8 offset) internal pure returns (Model.Node memory) {
        return Model.Node(label, offset, Model.NodeKind.TRANSITION);
    }

    function cell(string memory label, uint256 initial, uint256 capacity, Model.Position memory position) internal returns (Model.Place memory) {
        Model.Place memory p = Model.Place(label, uint8(places.length), position, initial, capacity);
        places.push(p);
        return p;
    }

    function func(string memory label, uint8 vectorSize, uint8 action, uint8 role, Model.Position memory position) internal returns (Model.Transition memory) {
        require(uint8(transitions.length) == action, "transactions must be declared in enum order");
        Model.Transition memory t = Model.Transition(label, action, position, role, new int256[](vectorSize), new int256[](vectorSize));
        transitions.push(t);
        return t;
    }

    function arrow(int256 weight, Model.Place memory p, Model.Transition memory t) internal {
        require(weight > 0, "weight must be > 0");
        arcs.push(Model.Arc(uint256(weight), placeNode(p.label, p.offset), transitionNode(t.label, t.offset), false, false));
        transitions[t.offset].delta[p.offset] = 0 - weight;
    }

    function arrow(int256 weight, Model.Transition memory t, Model.Place memory p) internal {
        require(weight > 0, "weight must be > 0");
        arcs.push(Model.Arc(uint256(weight), transitionNode(t.label, t.offset), placeNode(p.label, p.offset), false, false));
        transitions[t.offset].delta[p.offset] = weight;
    }

    // inhibit transition after threshold weight is reached
    function guard(int256 weight, Model.Place memory p, Model.Transition memory t) internal {
        require(weight > 0, "weight must be > 0");
        arcs.push(Model.Arc(uint256(weight), placeNode(p.label, p.offset), transitionNode(t.label, t.offset), true, false));
        transitions[t.offset].guard[p.offset] = 0 - weight;
    }

    // inhibit transition until threshold weight is reached
    function guard(int256 weight, Model.Transition memory t, Model.Place memory p) internal {
        require(weight > 0, "weight must be > 0");
        arcs.push(Model.Arc(uint256(weight), transitionNode(t.label, t.offset), placeNode(p.label, p.offset), true, true));
        transitions[t.offset].guard[p.offset] = weight;
    }
}

abstract contract Metamodel is PflowDSL, ModelInterface {

    // sequence is a monotonically increasing counter for each signal
    int256 public sequence = 0;

    // transform is a hook for derived contracts to implement state transitions
    function transform(uint8 i, Model.Transition memory t, uint256 scalar) internal virtual;

    // isInhibited is a hook for derived contracts to implement transition guards
    function isInhibited(Model.Transition memory t) internal view virtual returns (bool);
    
    // hasPermission implements an ACL for transitions based on user roles
    function hasPermission(Model.Transition memory t) internal view virtual returns (bool);

    function _signal(uint8 action, uint256 scalar) internal {
        Model.Transition memory t = transitions[action];
        assert(!isInhibited(t));
        assert(action == t.offset);
        for (uint8 i = 0; i < uint8(places.length); i++) {
            transform(i, t, scalar);
        }
        sequence++;
        emit Model.SignaledEvent(t.role, action, scalar);
    }

    function signal(uint8 action, uint256 scalar) external {
        _signal(action, scalar);
    }

    function signalMany(uint8[] calldata actions, uint256[] calldata scalars) external {
        require(actions.length == scalars.length, "ModelRegistry: invalid input");
        for (uint256 i = 0; i < actions.length; i++) {
            _signal(actions[i], scalars[i]);
        }
    }

    // model returns the model in a format suited for execution
    function model() external view returns (Model.PetriNet memory) {
        return Model.PetriNet(places, transitions, arcs);
    }

    // declaration returns the model in a format suited for visualization
    function declaration() external view returns (Declaration.PetriNet memory) {
        Declaration.place[] memory p = new Declaration.place[](places.length);
        for (uint8 i = 0; i < uint8(places.length); i++) {
            p[i] = Declaration.place(places[i].label, places[i].position.x, places[i].position.y, places[i].initial, places[i].capacity);
        }
        Declaration.transition[] memory t = new Declaration.transition[](transitions.length);
        for (uint8 i = 0; i < uint8(transitions.length); i++) {
            t[i] = Declaration.transition(transitions[i].label, transitions[i].position.x, transitions[i].position.y, transitions[i].role);
        }
        Declaration.arc[] memory a = new Declaration.arc[](arcs.length);
        for (uint8 i = 0; i < uint8(arcs.length); i++) {
            assert(arcs[i].source.kind != arcs[i].target.kind);
            a[i] = Declaration.arc(
                arcs[i].source.label,
                arcs[i].target.label,
                arcs[i].weight,
                arcs[i].source.kind == Model.NodeKind.PLACE, // consume
                arcs[i].target.kind == Model.NodeKind.PLACE, // produce
                arcs[i].inhibitor,
                arcs[i].read
            );
        }
        return Declaration.PetriNet(p, t, a);
    }

}
`;

const solidityFooter = `abstract contract MyStateMachine is MyModelContract {
    //  REVIEW: store the state of the contract
    int256[] public state = new int256[](uint256(Properties.SIZE));

    function isInhibited(Model.Transition memory t) internal view override returns (bool) {
        for (uint8 i = 0; i < uint8(Properties.SIZE); i++) {
            if (t.guard[i] != 0) {
                if (t.guard[i] < 0) {
                    // inhibit unless condition is met
                    if ((state[i] + t.guard[i]) > 0) {
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
        Roles[] memory roles = getRoles();
        for (uint i = 0; i < roles.length; i++) {
            if (uint8(roles[i]) == uint8(t.role)) {
                return true;
            }
        }
        revert("no permission");
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

    function getRoles() public view returns (Roles[] memory) {
        // customize user roles
        // For now, return a single role in an array
        Roles[] memory roles = new Roles[](1);
        roles[0] = Roles.DEFAULT;
        return roles;
    }
}

contract MyContract is MyStateMachine {

    constructor() {
        for (uint8 i = 0; i < uint8(Properties.SIZE); i++) {
            state[i] = int256(places[i].initial);
        }
    }
    
    function signalWrapperExample() external {
        // NOTE: It may be useful to encapsulate multiple signals
        // in an external function.
        //
        // Or, a wrapper can simply provide users a way to signal transitions
        // without having to know the action id(s).
        _signal(uint8(Actions.HALT), 1);
    }

}`;

const ScaleX = 80;
const ScaleY = 80;
const Margin = 22;

function scaleX(x: number) {
    return Math.floor(x / ScaleX);
}

function scaleY(y: number) {
    return Math.floor(y / (ScaleY - Margin));
}

export function jsonToSolidity(json: string) {
    const model = JSON.parse(json) as ModelDeclaration;

    let placeMap = new Map<string, number>();
    let transitionMap = new Map<string, number>();

    let rolesEnum = 'enum Roles {';
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
        funcDeclarations += `        func("${key}", uint8(Properties.SIZE), uint8(${transitionMap.get(key)}), uint8(${t.role || 0}), Model.Position(${scaleX(t.x)}, ${scaleY(t.y)}));\n`;
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

        `    function _places() internal {\n${cellDeclarations}    }\n\n`+
        `    function _transitions() internal {\n${funcDeclarations}   }\n\n`+
        `    function _arcs() internal {\n${arcDeclarations}   }\n\n`+

        `    constructor() {\n`+
        `        _places();\n`+
        `        _transitions();\n`+
        `        _arcs();\n`+
        `    }\n`+
        `}\n\n${solidityFooter}`;
}
