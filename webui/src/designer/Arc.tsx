import React from 'react';
import {MetaModel} from "../pflow";
import * as mm from "../protocol";

interface ArcProps {
    id: string;
    metaModel: MetaModel;
    arc: mm.Arc;
}

/**
 * Arcs connect places and transition
 * providing either a conduit to transfer tokens
 * Or act as an inhibitor to prevent actions if a token threshold is breached
 */
export default function Arc(props: ArcProps) {
    const {
        metaModel,
        arc,
    } = props;
    const source = arc.source.place || arc.source.transition;
    const target = arc.target.place || arc.target.transition;

    if (!source || !target) {
        return <React.Fragment key={props.id}/>;
    }

    function positions() {
        if (!source || !target) {
            throw new Error("Arc has no source or target");
        }
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

        return {
            x1, y1, x2, y2, midX, midY, offsetX, offsetY
        }
    }

    async function onClick(evt: React.MouseEvent<SVGCircleElement, MouseEvent>) {
        evt.stopPropagation();
        evt.preventDefault();
        await metaModel.arcClick(arc.offset);
    }

    async function onContextMenu(evt: React.MouseEvent<SVGCircleElement, MouseEvent>): Promise<void> {
        evt.stopPropagation();
        evt.preventDefault();
        return metaModel.arcAltClick(arc.offset);
    }

    function getMarker() {
        if (arc.inhibit) {
            return 'url(#markerInhibit1)';
        } else {
            return 'url(#markerArrow1)';
        }
    }

    function stroke() {
        return '#000000';
    }

    const {
        x1, y1, x2, y2, midX, midY, offsetX, offsetY
    } = positions();

    let weight = "  ";

    if (metaModel.m.def.type === "petriNet") {
        weight = `${Math.abs(arc.weight)}`
    }

    return (
        <g onContextMenu={onContextMenu}>
            <line
                stroke={stroke()}
                strokeWidth={1}
                markerEnd={getMarker()}
                id={props.id}
                x1={x1} y1={y1}
                x2={x2} y2={y2}
            />
            <text id={props.id + '[label]'} x={midX - offsetX} y={midY + offsetY}>{weight}</text>
            <circle id={props.id + '[handle]'}
                    r={13} cx={midX} cy={midY} fill="transparent" stroke="transparent"
                    onClick={onClick}
            />
        </g>
    );
};