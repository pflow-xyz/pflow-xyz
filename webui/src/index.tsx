import React from 'react';
import ReactDOM from 'react-dom/client';
import {createBrowserRouter, RouterProvider, useLocation, useSearchParams,} from "react-router-dom";
import './index.css';
import App from './App';
import Homepage from "./Homepage";
import Docs from "./docs/Docs";
import ModelTypes from "./docs/ModelTypes";
import MetamodelOverview from "./docs/MetamodelOverview";
import TicTacToe from "./docs/TicTacToe";
import KonamiCode from "./docs/KonamiCode";
import Examples from "./docs/Examples";
import Hello from "./Hello";
import H2Combustion from "./docs/H20";
import PetriNet101 from "./docs/PetriNet101";
import DiningPhilosophers from "./docs/DiningPhilosophers";
import EditorManual from "./docs/EditorManual";
import {createWeb3Modal, defaultConfig} from '@web3modal/ethers/react'

declare global {
    interface Window {
        // @ts-ignore
        ethereum: any;
    }
}

export const ethereum = {
    chainId: 1,
    name: 'Ethereum',
    currency: 'ETH',
    explorerUrl: 'https://etherscan.io',
    rpcUrl: 'https://eth-mainnet.blastapi.io/4fd309c5-6555-4052-99d5-3a6b646f14b4',
}

export const optimism = {
    chainId: 10,
    name: 'Optimism Mainnet',
    currency: 'ETH',
    explorerUrl: 'https://optimistic.etherscan.io',
    rpcUrl: 'https://optimism-mainnet.blastapi.io/4fd309c5-6555-4052-99d5-3a6b646f14b4',
}

export const hardhat = {
    chainId: 31337,
    name: 'Hardhat Testnet',
    currency: 'ETH',
    explorerUrl: '',
    rpcUrl: 'http://localhost:8545',
}

export const sepoliaOptimism = {
    chainId: 11155420,
    name: 'Sepolia Optimism Testnet',
    currency: 'ETH',
    explorerUrl: 'https://sepolia-optimism.etherscan.io',
    rpcUrl: "https://optimism-sepolia.blastapi.io/4fd309c5-6555-4052-99d5-3a6b646f14b4"
}

export const sepolia = {
    chainId: 11155111,
    name: 'Sepolia Testnet',
    currency: 'ETH',
    explorerUrl: 'https://sepolia.etherscan.io',
    rpcUrl: 'https://eth-sepolia.blastapi.io/4fd309c5-6555-4052-99d5-3a6b646f14b4',
}

export const projectId = 'd76cef25c0687c2391805b1d2864ba8f';

// 3. Create a metadata object
const metadata = {
    name: 'pflow.xyz',
    description: 'Metamodel Explorer',
    url: 'https://app.pflow.xyz', // origin must match your domain & subdomain
    icons: [ 'https://avatars.githubusercontent.com/u/86532620' ]
}

const ethersConfig = defaultConfig({
    metadata,

    auth: {
        email: true,
        socials: ['github'],
        showWallets: false,
        walletFeatures: true
    },

    enableEIP6963: true, // true by default
    enableInjected: true, // true by default
    enableCoinbase: false, // true by default
    defaultChainId: 1, // used for the Coinbase SDK
})

createWeb3Modal({
    ethersConfig,
    chains: [ethereum, sepolia, optimism, sepoliaOptimism, hardhat],
    projectId,
    enableAnalytics: true // Optional - defaults to your Cloud configuration
})

const Pages = {
    Homepage,
    App,
    Hello,
}


const Page = () => {
    const location = useLocation();
    const [searchParams, _] = useSearchParams();

    if (location.pathname.startsWith("/editor")) {
        return <Pages.App/>;
    }

    if (searchParams.has("hello")) {
        return <Pages.Hello/>;
    }

    if (searchParams.has("cid")) {
        return <Pages.App/>;
    }

    if (searchParams.has("z")) {
        return <Pages.App/>;
    }
    return <Pages.Homepage/>;
};

const router = createBrowserRouter([
    {
        path: "/",
        element: <Page/>,
    },
    {
        path: "/editor",
        element: <Page/>,
    },
    {
        path: "/editor-manual",
        element: <EditorManual/>,
    },
    {
        path: "/docs",
        element: <Docs/>,
    },
    {
        path: "/hello",
        element: <Page/>,
    },
    {
        path: "/docs-petri-net-101",
        element: <PetriNet101/>,
    },
    {
        path: "/docs-model-types",
        element: <ModelTypes/>,
    },
    {
        path: "/docs-metamodel-overview",
        element: <MetamodelOverview/>,
    },
    {
        path: "/examples",
        element: <Examples/>,
    },
    {
        path: "/examples-dining-philosophers",
        element: <DiningPhilosophers/>,
    },
    {
        path: "/examples-tic-tac-toe",
        element: <TicTacToe/>,
    },
    {
        path: "/examples-konami-code",
        element: <KonamiCode/>,
    },
    {
        path: "/examples-h2-combustion",
        element: <H2Combustion/>,
    },
]);

// @ts-ignore
ReactDOM.createRoot(document.getElementById("root")).render(
    <React.StrictMode>
        <RouterProvider router={router}/>
    </React.StrictMode>
);
