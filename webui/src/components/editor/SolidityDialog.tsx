import * as React from 'react';
import {Fragment} from 'react';
import Dialog from '@mui/material/Dialog';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import {CopyAll} from "@mui/icons-material";
import {MetaModel} from "../../lib/pflow";
import {jsonToSolidity} from "../../lib/pflow/solidity";

type ShareOpts = {
    metaModel: MetaModel
}

type ShareResponse = {
    cid: string,
    ok: boolean
}

// REVIEW: this only works for code < 1000 chars
function remixCodeUrl(sourceCode: string, language: string, solidityVersion: string): string {
    const base64EncodedSource = btoa(unescape(encodeURIComponent(sourceCode)));
    return `https://remix.ethereum.org/?language=${language}&version=${solidityVersion}&code=${base64EncodedSource}`;
}

export default function SolidityDialog({metaModel}: ShareOpts) {
    const [open, setOpen] = React.useState(false);

    const [copied, setCopied] = React.useState('Copy');

    const handleClickOpen = async () => {
        await fetch("/share-solidity/?z=" + metaModel.zippedJson)
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

    function getSourceCode(): string {
        return jsonToSolidity(metaModel.toJson());
    }

    function copyMarkdown() {
        navigator.clipboard.writeText(getSourceCode());
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
            <CopyAll onClick={handleClickOpen}/>
            <Dialog
                open={open}
                onClose={handleClose}
                PaperProps={{
                    component: 'form',
                    sx: { minWidth: '80vw', minHeight: '80vh'}
                }}
            >
                <DialogTitle>
                    <a onClick={copyMarkdown}>
                        <CopyAll/>
                        &nbsp;{copied} Solidity Code to Clipboard.
                    </a>
                </DialogTitle>
                <DialogContent onClick={copyMarkdown}>
                    <Fragment>
                <pre>
                    {getSourceCode()}
                </pre>
                    </Fragment>
                </DialogContent>
            </Dialog>
        </React.Fragment>
    );
}
