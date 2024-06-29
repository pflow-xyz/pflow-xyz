import Footer from "../components/Footer";
import React from "react";
import Header from "../components/Header";
import {SvgModel} from "../components/ReadonlyModel";
import {Paper} from "@mui/material";
import BottomNav from "../components/BottomNav";
import FlowerBar from "../components/FlowerBar";
import * as sources from "../lib/sources";
import {modelObjectToLink} from "../lib/pflow/export";


export default function DiningPhilosophers(): React.ReactElement {
    return (<React.Fragment>
            <Header/>
            <Paper sx={{
                marginBottom: "5px",
                padding: "20px",
                maxWidth: "900px",
                margin: "auto",
            }}>
                <h1> Dining Philosophers </h1>
                <p> A classic computer science problem illustrating deadlock scenarios. </p>
                <div style={{
                    alignContent: "center",
                    justifyContent: "center",
                    textAlign: "center",
                    margin: "auto",
                }}>
                    <img src={"/dining-philosophers-problem.png"} alt={"Dining Philosophers"} style={{width: "500px"}}/>
                </div>
                <div style={{
                    textAlign: "left",
                    padding: "20px",
                }}>
                    <p>
                        Five silent philosophers sit at a table around a bowl of noodles. A chopstick is placed between
                        each pair of adjacent philosophers.
                    </p>
                    <p>
                        Each philosopher must alternately think and eat. However, a philosopher can only eat when they
                        have
                        both left and right chopsticks.
                    </p>
                    <p>
                        After they finish eating, they put down the chopsticks and start thinking again.
                    </p>
                </div>
                <div style={{
                    border: "1px solid #000",
                    textAlign: "center",
                }}>
                    <h1> Dining Philosophers </h1>
                    <p> A good implementation where deadlock is not possible </p>
                    <svg width={900} height={900}>
                        <g transform="translate(-10,0)">
                            <SvgModel modelJson={sources.diningPhilosophers} width={920} height={800}/>
                        </g>
                    </svg>
                    <div style={{
                        position: "relative",
                        padding: "20px",
                        marginTop: "-15px"
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
                            cursor: "pointer",

                        }} onClick={() => {
                            return modelObjectToLink(sources.diningPhilosophers)
                                .then((link) => {
                                    window.location.href = link;
                                })
                                .catch((error) => {
                                    console.error({error})
                                });
                        }}>
                            Open in App
                        </button>
                    </div>
                </div>
                <div style={{
                    border: "1px solid #000",
                    textAlign: "center",
                }}>
                    <h1> Dining Philosophers </h1>
                    <p> A bad implementation that allows deadlock </p>
                    <svg width={900} height={900}>
                        <g transform="translate(-10,0)">
                            <SvgModel modelJson={sources.diningPhilosophersWithDeadlock} width={920} height={800}/>
                        </g>
                    </svg>
                    <div style={{
                        position: "relative",
                        padding: "20px",
                        marginTop: "-15px"
                    }}>
                        Try it out! &nbsp;
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
                            cursor: "pointer",
                        }} onClick={async () => {
                            try {
                                const link = await modelObjectToLink(sources.diningPhilosophersWithDeadlock);
                                window.location.href = link;
                            } catch (error) {
                                console.error({error});
                            }
                        }}>
                            Open in App
                        </button>
                    </div>
                </div>
            </Paper>
            <BottomNav/>
            <FlowerBar/>
            <Footer/>
        </React.Fragment>
    )
}
