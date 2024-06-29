import {MetaModel} from "../lib/pflow";
import React from "react";
import Model from "./designer/Model";
import {Container, Paper, Typography} from "@mui/material";

type ModelProps = {
    width: number;
    height: number;
    modelJson: string | object;
    elevation?: number;
    title?: string;
    description?: string;
    id?: string;
}

export default function ReadonlyModel(props: ModelProps) {
    // REVIEW: can we get width/height from the model?

    return (<Paper id={props.id} elevation={props.elevation || 0} sx={{
        marginBottom: "5px",
        padding: "20px",
        maxWidth: "900px",
        margin: "auto",
    }}>
        <DemoModel width={props.width} height={props.height} modelJson={props.modelJson}/>
        <Container sx={{
            textAlign: "left",
            padding: "20px",
        }}>
            <Typography variant="h4" gutterBottom>
                {props.title || "DemoModel"}
            </Typography>
            <Typography variant="body1" gutterBottom>
                {props.description || "This is a demo model."}
            </Typography>
        </Container>
    </Paper>)
}

type DemoModelProps = {
    width: number;
    height: number;
    modelJson?: object | string;
    schema?: string;
    metaModel?: MetaModel;
}

export function DemoModel(props: DemoModelProps): React.ReactElement {

    const metaModel = new MetaModel({
        editor: false,
    })
    if (props.modelJson) {
    }

    metaModel.restartStream(true)

    return (<React.Fragment>
            <div style={{
                border: "1px solid #000000",
                alignContent: "center",
                justifyContent: "center",
                display: "flex",
                padding: "10px",
            }}>
                <SvgModel width={props.width} height={props.height} modelJson={props.modelJson}/>
            </div>
        </React.Fragment>
    )
}

export function SvgModel(props: DemoModelProps): React.ReactElement {

    let metaModel = props.metaModel

    if (!metaModel) {
        metaModel = new MetaModel({
            editor: false,
        })
    }
    if (props.modelJson) {
        metaModel.loadJson(props.modelJson)
    }
    metaModel.restartStream(true)

    return (<svg width={props.width} height={props.height}>
        <defs>
            <marker id="markerArrow1" markerWidth="23" markerHeight="13" refX="31" refY="6" orient="auto">
                <rect className="arrowSpace1" width="28" height="3" fill="#ffffff" stroke="#ffffff" x="3"
                      y="5"/>
                <path d="M2,2 L2,11 L10,6 L2,2"/>
            </marker>
            <marker id="markerInhibit1" markerWidth="23" markerHeight="13" refX="31" refY="6" orient="auto">
                <rect className="inhibitSpace1" width="28" height="3" fill="#ffffff" stroke="#ffffff" x="3"
                      y="5"/>
                <circle cx="5" cy="6.5" r={4}/>
            </marker>
        </defs>
        <Model metaModel={metaModel} schema={props.schema}/>
        <rect x="0" y="0" width={props.width} height={props.height} fill="transparent" stroke="trasparent"/>
    </svg>)
}
