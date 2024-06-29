import * as React from 'react';
import Button from '@mui/material/Button';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import {MetaModel} from "../../lib/pflow";
import {CopyAll, Download, Image, UploadFile} from "@mui/icons-material";
import {FileUploader} from "react-drag-drop-files";
import {downloadModelJson, downloadSolidity} from "../../lib/pflow/export";
import {downloadPngFromCanvas} from "../../lib/pflow/snapshot";
import {jsonToSolidity} from "../../lib/pflow/solidity";

type CollectionProps = {
    metaModel: MetaModel;
}

export default function FileMenu(props: CollectionProps) {
    const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
    const open = Boolean(anchorEl);

    const {metaModel} = props;

    const handleClick = (event: React.MouseEvent<HTMLButtonElement>) => {
        setAnchorEl(event.currentTarget);
    };
    const handleClose = () => {
        setAnchorEl(null);
    };
    const handleFile = async (file: File) => {
        metaModel.uploadFile(file).then(async () => {
            await metaModel.menuAction("select");
            await metaModel.update();
        })
        handleClose();
    };

    const handleExport = () => {
        downloadModelJson(metaModel.toJson());
        handleClose();
    }

    const handleSolidityExport = () => {
        downloadSolidity(jsonToSolidity(metaModel.toJson()));
        handleClose();
    }

    const handleSnapshot = async () => {
        if (metaModel.mode !== "snapshot") {
            await metaModel.menuAction("snapshot")
        }
        downloadPngFromCanvas()
        await metaModel.update();
        handleClose();
    }

    return (
        <div>
            <Button
                id="file-button"
                aria-controls={open ? 'basic-menu' : undefined}
                aria-haspopup="true"
                aria-expanded={open ? 'true' : undefined}
                sx={{color: "#000000"}}
                onClick={handleClick}
            >
                file
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
                <MenuItem>
                    <FileUploader handleChange={handleFile} name="model upload" types={["JSON"]}>
                        <UploadFile/>&nbsp;Import Json
                    </FileUploader>
                </MenuItem>
                <MenuItem onClick={handleExport}><Download/>&nbsp;Export Json</MenuItem>
                <MenuItem onClick={handleSolidityExport}><CopyAll/>&nbsp;Export Solidity</MenuItem>
                <MenuItem onClick={handleSnapshot}><Image/>&nbsp;Snapshot Png</MenuItem>
            </Menu>
        </div>
    )
        ;
}
// REVIEW: support export to remix
// <MenuItem onClick={handleExport}>
//     <svg width="22" height="22" viewBox="0 0 215.635 196.585">
//         <g transform={"translate(0, -60)"}>
//             <path
//                 d="M40.58 204.628c-14.434-18.751-26.214-34.13-26.179-34.175.036-.045 1.411.654 3.057 1.553l26.18 14.3 23.187 12.664 21.52-11.75a25076.33 25076.33 0 0 0 26.073-14.247c2.504-1.375 4.587-2.469 4.629-2.432.041.037-11.692 15.393-26.075 34.124l-26.15 34.056zm48.72 33.42c.091-.15 4.325-6.244 9.408-13.544l24.5-35.189 15.257-21.916v-23.86l-7.316-11.528c-4.024-6.34-14.86-23.422-24.082-37.958a37612.645 37612.645 0 0 0-17.139-27.005c-.314-.485-.317-.542-.023-.364.193.117 18.315 14.315 40.272 31.551 21.957 17.237 47.246 37.082 56.197 44.101 8.952 7.02 16.28 12.832 16.284 12.918.004.086-5.218 3.975-11.606 8.642a80324.547 80324.547 0 0 0-30.408 22.222c-28.408 20.78-70.927 51.84-71.184 51.997-.224.14-.275.118-.16-.068m-24.492-63.05c-1.027-.563-12.899-7.044-26.381-14.403-13.483-7.358-24.542-13.406-24.577-13.439-.035-.033 4.123-6.469 9.24-14.302 5.117-7.834 15.006-22.979 21.976-33.656C65.979 67.16 66.67 66.108 66.819 66.105c.078 0 11.99 18.215 26.47 40.48 21.966 33.777 26.274 40.532 26.004 40.779-.368.338-52.222 28.67-52.461 28.663-.086-.003-.997-.465-2.024-1.028"/>
//         </g>
//     </svg>
//     &nbsp;Export-to-Remix</MenuItem>
