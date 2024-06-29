import React from 'react';
import {MetaModel} from "../../lib/pflow";

interface PlaceProps {
    id: string;
    metaModel: MetaModel;
}

interface NodeState {
    modified?: boolean;
    dragging: boolean;
}

// export default class Place extends React.Component<PlaceProps, NodeState> {
export default function Place(props: PlaceProps) {

    const [nodeState, setState] = React.useState<NodeState>({dragging: false})
    const {metaModel} = props;

    function renderTokens(p: { x: number; y: number; }) {
        let tokens = metaModel.getTokenCount(props.id);

        let tokenColor = "#0000007x";

        if (metaModel.isSuper()) {
            tokenColor = "#EBFF00";
        }

        if (tokens === 0) {
            return; // don't show zeros
        }
        if (tokens === 1) {
            return (<circle cx={p.x} cy={p.y} r="2" id={props.id + "_tokens"} fill={tokenColor} stroke={tokenColor}
                            orient="0" className="tokens"/>);
        }
        if (tokens < 10) {
            return (<text id={props.id + "_tokens"} x={p.x - 4} y={p.y + 5} fill={tokenColor} stroke={tokenColor}
                          className="large">{tokens}</text>);
        }
        if (tokens < 100) {
            return (<text id={props.id + "_tokens"} x={p.x - 7} y={p.y + 5} fill={tokenColor} stroke={tokenColor}
                          className="small">{tokens}</text>);
        }
        if (tokens < 1_000) {
            return (<text id={props.id + "_tokens"} x={p.x - 10} y={p.y + 5} fill={tokenColor} stroke={tokenColor}
                          className="small">{tokens}</text>);
        }
        if (tokens < 10_000) {
            return (<text id={props.id + "_tokens"} x={p.x - 14} y={p.y + 5} fill={tokenColor} stroke={tokenColor}
                          className="small">{tokens}</text>);
        }
        return (<g transform="">
            <text id={props.id + "_tokens"} x={p.x - 14} y={p.y + 5}
                  fill={tokenColor} stroke={tokenColor}
                  style={{
                      fontSize: "10px",
                      fontFamily: "Arial",
                  }}>{tokens}</text>
        </g>);
    }

    // Keeps a user from mousing-out of the svg if dragging too quickly
    function getHandleWidth() {
        if (nodeState.dragging) {
            return 1000;
        } else {
            return 36;
        }
    }

    function getStroke() {
        if (metaModel.isSuper()) {
            return "#EBFF00";
        }
        if (metaModel.isSelected(props.id)) {
            return "#8140ff";
        } else {
            return "#000000";
        }
    }

    function startDrag(evt: React.MouseEvent) {
        if (!metaModel.isRunning()) {
            setState({dragging: true});
        }
        evt.stopPropagation();
    }

    async function endDrag(evt: React.MouseEvent) {
        if (nodeState.modified) {
            await metaModel.commit({action: "move place"});
        }
        setState({dragging: false});
        evt.stopPropagation();
    }

    async function dragging(evt: React.MouseEvent) {
        if (nodeState.dragging) {
            setState({dragging: true, modified: true})

            if (['execute', 'delete'].includes(metaModel.mode)) {
                return;
            }

            const obj = metaModel.getObj(props.id);
            if (!obj || obj.metaType !== "place") {
                throw new Error('Place.dragging: invalid obj');
            }
            obj.position.x = obj.position.x + evt.movementX;
            obj.position.y = obj.position.y + evt.movementY;
            metaModel.selectedObject = obj;
            await metaModel.update();
        }
        evt.stopPropagation();
    }

    async function onClick(evt: React.MouseEvent) {
        await metaModel.placeClick(props.id);
        evt.stopPropagation();
    }

    async function onAltClick(evt: React.MouseEvent) {
        await metaModel.placeAltClick(props.id);
        evt.preventDefault();
        evt.stopPropagation();
    }

    let p = {x: 0, y: 0}
    try {
        p = metaModel.getPlace(props.id).position;
    } catch { // REVIEW: likely this only happens during development
        return <g></g>
    }

    let fill = "#FFFFFF";
    if (metaModel.isSuper()) {
        fill = "#1c1c1d";
    }

    function TextLabel() {
        if (metaModel.isSuper()) {
            return <text id={props.id + '[label]'} x={p.x - 18} y={p.y - 20}></text>
        }
        return <text id={props.id + '[label]'} x={p.x - 18} y={p.y - 20}>{props.id}</text>
    }

    return (
        <g
            onMouseDown={(evt) => startDrag(evt)}
            onMouseUp={(evt) => endDrag(evt)}
            onMouseMove={(evt) => dragging(evt)}
            onClick={onClick}
            onContextMenu={onAltClick}>

            <circle id={props.id + '_handle'} cx={p.x} cy={p.y} r={getHandleWidth()} fill="transparent"
                    stroke="transparent"/>
            <circle cx={p.x} cy={p.y} r="16" id={props.id}
                    strokeWidth="1.5" fill={fill} stroke={getStroke()} orient="0"
                    className="place"
                    shapeRendering="auto"
            />
            {renderTokens(p)}
            <TextLabel/>
        </g>
    );
};
