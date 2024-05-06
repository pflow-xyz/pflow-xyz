import React from 'react';
import './App.css';
import {getModel} from "./pflow";
import Designer from "./designer/Designer";
import {Container, Paper, Typography} from "@mui/material";
import DesignToolbar from "./designer/DesignToolbar";
import Editor from "./editor/Editor";
import {GitHub, Twitter} from "@mui/icons-material";

function App(): React.ReactElement {
    // REVIEW: why is this needed if we never call the update hook?
    const [metaModel,] = React.useState(getModel()); // <- this works
    // const metaModel = getModel(); // <- this doesn't work

    const [modelVersion, modelUpdated] = React.useState(0);
    metaModel.onUpdate(() => modelUpdated(modelVersion ? 0 : 1));

    return (<React.Fragment>
        <Paper sx={{marginBottom: "5px"}}>
            <Designer metaModel={metaModel}/>
            <DesignToolbar metaModel={metaModel}/>
        </Paper>
        <Editor metaModel={metaModel}/>
        <Container sx={{display: "flex", justifyContent: "center", padding: "3"}}>
            <table>
                <tbody>
                <tr>
                    <td>
                        <a href="https://github.com/pFlow-dev/pflow-xyz" target="_blank">
                            <GitHub/>
                            <Typography sx={{float: "right"}}>
                                &nbsp;Fork me!
                            </Typography>
                        </a>
                    </td>
                    <td>
                        <a href="https://twitter.com/stackdump_eth" target="_blank">
                            <Twitter/>
                            <Typography sx={{float: "right"}}>
                                @stackdump_eth
                            </Typography>
                        </a>
                    </td>
                </tr>
                </tbody>
            </table>
        </Container>
    </React.Fragment>)
}

export default App;
