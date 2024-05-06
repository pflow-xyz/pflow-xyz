import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import App from './App';
import {MetaMaskInpageProvider} from "@metamask/providers";

declare global {
    interface Window {
        ethereum: MetaMaskInpageProvider;
    }
}

ReactDOM.createRoot(
    document.getElementById('root') as HTMLElement
).render(<App/>);
