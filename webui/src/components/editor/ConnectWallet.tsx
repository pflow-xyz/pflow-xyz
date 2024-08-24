import React, {Fragment, useEffect, useState} from 'react';
import {MetaModel} from "../../lib/pflow";
import {useWeb3ModalProvider} from "@web3modal/ethers/react";
import {BrowserProvider} from "ethers";


// Call the contract method

interface ConnectMetamaskProps {
    metaModel: MetaModel;
    svgWidth: number;
}

export default function ConnectWallet(props: ConnectMetamaskProps) {

    const [connected, setConnected] = React.useState(false);
    const { walletProvider } = useWeb3ModalProvider()

    const [provider, setProvider] = useState<BrowserProvider | null>(null);

    useEffect(() => {
        if (walletProvider) {
            setProvider(new BrowserProvider(walletProvider));
        }
    }, [walletProvider]);

    useEffect(() => {
        if (provider) {
            setConnected(true);
        }
    }, [provider]);


    return <Fragment>
        {connected && <rect x={props.svgWidth - 320} y={10} width={280} height={40} fill="#FFFFFF" rx={8} stroke={"#888888"}/>}

        <foreignObject id="pflow-foreign" x={props.svgWidth - 320} y={10} width={"100%"} height="40px">
            <w3m-button/>
        </foreignObject>
    </Fragment>
}