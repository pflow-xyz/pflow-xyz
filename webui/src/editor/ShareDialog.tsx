import * as React from 'react';
import {Fragment} from 'react';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import {CopyAll, Share} from "@mui/icons-material";

export default function ShareDialog() {
    const [open, setOpen] = React.useState(false);

    const [coppied, setCoppied] = React.useState('Copy');

    const handleClickOpen = () => {
        setOpen(true);
    };

    const handleClose = () => {
        setOpen(false);
    };

    function getMarkdown(baseUrl: string = 'https://pflow.dev'): string {
        const cid = sessionStorage.getItem("cid");
        const url = baseUrl + "/p/" + cid + "/";
        const img = baseUrl + "/img/" + cid + ".svg";
        return `[![pflow](${img})](${url})`
    }

    function copyMarkdown() {
        navigator.clipboard.writeText(getMarkdown());
        if (coppied === "Copy") {
            setCoppied("Coppied ✔");
        }
        setTimeout(() => {
            handleClose();
            setCoppied("Copy");
        }, 500);
    }

    return (
        <React.Fragment>
            <Share onClick={handleClickOpen}></Share>
            <Dialog
                open={open}
                onClose={handleClose}
                PaperProps={{
                    component: 'form',
                }}
            >
                <DialogTitle>
                    <a onClick={copyMarkdown}>
                        <CopyAll/>
                        &nbsp;{coppied} Markdown to Clipboard.
                    </a>
                </DialogTitle>
                <DialogContent onClick={copyMarkdown}>
                    <Fragment>
                <pre>
                    {getMarkdown()}
                </pre>
                    </Fragment>
                </DialogContent>
            </Dialog>
        </React.Fragment>
    );
}
