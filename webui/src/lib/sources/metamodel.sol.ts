export const Declaration = `
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
`

export const Model = `
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

}`

export const ModelInterface = `
interface ModelInterface {
    function model() external returns (Model.PetriNet memory);

    function declaration() external returns (Declaration.PetriNet memory);

    function dryRun(uint8 action, uint256 scalar) external;

    function signal(uint8 action, uint256 scalar) external;

    function signalMany(uint8[] calldata actions, uint256[] calldata scalars) external;
}
`

export const PflowDSLConstructor = `
abstract contract PflowDSL {
... `;
export const PflowDSLPlace = `
    function placeNode(string memory label, uint8 offset) internal pure returns (Model.Node memory)
`;

export const PflowDSLTransition = `
    function transitionNode(string memory label, uint8 offset) internal pure returns (Model.Node memory)
`;

export const PflowDSLCell = `
    function cell(string memory label, uint256 initial, uint256 capacity, Model.Position memory position) internal returns (Model.Place memory)
`;

export const PflowDSLFunc = `
    function func(string memory label, uint8 vectorSize, uint8 action, uint8 role, Model.Position memory position) internal returns (Model.Transition memory)
`;


export const PflowDSLArrow = `
    function arrow(int256 weight, Model.Place memory p, Model.Transition memory t) internal
    
    function arrow(int256 weight, Model.Transition memory t, Model.Place memory p) internal
`;

export const PflowDSLGuard = `
    function guard(int256 weight, Model.Place memory p, Model.Transition memory t) internal
    
    function guard(int256 weight, Model.Transition memory t, Model.Place memory p) internal`;

export const MetamodelHeader = `
abstract contract Metamodel is PflowDSL, ModelInterface {}
`;

export const Metamodel = `
abstract contract Metamodel is PflowDSL, ModelInterface {

    int256 public sequence = 0;

    // transform is a hook for derived contracts to implement state transitions
    function transform(uint8 i, Model.Transition memory t, uint256 scalar) internal virtual;

    // isInhibited is a hook for derived contracts to implement transition guards
    function isInhibited(Model.Transition memory t) internal view virtual returns (bool);

    // dryRun checks if a transition is inhibited and if the scalar is non-zero
    function dryRun(uint8 action, uint256 scalar) external view {
        Model.Transition memory t = transitions[action];
        assert(scalar != 0);
        assert(!isInhibited(t));
        assert(action == t.offset);
    }

    function _signal(uint8 action, uint256 scalar) internal {
        Model.Transition memory t = transitions[action];
        assert(!isInhibited(t));
        assert(action == t.offset);
        for (uint8 i = 0; i < uint8(places.length); i++) {
            transform(i, t, scalar);
        }
        sequence++;
        emit Model.SignalEvent(t.role, action, scalar);
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

    // model returns an indexed model of the PetriNet
    function model() external view returns (Model.PetriNet memory) {
        return Model.PetriNet(places, transitions, arcs);
    }

    // declaration returns the model in a format suitable for the frontend
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

}`