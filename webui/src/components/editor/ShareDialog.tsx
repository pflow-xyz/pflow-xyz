import * as React from 'react';
import {Fragment} from 'react';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import {CopyAll, Share} from "@mui/icons-material";
import {MetaModel} from "../../lib/pflow";

type ShareOpts = {
    metaModel: MetaModel
}

type ShareResponse = {
    cid: string,
    ok: boolean
}

export default function ShareDialog({metaModel}: ShareOpts) {
    const [open, setOpen] = React.useState(false);

    const [copied, setCopied] = React.useState('Copy');

    const handleClickOpen = async () => {
        await fetch("/share/?z=" + metaModel.zippedJson)
            .then(res => res.json())
            .then((res: ShareResponse) => {
                if (res.ok) {
                    sessionStorage.setItem("cid", res.cid);
                    setOpen(true);
                } else {
                    alert("Server failed to store the model.")
                }
            }).catch((e) => {
                console.error(e);
                alert("Error when attempting to share the model.")
            });
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
        if (copied === "Copy") {
            setCopied("Copied ✔");
        }
        setTimeout(() => {
            handleClose();
            setCopied("Copy");
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
                        &nbsp;{copied} Markdown to Clipboard.
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
