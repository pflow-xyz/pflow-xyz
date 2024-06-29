import * as React from 'react';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import {MetaModel} from "../../lib/pflow";
import {ClearAll, Redo, Undo} from "@mui/icons-material";

type EditMenuProps = {
    metaModel: MetaModel;
}
export default function EditMenu(props: EditMenuProps) {
    const {metaModel} = props;
    const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
    const open = Boolean(anchorEl);
    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        setAnchorEl(event.currentTarget);
    };
    const handleClose = () => {
        setAnchorEl(null);
    };
    const handleClear = async () => {
        await metaModel.menuAction("select");
        await metaModel.clearAll();
        handleClose();
    };

    const handleUndo = async () => {
        await metaModel.revert(metaModel.revision - 1);
        metaModel.unsetCurrentObj();
        handleClose();
    }
    const handleRedo = async () => {
        await metaModel.revert(metaModel.revision + 1);
        metaModel.unsetCurrentObj();
        handleClose();
    }

    return (
        <div>
            <Button
                id="edit-button"
                aria-controls={open ? 'basic-menu' : undefined}
                aria-haspopup="true"
                aria-expanded={open ? 'true' : undefined}
                sx={{color: "#000000"}}
                onClick={handleClick}
            >
                edit
            </Button>
            <Menu
                id="basic-menu"
                anchorEl={anchorEl}
                open={open}
                onClose={handleClose}
                MenuListProps={{
                    'aria-labelledby': 'basic-button',
                }}
            >
                <MenuItem onClick={handleUndo}><Undo/>&nbsp;Undo</MenuItem>
                <MenuItem onClick={handleRedo}><Redo/>&nbsp;Redo</MenuItem>
                <MenuItem onClick={handleClear}><ClearAll/>&nbsp;Clear All</MenuItem>
            </Menu>
        </div>
    );
}
