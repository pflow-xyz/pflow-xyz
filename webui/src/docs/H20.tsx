import Footer from "../components/Footer";
import React from "react";
import Header from "../components/Header";
import {SvgModel} from "../components/ReadonlyModel";
import {Paper} from "@mui/material";
import BottomNav from "../components/BottomNav";
import FlowerBar from "../components/FlowerBar";
import {modelObjectToLink} from "../lib/pflow/export";

const h20Combustion = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "H2": {"offset": 0, "initial": 2, "x": 44, "y": 160},
        "O2": {"offset": 1, "initial": 1, "x": 47, "y": 240},
        "H20": {"offset": 2, "x": 264, "y": 202}
    },
    "transitions": {
        "combustion": {"x": 153, "y": 201}
    },
    "arcs": [
        {"source": "H2", "target": "combustion", "weight": 2},
        {"source": "O2", "target": "combustion"},
        {"source": "combustion", "target": "H20", "weight": 2}
    ]
}

const h20CombustionFired = {
    "modelType": "petriNet",
    "version": "v0",
    "places": {
        "H2": {"offset": 0, "initial": 0, "x": 44, "y": 160},
        "O2": {"offset": 1, "initial": 0, "x": 47, "y": 240},
        "H20": {"offset": 2, "initial": 2, "x": 264, "y": 202}
    },
    "transitions": {
        "combustion": {"x": 153, "y": 201}
    },
    "arcs": [
        {"source": "H2", "target": "combustion", "weight": 2},
        {"source": "O2", "target": "combustion"},
        {"source": "combustion", "target": "H20", "weight": 2}
    ]
}

export default function H2Combustion(): React.ReactElement {

    const width = 300;
    const height = 200;
    const elevation = 5;

    return (<React.Fragment>
            <Header/>
            <Paper elevation={elevation} sx={{
                marginBottom: "5px",
                padding: "20px",
                maxWidth: "900px",
                margin: "auto",
            }}>
                <h1> H₂+O₂ Combustion </h1>
                <p> This is a simple Petri Net model of H₂+O₂ combustion. </p>
                <svg width={900} height={260} transform="translate(0,-100)">
                    <SvgModel modelJson={h20Combustion} width={width} height={300}/>
                </svg>
                <p>
                    This is the initial state of the Petri Net. This represents the state before the reaction has
                    occurred.
                </p>
                <svg width={900} height={260} transform="translate(0,-100)">
                    <SvgModel modelJson={h20CombustionFired} width={width} height={300}/>
                </svg>
                <div style={{
                    position: "relative",
                    padding: "20px", marginTop: "-65px"
                }}>
                    Try it out!&nbsp;
                    <button style={{
                        padding: "10px",
                        borderRadius: "10px",
                        backgroundColor: "#EBFF00",
                        color: "black",
                        border: "1px solid black",
                        textAlign: "center",
                        textDecoration: "none",
                        display: "inline-block",
                        fontSize: "16px",
                        margin: "4px 2px",

                    }}
                            onClick={
                                () => {
                                    return modelObjectToLink(h20Combustion)
                                        .then((link) => {
                                            window.location.href = link;
                                        })
                                        .catch((error) => {
                                            console.error({error})
                                        });
                                }
                            }>
                        Open in App
                    </button>
                </div>
                <Paper sx={{
                    maxWidth: "900px",
                    margin: "auto",
                }}>
                    <div style={{
                        border: "1px solid #000",
                        textAlign: "center",
                    }}>
                        <h1>Petri-net History</h1>
                        <svg width="80" height="105">
                            <g transform={"scale(.4,.4) translate(10, 65)"} fill="#00000077">
                                <path
                                    d="M63.5696 116.717H52.9743V106.14H42.3979V95.5449H31.8027H21.2263H10.6311H0.0546875V106.14V116.717H10.6311V127.293H21.2263V137.888H31.8027H42.3979H52.9743H63.5696V127.293V116.717Z"/>
                                <path
                                    d="M63.5696 0.281982H52.9743H42.3979V10.8584V21.4536H52.9743H63.5696V10.8584V0.281982Z"/>
                                <path
                                    d="M148.237 21.4536V10.8584V0.281982H137.661H127.065V10.8584V21.4536H137.661H148.237Z"/>
                                <path
                                    d="M105.913 137.888V84.9685H127.084V63.7969H148.256V42.6252H127.084V21.4536H105.913V0.281982H84.7412V21.4536H63.5696V42.6252H42.3979V63.7969H63.5696V84.9685H84.7412V137.888H63.5696V159.06H84.7412V180.231H42.3979V201.403H148.256V180.231H105.913V159.06H127.084V137.888H105.913ZM84.7412 53.2016V42.6252H105.913V63.7969H84.7412V53.2016Z"/>
                                <path
                                    d="M180.004 95.5449H169.409H158.832H148.237V106.14H137.661V116.717H127.065V127.293V137.888H137.661H148.237H158.832H169.409V127.293H180.004V116.717H190.58V106.14V95.5449H180.004Z"/>
                            </g>
                        </svg>
                        <p style={{
                            padding: "30px",
                        }}>
                            Some sources state that Petri nets were invented in August 1939 <br/>
                            by Carl Adam Petri—<u>at the age of 13</u> <br/>
                            for the purpose of describing chemical processes.

                            &nbsp;<a href={"https://en.wikipedia.org/wiki/Petri_net"} target={"_blank"}>Wikipedia</a>
                        </p>
                    </div>
                </Paper>
            </Paper>
            <BottomNav/>
            <FlowerBar/>
            <Footer/>
        </React.Fragment>
    )
}
