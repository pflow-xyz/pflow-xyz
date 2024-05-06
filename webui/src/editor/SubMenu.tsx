import React from "react";
import {IconButton, Tooltip} from "@mui/material";
import {Download, Image, Link, UploadFile} from "@mui/icons-material";
import {downloadPngFromCanvas} from "../pflow/snapshot";
import {FileUploader} from "react-drag-drop-files";
import {downloadModelJson} from "../pflow/export";
import ShareDialog from "./ShareDialog";
import {MetaModel} from "../pflow";

interface SubMenuProps {
    metaModel: MetaModel
}

export default function SubMenu(props: SubMenuProps) {
    const metaModel = props.metaModel;

    const handleFile = async (file: File) => {
        return metaModel.uploadFile(file).then(async () => {
            await metaModel.menuAction("select");
            return metaModel.update();
        })
    };

    async function createPngLink() {
        if (metaModel.mode !== "snapshot") {
            await metaModel.menuAction("snapshot")
        }
        downloadPngFromCanvas()
    }


    const color = "#3143a9";
    return <React.Fragment>
        <FileUploader sx={{color}} handleChange={handleFile} types={["JSON"]}>
            <Tooltip title="import json">
                <IconButton sx={{color}} aria-label="upload json">
                    <UploadFile/>
                </IconButton>
            </Tooltip>
        </FileUploader>
        <select value={metaModel.m.def.type} onChange={async (e) => {
            await metaModel.setModelType(e.target.value as any)
        }}>
            <option value="petriNet">PetriNet</option>
            <option value="workflow">Workflow</option>
            <option value="elementary">Elementary</option>
        </select>
        &nbsp;
        <button style={{border: "none"}} onClick={() => metaModel.revert(metaModel.revision - 1)}>{"<"}</button>
        <button style={{border: "none"}}> rev. {metaModel.revision}</button>
        <button style={{border: "none"}} onClick={() => metaModel.revert(metaModel.revision + 1)}>{">"}</button>
        <Tooltip title="export json">
            <IconButton sx={{color}} aria-label="download json" onClick={
                () => downloadModelJson(metaModel.toJson())
            }><Download/>
            </IconButton>
        </Tooltip>
        <Tooltip title="snapshot png">
            <IconButton sx={{color}} aria-label="snapshot" color="secondary" onClick={
                () => createPngLink()
            }><Image/>
            </IconButton>
        </Tooltip>
        <Tooltip title="permalink">
            <a id="permalink" href={"/p/?z=" + metaModel.zippedJson}>
                <IconButton sx={{color}} aria-label="permalink" color="secondary">
                    <Link/>
                </IconButton>
            </a>
        </Tooltip>
        <Tooltip title={"share in markdown"}>
            <IconButton sx={{color}} aria-label="share" color="secondary">
                <ShareDialog/>
            </IconButton>
        </Tooltip>

    </React.Fragment>;
}