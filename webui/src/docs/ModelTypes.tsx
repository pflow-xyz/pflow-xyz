import Footer from "../components/Footer";
import React from "react";
import Header from "../components/Header";
import {SvgModel} from "../components/ReadonlyModel";
import {Paper} from "@mui/material";
import BottomNav from "../components/BottomNav";
import FlowerBar from "../components/FlowerBar";
import {Link} from "react-router-dom";
import * as sources from "../lib/sources";

export default function ModelTypes(): React.ReactElement {

    const width = 900;
    const elevation = 5;

    return (<React.Fragment>
            <Header/>
            <Paper elevation={elevation} sx={{
                marginBottom: "5px",
                padding: "20px",
                maxWidth: "900px",
                margin: "auto",
            }}>
                <h1>Supported Types of Models</h1>
                <p>This is a slightly more advanced topic see <Link to={"/docs-petri-net-101"}> Petri-net 101</Link> if you not already familiar with the basics.</p>
                <p>There are three model types supported by the system:</p>
                <ul>
                    <li><b>Petri-nets</b> - supports any design shows weight on each arc.</li>
                    <li><b>wf-nets</b> - extension to allow splits / or conditions - weight is always 1</li>
                    <li><b>elementary</b> - state machine limited to 1 token</li>
                </ul>
                <h1>Inputs</h1>
                <div style={{
                    border: "1px solid black",
                    borderRadius: "10px",
                }}>
                    <SvgModel modelJson={sources.optionalChioce} width={width} height={300}/>
                </div>
                <p>
                    NOTE Above: Petri-net models require all pre-req states to be satisfied.
                </p>
                <p>
                    Contrast with a workflow model below, where only 1 precondition must be met. <br/>
                    NOTE: that the elementary model is a special case of workflow, where option conditions are not
                    allowed.
                </p>
                <div style={{
                    border: "1px solid black",
                    borderRadius: "10px",
                }}>
                    <SvgModel modelJson={sources.wf} width={width} height={300}/>
                </div>
                <h1>Outputs</h1>
                <div style={{
                    border: "1px solid black",
                    borderRadius: "10px",
                }}>
                    <SvgModel modelJson={sources.output2} width={width} height={300}/>
                </div>
                <p>
                    Notice in the Petri-net model above, there is no issue creating 2 output tokens from 1 input.
                </p>
                <p>
                    Compare with the workflow model below where the transition is disabled. <br/>
                    In Workflow and Elementary models only 1 token is allowed to exist in the net.
                </p>
                <div style={{
                    border: "1px solid black",
                    borderRadius: "10px",
                }}>
                    <SvgModel modelJson={sources.output2wf} width={width} height={300}/>
                </div>
            </Paper>
            <BottomNav/>
            <FlowerBar/>
            <Footer/>
        </React.Fragment>
    )
}
