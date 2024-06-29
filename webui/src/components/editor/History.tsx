import React from "react";
import {FormGroup, Grid, Paper, TextField} from "@mui/material";
import {MetaModel} from "../../lib/pflow";

export default function History(props: { metaModel: MetaModel }) {
    const history = props.metaModel.stream.history;
    const entries = [];

    for (const i in history) {
        const val = history[i];
        entries.unshift(
            <FormGroup row key={"history" + val.seq}>
                <TextField sx={{marginTop: "5px", width: "20em"}} label={val.seq} key={"history" + val.seq}
                           value={val.event.action}/>
            </FormGroup>
        );
    }

    return <React.Fragment>
        <Paper elevation={0} sx={{padding: "12px", marginRight: "16px", minHeight: "20em"}}>
            <Grid container spacing={2}>
                <Grid item xs={12} md={12}>{entries}</Grid>
            </Grid>
        </Paper>
    </React.Fragment>;
}