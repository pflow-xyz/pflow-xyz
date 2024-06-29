import {MetaModel} from "../lib/pflow";
import React from "react";
import Model from "./designer/Model";
import {ModelDeclaration} from "../lib/protocol";

type ModelProps = {
    width: number;
    height: number;
    modelJson: string | object;
    elevation?: number;
    title?: string;
    description?: string;
    transform?: string;
}

export default function SuperModel(props: ModelProps) {
    const modelJson = props.modelJson as ModelDeclaration;

    return (
        <DemoModel
            width={props.width}
            height={props.height}
            transform={props.transform}
            modelJson={modelJson}/>
    )
}

type DemoModelProps = {
    width: number;
    height: number;
    modelJson: object | string;
    schema?: string;
    transform?: string;
}

function DemoModel(props: DemoModelProps): React.ReactElement {

    const metaModel = new MetaModel({
        editor: false,
        superModel: true,
    })
    metaModel.loadJson(props.modelJson);
    metaModel.restartStream(false)

    const dark = "#1c1c1d";
    const stroke = "#EBFF00";
    const yellow = "#EBFF00";
    return (<React.Fragment>
            <svg width={props.width} height={props.height}>
                <defs>
                    <marker id="markerArrow1" markerWidth="23" markerHeight="13" refX="31" refY="6" orient="auto">
                        <rect className="arrowSpace1" width="28" height="3" fill={dark} stroke={dark} x="3"
                              y="5"/>
                        <path d="M2,2 L2,11 L10,6 L2,2" fill={dark} stroke={yellow}/>
                    </marker>
                    <marker id="markerInhibit1" markerWidth="23" markerHeight="13" refX="31" refY="6" orient="auto">
                        <rect className="inhibitSpace1" width="28" height="3" fill={dark} stroke={dark} x="3"
                              y="5"/>
                        <circle cx="5" cy="6.5" r={4} fill={dark} stroke={stroke}/>
                    </marker>
                </defs>
                <g transform={props.transform}>
                    <Model metaModel={metaModel} schema={props.schema}/>
                </g>
            </svg>
        </React.Fragment>
    )
}
