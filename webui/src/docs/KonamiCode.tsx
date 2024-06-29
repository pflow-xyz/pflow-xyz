import Footer from "../components/Footer";
import React from "react";
import Header from "../components/Header";
import {SvgModel} from "../components/ReadonlyModel";
import {Paper} from "@mui/material";
import BottomNav from "../components/BottomNav";
import FlowerBar from "../components/FlowerBar";
import * as sources from "../lib/sources";
import {modelToLink} from "../lib/pflow/export";

const konami = sources.konamiCodeModel();
const controller = sources.gamepadModel();

export default function KonamiCode(): React.ReactElement {

    return (<React.Fragment>
            <Header/>
            <Paper sx={{
                marginBottom: "5px",
                padding: "20px",
                maxWidth: "900px",
                margin: "auto",
            }}>
                <h1>Konami Code</h1>
                <p>
                    Up, Up, Down, Down, Left, Right, Left, Right, B, A, Select, Start
                </p>
                <p>
                    The Konami Code is a cheat code that appears in many video games.<br/>
                    Created by Kazuhisa Hashimoto it was first used in the 1986 release of Gradius for the Nintendo Entertainment System.<br/>
                    The code has also found its way into many other games, and has become a symbol of gaming culture. <a
                    href={"https://en.wikipedia.org/wiki/Konami_Code"}>wikipedia.</a>
                </p>
                <div style={{
                    borderRadius: "10px",
                    border: "1px solid black",
                }}>
                    <svg id="board" width="820" height="400" transform="scale(0.5, 0.5)">
                        <g>
                            <rect id="border-group" x="100" y="100" width="710" height="300" rx="4" fill="#00000032"
                                  stroke="#000000"/>
                            <rect id="pad" x="115" y="135" width="680" height="250" rx="4" fill="#ffffff"
                                  stroke="#000000"/>
                            <g>
                                <rect id="up-down-border" x="200" y="180" width="60" height="160" rx="8"
                                      fill="#00000032"
                                      stroke="#00000032"/>
                                <rect id="left-right-border" x="150" y="230" width="160" height="60" rx="8"
                                      fill="#00000032"
                                      stroke="#00000032"/>
                                <g>
                                    <rect id="center" x="205" y="235" width="50" height="50" fill="#000000aa"
                                          stroke="#000000"/>
                                    <rect id="up" x="205" y="185" width="50" height="50" fill="#000000aa"
                                          stroke="#000000"/>
                                    <rect id="left" x="155" y="235" width="50" height="50" fill="#000000aa"
                                          stroke="#000000"/>
                                    <rect id="right" x="255" y="235" width="50" height="50" fill="#000000aa"
                                          stroke="#000000"/>
                                    <rect id="down" x="205" y="285" width="50" height="50" fill="#000000aa"
                                          stroke="#000000"/>
                                </g>
                            </g>
                            <g>
                                <rect id="sel-start-group" x="355" y="270" width="210" height="80" rx="8"
                                      fill="#00000032"
                                      stroke="#000000"/>
                                <g>
                                    <rect id="select" x="380" y="300" width="60" height="20" rx="8" fill="#000000"
                                          stroke="#000000"/>
                                    <rect id="start" x="480" y="300" width="60" height="20" rx="8" fill="#000000"
                                          stroke="#000000"/>
                                </g>
                            </g>
                            <g>
                                <rect id="b-border" x="590" y="270" width="80" height="80" rx="8" fill="#00000032"
                                      stroke="#000000"/>
                                <circle id="b" r="30" cx="630" cy="310" fill="#ff0000" stroke="#000000"
                                        stroke-width="3"></circle>
                            </g>
                            <g>
                                <rect id="a-border" x="685" y="270" width="80" height="80" rx="8" fill="#00000032"
                                      stroke="#000000"/>
                                <circle id="a" r="30" cx="725" cy="310" fill="#ff0000" stroke="#000000"
                                        stroke-width="3"></circle>
                            </g>
                        </g>
                    </svg>
                    <svg width={600} height={300} transform="translate(100,-70)">
                        <SvgModel modelJson={controller.toObject()} width={600} height={300}/>
                    </svg>
                    <p style={{
                        textAlign: "center",
                    }}>
                        We model the game controller as a Petri Net. Each button press is a transition.
                    </p>
                </div>
                <div style={{
                    borderRadius: "10px",
                    border: "1px solid black",
                }}>
                    <svg width={600} height={300} transform="translate(100,0)">
                        <SvgModel modelJson={konami.toObject()} width={600} height={300}/>
                    </svg>
                    <p style={{
                        textAlign: "center",
                    }}>
                        By connecting the buttons in the right order, we can model the Konami Code.
                        <br/>
                        Initial conditions are set to require the code to be entered with repeated presses.
                    </p>
                    <p style={{
                        textAlign: "center",
                    }}>


                        Try it out! <button style={{
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
                        cursor: "pointer",
                    }}

                                            onClick={(evt) => {
                                                modelToLink(konami).then((link) => {
                                                    window.location.href = link;
                                                });
                                            }}>
                        Open in App
                    </button>
                    </p>
                </div>
            </Paper>
            <BottomNav/>
            <FlowerBar/>
            <Footer/>
        </React.Fragment>
    )
}
