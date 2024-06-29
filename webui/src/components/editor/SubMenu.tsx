import React, {Fragment} from "react";
import {IconButton, Tooltip} from "@mui/material";
import {Download, Image, Link, UploadFile} from "@mui/icons-material";
import {downloadPngFromCanvas} from "../../lib/pflow/snapshot";
import {FileUploader} from "react-drag-drop-files";
import {downloadModelJson} from "../../lib/pflow/export";
import ShareDialog from "./ShareDialog";
import {MetaModel} from "../../lib/pflow";
import {supportsShareButton} from "../../lib/pflow/config";
import SolidityDialog from "./SolidityDialog";

interface SubMenuProps {
    metaModel: MetaModel
}

type shareButtonProps = {
    metaModel: MetaModel
    color: string
}


function ShareButton(props: shareButtonProps) {

    if (!supportsShareButton()) {
        return <Fragment/>
    }

    return (
        <Fragment>
            <Tooltip title={"share image & link as markdown"}>
                <IconButton sx={{color: props.color}} aria-label="share">
                    <ShareDialog metaModel={props.metaModel}/>
                </IconButton>
            </Tooltip>
            <Tooltip title={"convert model to solidity"}>
                <IconButton sx={{color: props.color}} aria-label="share">
                    <SolidityDialog metaModel={props.metaModel}/>
                </IconButton>
            </Tooltip>
        </Fragment>
    );
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
    const revisionStyles = {
        border: "none",
        borderTop: "1px solid #888888",
        borderBottom: "1px solid #888888",
    };
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
        <button style={{...revisionStyles, borderLeft: "1px solid #888888"}}
                onClick={() => metaModel.revert(metaModel.revision - 1)}>{"<"}</button>
        <button style={revisionStyles}> rev. {metaModel.revision}</button>
        <button style={{...revisionStyles, borderRight: "1px solid #888888"}}
                onClick={() => metaModel.revert(metaModel.revision + 1)}>{">"}</button>
        <Tooltip title="export json">
            <IconButton sx={{color}} aria-label="download json" onClick={
                () => downloadModelJson(metaModel.toJson())
            }><Download/>
            </IconButton>
        </Tooltip>
        <Tooltip title="snapshot png">
            <IconButton sx={{color}} aria-label="snapshot" onClick={
                () => createPngLink()
            }><Image/>
            </IconButton>
        </Tooltip>
        <Tooltip title="permalink">
            <a id="permalink" href={"/?z=" + metaModel.zippedJson}>
                <IconButton sx={{color}} aria-label="permalink">
                    <Link/>
                </IconButton>
            </a>
        </Tooltip>
        <ShareButton metaModel={metaModel} color={color}/>

    </React.Fragment>;
}