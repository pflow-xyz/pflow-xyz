import * as React from 'react';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import {MenuBook, SourceOutlined} from "@mui/icons-material";
import {Link} from "react-router-dom";
import {IconButton} from "@mui/material";

export default function HelpMenu() {
    const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
    const open = Boolean(anchorEl);
    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        setAnchorEl(event.currentTarget);
    };
    const handleClose = () => {
        setAnchorEl(null);
    };

    return (<div>
        <Button
            id="help-button"
            aria-controls={open ? 'basic-menu' : undefined}
            aria-haspopup="true"
            aria-expanded={open ? 'true' : undefined}
            sx={{color: "#000000"}}
            onClick={handleClick}
        >
            help
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
            <MenuItem onClick={handleClose}>
                <IconButton><MenuBook/></IconButton>&nbsp;<Link to={"/editor-manual"}>Manual</Link>
            </MenuItem>
            <MenuItem onClick={handleClose}>
                <IconButton><SourceOutlined/></IconButton>&nbsp;<Link to={"/docs"}>Documentation</Link>
            </MenuItem>
        </Menu>
    </div>)
}
