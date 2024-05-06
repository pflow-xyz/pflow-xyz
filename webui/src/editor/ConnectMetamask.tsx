import {Fragment} from 'react';
import {MetaModel} from "../pflow";


// Call the contract method

interface ConnectMetamaskProps {
    metaModel: MetaModel;
}

export default function ConnectMetamask(props: ConnectMetamaskProps) {

    async function connectMetamask() {
        if (typeof window.ethereum !== 'undefined') {
            try {
                await window.ethereum.request({
                    method: 'eth_requestAccounts'
                }).then((accounts) => {
                    try {
                        //@ts-ignore
                        if (accounts.length > 0) {
                            //@ts-ignore
                            props.metaModel.setConnectedAccount(accounts[0]);
                        }
                        props.metaModel.update(); // refresh
                    } catch (error) {
                        console.error(error);
                    }
                });
            } catch (error) {
                console.error(error);
            }
        } else {
            alert("Metamask not found");
        }
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