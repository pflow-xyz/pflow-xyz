import React from "react";
import CodeEditor from "@uiw/react-textarea-code-editor";
import {MetaModel} from "../pflow";
import * as mm from "../protocol";

interface SouceViewProps {
    metaModel: MetaModel;
}

export default function Source(props: SouceViewProps) {
    const {metaModel} = props;

    const update = async (updatedSource: string) => {
        if (metaModel.isEditing()) {
            metaModel.urlLoaded.then(() => {
                try {
                    const declaration = JSON.parse(updatedSource);
                    if (declaration && updatedSource !== metaModel.toSource()) {
                        metaModel.m = mm.newModel({declaration},);
                        metaModel.restartStream(false)
                        metaModel.commit({action: "editor updated"});
                    } else {
                        metaModel.update();
                    }
                } catch (err) {
                    console.error(err)
                    metaModel.update();
                }
            });
        }

    }

    return <React.Fragment>
        <CodeEditor
            id="pflow-code-editor"
            value={metaModel.toJson()}
            data-color-mode="light"
            language="js"
            placeholder="model.json"
            padding={15}
            style={{
                minHeight: "24em",
                fontSize: 12,
                backgroundColor: "#FFFFFF",
                border: "1px solid #E0E0E0",
                fontFamily: "ui-monospace,SFMono-Regular,SF Mono,Consolas,Liberation Mono,Menlo,monospace",
            }}
            onFocus={() => metaModel.beginEdit()}
            onBlur={async (evt) => {
                await update(evt.target.value)
                metaModel.endEdit()
            }}
        />
    </React.Fragment>;
}
