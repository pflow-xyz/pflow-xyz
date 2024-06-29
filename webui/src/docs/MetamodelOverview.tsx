import {Paper} from "@mui/material";
import Header from "../components/Header";
import React, {Fragment} from "react";
import Footer from "../components/Footer";
import BottomNav from "../components/BottomNav";
import FlowerBar from "../components/FlowerBar";
import SourceCode from "../components/SourceCode";
import * as sources from "../lib/sources";
import {Link} from "react-router-dom";

export default function MetamodelOverview() {
    return (
        <Fragment>
            <Header/>
            <Paper sx={{
                marginBottom: "5px",
                padding: "20px",
                maxWidth: "900px",
                margin: "auto",
                justifyContent: "center",
                alignContent: "center",
                minHeight: "90vh",
            }}>
                <h1>Metamodel Overview</h1>
                <ul>
                    <li>
                        <a href="#modelInterface">Model Interface</a> - the on-chain interface for the Petri net model
                    </li>
                    <li>
                        <a href="#pflowDsl">Pflow DSL</a> - a Domain Specific Language for defining the Petri net.
                    </li>
                </ul>
                <h2>Model Interface</h2>
                <p>
                    ModelInterface is the on-chain interface for the Petri net model contract.
                </p>
                <SourceCode id="modelInterface" code={sources.ModelInterface} language="solidity"/>
                <p>
                    At runtime, pflow calls the declaration() function to get the Petri net declaration.
                </p>
                <h2>PflowDSL</h2>
                <SourceCode id="pflowDsl" code={sources.PflowDSLConstructor} language="solidity"/>
                <p>
                    PflowDSL is an abstract contract providing a domain-specific language for defining the Petri
                    net.
                </p>
                <p>
                    <b> Cell </b> - construct a place node.
                </p>
                <SourceCode id="pflowdslCell" code={sources.PflowDSLCell} language="solidity"/>
                <p>
                    <b> Func </b> - construct a transition node.
                </p>
                <SourceCode id="pflowdslFunc" code={sources.PflowDSLFunc} language="solidity"/>
                <p>
                    <b> Arrow </b> - construct an arrow from a place to a transition or vice versa.
                </p>
                <SourceCode id="pflowdslArrow" code={sources.PflowDSLArrow} language="solidity"/>
                <p>
                    <b> Guard </b> - construct a guard (read or inhibitor arc) from a place to a transition or vice
                    versa.
                </p>
                <SourceCode id="pflowdslGuard" code={sources.PflowDSLGuard} language="solidity"/>
                <Paper sx={{
                    marginBottom: "5px",
                    padding: "20px",
                    maxWidth: "900px",
                    margin: "auto",
                }}>
                    <h1 id="solidity">Model Coded in Solidity</h1>
                    <SourceCode id="tictactoemodel" code={sources.MetamodelHeader} language="solidity"/>
                    <p> The Solidity code for the <Link to={"/examples-tic-tac-toe"}>TicTacToe model</Link> Inherits the Metamodel Abstract Contract.</p>
                    <SourceCode id="tictactoemodel" code={sources.TicTacToeModel} language="solidity"/>
                    <p> Read more about the <Link to={"/examples-tic-tac-toe"}>TicTacToe model</Link> design. </p>
                    Check out this contract deployed to <a target="_blank" href={"https://sepolia-optimism.etherscan.io/address/0x7f1ed3d3aac8903f869eeb32182265dc34106353#code"}>OP Sepolia TestNet</a>
                </Paper>
            </Paper>
            <BottomNav/>
            <FlowerBar/>
            <Footer/>
        </Fragment>
    )
}
