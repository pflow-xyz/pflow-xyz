import {Model, ModelType, Place, Transition, Vector} from "./model";

const tokenTemplate = ({p, tokens}: { p: Place; tokens: number }) => {
    if (tokens === 0) {
        return; // don't show zeros
    }
    if (tokens === 1) {
        return `<circle cx="${p.position.x}" cy="${p.position.y}" r="2" fill="black" stroke="black" />`;
    }
    if (tokens < 10) {
        return `<text x="${p.position.x - 4}" y="${p.position.y + 5}">${tokens}</text>`;
    }
    if (tokens >= 10) {
        return `<text  x="${p.position.x - 7}" y="${p.position.y + 5}">${tokens}</text>`;
    }
};

interface ArcParams {
    stroke: string;
    markerEnd: string;
    weight: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    midX: number;
    offsetX: number;
    midY: number;
    offsetY: number;
}

const arcTemplate = ({stroke, markerEnd, weight, x1, y1, x2, y2, midX, offsetX, midY, offsetY}: ArcParams) =>
    `<line stroke="${stroke}"  marker-end="${markerEnd}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />` +
    `<text x="${midX - offsetX}" y="${midY + offsetY}" >${weight}</text>`;

const arcTemplateNoLabel = ({stroke, markerEnd, x1, y1, x2, y2}: ArcParams) =>
    `<line stroke="${stroke}"  marker-end="${markerEnd}" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" />`;

const transitionTemplate = ({fill, stroke, t}: { fill: string; stroke: string; t: Transition }) =>
    `<rect width="30" height="30" fill="${fill}" stroke="${stroke}" rx="${4}" x="${t.position.x - 15}" y="${t.position.y - 15}" />` +
    `<text font-size="smaller" x="${t.position.x - 15}" y="${t.position.y - 20}" >${t.label}</text>`;
const placeTemplate = ({p, tokens}: { p: Place; tokens: number }) =>
    `<circle cx="${p.position.x}" cy="${p.position.y}" r="16" fill="white" stroke="black"  />` +
    `${tokenTemplate({p, tokens})}` +
    `<text font-size="smaller" x="${p.position.x - 18}" y="${p.position.y - 20}" >${p.label}</text>`;
const template = ({
                      page,
                      arcTags,
                      placeTags,
                      transitionTags
                  }: {
    page: {
        width: number;
        height: number;
    };
    arcTags: string;
    placeTags: string;
    transitionTags: string;
}) =>
    `<svg width="${page.width}" height="${page.height}" ` +
    "xmlns=\"http://www.w3.org/2000/svg\" >" +
    "<defs><marker id=\"markerArrow1\" markerWidth=\"23\" markerHeight=\"13\" refX=\"31\" refY=\"6\" orient=\"auto\">" +
    "<rect width=\"28\" height=\"3\" fill=\"white\" stroke=\"white\" x=\"3\" y=\"5\"/><path d=\"M2,2 L2,11 L10,6 L2,2\"/></marker>" +
    "<marker id=\"markerInhibit1\" markerWidth=\"23\" markerHeight=\"13\" refX=\"31\" refY=\"6\" orient=\"auto\">" +
    "<rect width=\"28\" height=\"3\" fill=\"white\" stroke=\"white\" x=\"3\" y=\"5\"/><circle cx=\"5\" cy=\"6.5\" r=\"4\"/></marker></defs>" +
    `${arcTags} ${placeTags} ${transitionTags}</svg>`;

function getArcPoints(
    {source, target}: {
        source: {
            position: { x: number; y: number };
        };
        target: {
            position: { x: number; y: number };
        };
    }) {
    const x1 = source.position.x;
    const y1 = source.position.y;
    const x2 = target.position.x;
    const y2 = target.position.y;

    const midX = (x2 + x1) / 2;
    const midY = (y2 + y1) / 2 - 8;
    let offsetX = 4;
    let offsetY = 4;

    if (Math.abs(x2 - midX) < 8) {
        offsetX = 8;
    }

    if (Math.abs(y2 - midY) < 8) {
        offsetY = 0;
    }
    return {offsetX, offsetY, x1, y1, x2, y2, midX, midY};
}

type HashChar = "#" | "%32";

export function snapshot(model: Model, options?: { state?: Vector; hashChar?: HashChar }) {
    const state = options?.state ?? model.initialVector();
    const hashChar = options?.hashChar ? options.hashChar : "#"; // use "%32" for data URI
    const {transitions, places} = model.def;
    const page = model.getSize(); // FIXME: port from other repo
    let transitionTags = "";
    transitions.forEach((t) => {
        function getFill() {
            const res = model.fire([...state], t.label, 1);
            if (res.ok) {
                return "#62fa75";
            }
            if (res.inhibited) {
                return "#fab5b0";
            }
            return "#ffffff";
        }

        transitionTags += transitionTemplate({
            fill: getFill(), // "white", // TODO: colorize model
            stroke: "black",
            t,
        });
    });
    const placeIndex: Array<Place> = [];
    let placeTags = "";
    places.forEach((p) => {
        placeTags += placeTemplate({p: p, tokens: state ? state[p.offset] : p.initial});
        placeIndex[p.offset] = p;
    });
    let arcTags = "";

    function makeArc(params: ArcParams) {
        if (model.def.type !== ModelType.petriNet) {
            return arcTemplateNoLabel(params);
        } else {
            return arcTemplate(params);
        }
    }

    transitions.forEach((t) => {
        t.guards.forEach((v, k) => {
            const place = places.get(k);
            if (v.inverted) {
                // @ts-ignore
                const pts = getArcPoints({source: t, target: place});
                arcTags += makeArc({
                    ...pts,
                    stroke: "black",
                    markerEnd: `url(${hashChar}markerInhibit1)`,
                    // @ts-ignore
                    weight: Math.abs(v.delta[place.offset])
                });
            } else {
                // @ts-ignore
                const pts = getArcPoints({source: place, target: t});
                arcTags += makeArc({
                    ...pts,
                    stroke: "black",
                    markerEnd: `url(${hashChar}markerInhibit1)`,
                    // @ts-ignore
                    weight: Math.abs(v.delta[place.offset])
                });
            }
        });
    });
    transitions.forEach((t) => {
        for (const i in t.delta) {
            const v = t.delta[i];
            if (v > 0) {
                const pts = getArcPoints({source: t, target: placeIndex[i]});
                arcTags += makeArc({
                    ...pts,
                    stroke: "black",
                    markerEnd: `url(${hashChar}markerArrow1)`,
                    weight: v,
                });
            } else if (v < 0) {
                const pts = getArcPoints({target: t, source: placeIndex[i]});
                arcTags += makeArc({
                    ...pts,
                    stroke: "black",
                    markerEnd: `url(${hashChar}markerArrow1)`,
                    weight: 0 - v,
                });
            }
        }
    });

    return template({
        page,
        placeTags,
        arcTags,
        transitionTags,
    });
}