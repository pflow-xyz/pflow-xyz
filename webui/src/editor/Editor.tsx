import React from 'react';
import Place from './Place';
import {Box} from '@mui/material';
import Transition from "./Transition";
import Source from "./Source";
import {MetaModel} from "../pflow";
import History from "./History";
import SubMenu from "./SubMenu";

interface EditorProps {
    metaModel: MetaModel;
}

export default function Editor(props: EditorProps): React.ReactElement {
    const {metaModel} = props;
    const selectedObj = metaModel.getCurrentObj();
    const marginTop = '1em';
    const marginLeft = '1em';
    if (metaModel.mode === 'execute') {
        return <React.Fragment>
            <Box sx={{marginTop, marginLeft}}>
                <History metaModel={metaModel}/>
            </Box>
        </React.Fragment>;
    }


    if (!selectedObj) {
        return <React.Fragment>
            <Box sx={{m: 2}}>
                <SubMenu metaModel={metaModel}></SubMenu>
                <Source metaModel={metaModel}/>
            </Box>
        </React.Fragment>;
    }

    switch (selectedObj.metaType) {
        case 'place': {
            return <React.Fragment>
                <Box sx={{marginTop, marginLeft}}>
                    <SubMenu metaModel={metaModel}></SubMenu>
                    <Place selectedObj={selectedObj} metaModel={props.metaModel}/>
                </Box>
            </React.Fragment>;
        }
        case 'transition': {
            return <React.Fragment>
                <Box sx={{marginTop, marginLeft}}>
                    <SubMenu metaModel={metaModel}></SubMenu>
                    <Transition selectedObj={selectedObj} metaModel={props.metaModel}/>
                </Box>
            </React.Fragment>;
        }
        default: {
            return <React.Fragment>
                <Box sx={{m: 2}}>
                    <SubMenu metaModel={metaModel}></SubMenu>
                    <Source metaModel={props.metaModel}/>
                </Box>
            </React.Fragment>;
        }
    }
}
