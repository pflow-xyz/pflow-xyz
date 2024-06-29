import React from 'react';
import {Paper, TextField} from '@mui/material';
import {MetaModel} from "../../lib/pflow";
import {Arc} from "./Arc";
import Tooltip from "@mui/material/Tooltip";
import {Clear} from "@mui/icons-material";

function valToInt(value: string): number {
    const val = parseInt(value);
    if (!!val && val >= 0) {
        return val;
    }
    return 0;
}

interface TransitionProps {
    selectedObj: any;
    metaModel: MetaModel;
}

export default function Transition(props: TransitionProps) {
    const {metaModel} = props;
    const transition = metaModel.getTransition(props.selectedObj.label);
    const onFocus = () => metaModel.beginEdit();
    const onBlur = () => metaModel.endEdit();

    async function handleChange(evt: React.ChangeEvent<HTMLInputElement>) {
        // construct a new label and avoid collision with existing objects

        switch (evt.target.id) {
            case ('role'): {
                transition.role = {label: evt.target.value};
                break;
            }
            case ('label'): {
                metaModel.m.renameTransition(transition.label, metaModel.m.newLabel(evt.target.value));
                break;
            }
            case ('x'): {
                metaModel.getTransition(transition.label).position.x = valToInt(evt.target.value);
                break;
            }
            case ('y'): {
                metaModel.getTransition(transition.label).position.y = valToInt(evt.target.value);
                break;
            }
            default: {

            }
        }
        await metaModel.commit({action: `transition change ${evt.target.id}: ${evt.target.value}`});
        return true;
    }

    const arcs = metaModel.m.def.arcs.map((arc) => {
        if (arc.source.transition !== transition && arc.target.transition !== transition) {
            return null;
        }
        return <Arc key={"arc_" + arc.offset} metaModel={metaModel} arc={arc}/>
    });

    const marginTop = "5px";
    const width = "5em";

    return <React.Fragment>
        <Paper elevation={0} sx={{padding: "12px", marginRight: "16px", minHeight: "16em"}}>
            <form noValidate autoComplete="off">
                <TextField sx={{marginTop, width: "9em"}} id="type" label="Type" variant="outlined" disabled={true}
                           onFocus={onFocus}
                           onBlur={onBlur}
                           onChange={handleChange} value="Transition"/>
                <TextField sx={{marginTop, width: "19em"}} id="label" label="Label" variant="outlined"
                           onFocus={onFocus}
                           onBlur={onBlur}
                           onChange={handleChange} value={transition.label}/>
                <TextField sx={{marginTop, width: "19em"}} id="role" label="Role" variant="outlined"
                           onChange={handleChange}
                           onFocus={onFocus}
                           onBlur={onBlur}
                           value={transition.role.label}/>
                <TextField sx={{marginTop, width}} type="number" id="x" label="x" variant="outlined"
                           onChange={handleChange}
                           onFocus={onFocus}
                           onBlur={onBlur}
                           value={transition.position.x}/>
                <TextField sx={{marginTop, width}} type="number" id="y" label="y" variant="outlined"
                           onChange={handleChange}
                           onFocus={onFocus}
                           onBlur={onBlur}
                           value={transition.position.y}/>
                <Tooltip sx={{marginBottom: "-29px"}} title={"delete"}>
                    <Clear onClick={async () => {
                        metaModel.m.deleteTransition(transition.label);
                        metaModel.unsetCurrentObj();
                        await metaModel.commit({action: `transition delete ${transition.label}`});
                    }}
                    />
                </Tooltip>
            </form>
            <br/>
            {arcs}
            <br/>
        </Paper>
    </React.Fragment>;
}
