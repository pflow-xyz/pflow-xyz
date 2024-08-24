import {Fragment, useState, useEffect} from 'react';
import {MetaModel} from "../../lib/pflow";
import { useWeb3ModalProvider } from '@web3modal/ethers/react'
import { BrowserProvider } from 'ethers'

interface ContractQueryProps {
    metaModel: MetaModel;
}

export default function ImportContract(props: ContractQueryProps) {
    const {metaModel} = props;

    const { walletProvider } = useWeb3ModalProvider()

    const [provider, setProvider] = useState<BrowserProvider | null>(null);

    const [address, setAddress] = useState<string | null>(null);

    useEffect(() => {
        if (walletProvider) {
            const p = new BrowserProvider(walletProvider);
            p.getNetwork().then((network) => {
                setAddress(metaModel.getAddressByNetwork(network.chainId));
            }).finally(() => { setProvider(p) });
        }
    }, [walletProvider]);



    async function onSubmit(evt: any) {
        evt.preventDefault();

        try {
            let address = evt.target[0].value;

            if (provider) {
                console.log("Importing contract: "+address);
                metaModel.loadFromAddress({address, provider})
                    .then(() => console.log("Imported contract: "+address))
                    .finally(() => metaModel.update())
            }
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
            <input type="text" defaultValue={address || ''} style={{width: "30em"}}/>
            <input type="submit" value="Import ETH Contract"/>
        </form>
        <br/>
    </Fragment>
}
