import Footer from "../components/Footer";
import React from "react";
import Header from "../components/Header";
import {Link} from "react-router-dom";
import {Paper} from "@mui/material";
import BottomNav from "../components/BottomNav";
import FlowerBar from "../components/FlowerBar";


export default function Docs(): React.ReactElement {
    return (<React.Fragment>
            <Header/>
            <Paper sx={{
                marginBottom: "5px",
                padding: "20px",
                maxWidth: "900px",
                margin: "auto",
                justifyContent: "center",
                textAlign: "center",
                alignContent: "center",
                minHeight: "90vh",
            }}>
                <h1>Documentation</h1>
                <p>Welcome to the documentation.</p>
                <table style={{
                    width: "100%",
                    textAlign: "center",
                }}>
                    <tbody>
                    <tr>
                        <td>
                            <Link to="/docs-petri-net-101">Petri-Net 101</Link>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <Link to="/editor-manual">Editor App Manual</Link>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <Link to="/docs-model-types">Model Types</Link>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <Link to="/docs-metamodel-overview">Metamodel Overview</Link>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <Link to="/examples">Examples</Link>
                        </td>
                    </tr>
                    </tbody>
                </table>
            </Paper>
            <BottomNav/>
            <FlowerBar/>
            <Footer/>
        </React.Fragment>
    )
}
