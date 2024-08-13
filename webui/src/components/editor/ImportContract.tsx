import {Fragment} from 'react';
import {MetaModel} from "../../lib/pflow";
import {DEFAULT_CONTRACT} from "../../lib/pflow/contract";

interface ContractQueryProps {
    metaModel: MetaModel;
}

export default function ImportContract(props: ContractQueryProps) {

    const {metaModel} = props;

    async function onSubmit(evt: any) {
        evt.preventDefault();
        if (props.metaModel.ethAccount === 'null') {
            alert("Connect to Metamask first");
            return;
        }

        try {
            let address = evt.target[0].value;
            if (!address || address == "null") {
                address = DEFAULT_CONTRACT;
            }

            const def = await metaModel.loadFromAddress({address});
            console.log(def, 'loaded')
            return props.metaModel.commit({action: "importContract"})
        }
        catch (e) {
            const err = e as Error;
            alert("Error importing contract: "+err.message+" -- Connected to the right network?")
            console.error(e)
        }
    }

    return <Fragment>
        <br/>
        <form onSubmit={onSubmit}
              onFocus={() => metaModel.beginEdit()}
              onBlur={() => metaModel.endEdit()}
        >
            <input type="text" defaultValue={props.metaModel.getContract()} style={{width: "30em"}}/>
            <input type="submit" value="Import ETH Contract"/>
        </form>
        <br/>
    </Fragment>
}
