import React from 'react';
import ReactDOM from 'react-dom/client';
import {createBrowserRouter, RouterProvider, useLocation, useSearchParams,} from "react-router-dom";
import './index.css';
import App from './App';
import {MetaMaskInpageProvider} from "@metamask/providers";
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
import AppManual from "./docs/AppManual";

declare global {
    interface Window {
        ethereum: MetaMaskInpageProvider;
    }
}

const Pages = {
    Homepage,
    App,
    Hello,
}


const Page = () => {
    const location = useLocation();
    const [searchParams, _] = useSearchParams();

    if (location.pathname.startsWith("/app")) {
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
        path: "/app",
        element: <Page/>,
    },
    {
        path: "/app-manual",
        element: <AppManual/>,
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
