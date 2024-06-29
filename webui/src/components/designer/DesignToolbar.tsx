import React from "react";
import {Grid, IconButton, Tooltip} from "@mui/material";
import {
    Adjust,
    ArrowRightAlt,
    CheckBoxOutlineBlank,
    ControlCamera,
    Delete,
    DragHandle,
    PlayCircleOutlined,
    RadioButtonUnchecked,
    StopCircleOutlined
} from "@mui/icons-material";

import CameraIcon from "@mui/icons-material/Camera";
import {Action, MetaModel} from "../../lib/pflow";

interface DesignToolbarProps {
    metaModel: MetaModel;
}


export default function DesignToolbar(props: DesignToolbarProps) {
    const {metaModel} = props;

    async function menuAction(action: Action): Promise<void> {
        await metaModel.menuAction(action);
        metaModel.unsetCurrentObj();
        return metaModel.update();
    }

    const selectedColor = "#8140ff";

    const unselectedColor = "#000000";

    function getColor(mode: Action): string {
        if (mode === metaModel.mode) {
            return selectedColor;
        } else {
            return unselectedColor;
        }
    }

    const ExecuteBtn = () => {
        if (metaModel.mode === "execute") {
            return <Tooltip title="3. Running">
                <IconButton sx={{color: getColor("execute")}} aaria-label="execute"
                            onClick={() => menuAction("execute")}>
                    <StopCircleOutlined/>
                </IconButton>
            </Tooltip>;
        } else {
            return <Tooltip title="3. Run">
                <IconButton sx={{color: getColor("execute")}} aria-label="execute"
                            onClick={() => menuAction("execute")}>
                    <PlayCircleOutlined/>
                </IconButton>
            </Tooltip>;
        }
    };

    return <React.Fragment>
        <Grid container justifyContent="center">
            <Tooltip title="1. Select">
                <IconButton sx={{color: getColor("select")}} aria-label="select"
                            onClick={() => menuAction("select")} href="">
                    <ControlCamera/>
                </IconButton>
            </Tooltip>
            <Tooltip title="2. Snapshot">
                <IconButton sx={{color: getColor("snapshot")}} aria-label="snapshot"
                            onClick={() => menuAction("snapshot")} href="">
                    <CameraIcon/>
                </IconButton>
            </Tooltip>
            <ExecuteBtn/>
            <Tooltip title="4. Place">
                <IconButton sx={{color: getColor("place")}} aria-label="place"
                            onClick={() => menuAction("place")} href="">
                    <RadioButtonUnchecked/>
                </IconButton>
            </Tooltip>
            <Tooltip title="5. Transition">
                <IconButton sx={{color: getColor("transition")}} aria-label="transition"
                            onClick={() => menuAction("transition")} href="">
                    <CheckBoxOutlineBlank/>
                </IconButton>
            </Tooltip>
            <Tooltip title="6. Arc">
                <IconButton sx={{color: getColor("arc")}} aria-label="arc"
                            onClick={() => menuAction("arc")} href="">
                    <ArrowRightAlt/>
                </IconButton>
            </Tooltip>
            <Tooltip title="7. Token">
                <IconButton sx={{color: getColor("token")}} aria-label="token"
                            onClick={() => menuAction("token")} href="">
                    <Adjust/>
                </IconButton>
            </Tooltip>
            <Tooltip title="8. Delete">
                <IconButton sx={{color: getColor("delete")}} aria-label="delete"
                            onClick={() => menuAction("delete")} href="">
                    <Delete/>
                </IconButton>
            </Tooltip>
            <Tooltip title="9. resize">
                <IconButton sx={{color: unselectedColor}} aria-label="resize"
                            onClick={() => menuAction("resize")} href="">
                    <DragHandle/>
                </IconButton>
            </Tooltip>
        </Grid>
    </React.Fragment>;
}
