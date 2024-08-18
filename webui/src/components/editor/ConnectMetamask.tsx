import {Fragment} from 'react';
import {MetaModel} from "../../lib/pflow";


// Call the contract method

interface ConnectMetamaskProps {
    metaModel: MetaModel;
}

export default function ConnectMetamask(props: ConnectMetamaskProps) {

    async function connectMetamask() {
    }

    if (props.metaModel.ethAccount !== 'null') {
        return <Fragment>
            <button>Connected: {props.metaModel.ethAccount.substring(0, 8)}</button>
        </Fragment>
    }

    return <Fragment>
        <button onClick={() => connectMetamask()}>Connect to Metamask</button>
    </Fragment>
}