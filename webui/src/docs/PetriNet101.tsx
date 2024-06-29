import React from "react";
import Header from "../components/Header";
import {SvgModel} from "../components/ReadonlyModel";
import {Card, Paper} from "@mui/material";
import * as sources from "../lib/sources";
import BottomNav from "../components/BottomNav";
import FlowerBar from "../components/FlowerBar";
import Footer from "../components/Footer";
import {MetaModel} from "../lib/pflow";
import {compressBrotliEncode} from "../lib/pflow/compression";
import SourceCode from "../components/SourceCode";

async function getTestModelLink() {
    const m = new MetaModel({
        editor: false,
    });
    await m.loadJson(sources.testModel);
    m.zippedJson = await compressBrotliEncode(m.toJson());
    return "/?z=" + m.zippedJson;
}

let testModelLink: string = "";

getTestModelLink().then((link) => {
    testModelLink = link;
})

export default function PetriNet101(): React.ReactElement {

    return (<React.Fragment>
            <Header/>
            <Paper sx={{
                marginBottom: "5px",
                padding: "20px",
                maxWidth: "900px",
                margin: "auto",
            }}>
                <h1> Petri Net 101 </h1>
                <p style={{
                    textAlign: "left",
                    maxWidth: "800px",
                    padding: "20px",
                }}>
                    Petri nets are a mathematical modeling language used to describe systems of interacting components.
                    This document provides an introduction to the basic elements of Petri nets.
                </p>
                <Card sx={{
                    padding: "20px",
                    marginBottom: "10px",
                    border: "1px solid #000",
                }}>
                    <h2>Place</h2>
                    <svg transform={"translate(0, -5)"} width={150} height={80}>
                        <SvgModel modelJson={sources.basicPlace} width={150} height={80}/>
                    </svg>
                    <ul>
                        <li>
                            A place is represented by a circle.
                        </li>
                        <li>
                            A place is a container for tokens.
                        </li>
                        <li>
                            It can hold any number of tokens.
                        </li>
                        <li>
                            It has a x/y position
                            <SourceCode id={"position"}
                                        code={"    \"p1\": {  \"x\": 130, \"y\": 207 }\n"}
                                        language={"JavaScript"}/>
                        </li>
                        <li>
                            It can have a capacity limit.
                            <SourceCode id={"capacity"}
                                        code={"    \"p1\": {  \"capacity\": 1, \"x\": 130, \"y\": 207 }\n"}
                                        language={"JavaScript"}/>
                        </li>
                        <li>
                            It has a minimum of 0 tokens, and can contain an initial value (&gt;0).
                            <SourceCode id={"capacity"}
                                        code={"    \"p1\": {  \"initial\": 1, \"x\": 130, \"y\": 207 }\n"}
                                        language={"JavaScript"}/>
                        </li>
                    </ul>
                </Card>
                <Card sx={{
                    padding: "20px",
                    marginBottom: "10px",
                    border: "1px solid #000",
                }}>
                    <h2>Token</h2>
                    <svg transform={"translate(0, -5)"} width={150} height={80}>
                        <SvgModel modelJson={sources.basicPlaceToken} width={150} height={80}/>
                    </svg>
                    <ul>
                        <li>
                            Tokens are abstract units of information.
                        </li>
                        <li>
                            Tokens can move between places.
                        </li>
                        <li>
                            Token counts cannot go below 0.
                        </li>
                    </ul>
                    <div style={{
                        borderRadius: "10px",
                        border: "1px solid #000",
                    }}>
                        <SvgModel width={250} height={190} modelJson={sources.placeElement}/>
                        <ul>
                            <li>
                                A token is represented by a dot if it is = 1.
                            </li>
                            <li>
                                Or, an integer if it is &gt;1.
                            </li>
                        </ul>
                    </div>
                </Card>
                <Card sx={{
                    padding: "20px",
                    marginBottom: "10px",
                    border: "1px solid #000",
                }}>
                    <h2>Transition</h2>
                    <SvgModel modelJson={sources.basicTransition} width={150} height={80}/>
                    <ul>
                        <li>
                            A transition is represented by a square.
                        </li>
                        <li>
                            A transition is a state change.
                        </li>
                        <li>
                            It can be 'fired' to change the state of the system.
                        </li>
                    </ul>
                    <div style={{
                        borderRadius: "10px",
                        border: "1px solid #000",
                    }}>
                        <SvgModel modelJson={sources.transitionInputEnabled} width={270} height={150}/>
                        <SvgModel modelJson={sources.transitionInputDisabled} width={270} height={150}/>
                        <ul>
                            <li>
                                A transition can have input and output arcs.
                            </li>
                            <li>
                                A transition is disabled if any input or output arcs are disabled.
                            </li>
                            <li>
                                A transition can be disabled due to insufficient tokens in a place and/or if an
                                inhibitor
                                arc has an unsatisfied condition.
                            </li>
                        </ul>
                    </div>
                </Card>
                <Card sx={{
                    padding: "20px",
                    marginBottom: "10px",
                    border: "1px solid #000",
                }}>
                    <h2>Arc</h2>
                    <svg transform="translate(40, 0)" width={250} height={90}>
                        <SvgModel modelJson={sources.basicArc} width={150} height={70}/>
                    </svg>
                    <ul>
                        <li>
                            An arc is a connection between a place and a transition.
                        </li>
                        <li>
                            It can be either input or output.
                        </li>
                        <li>
                            A <u>standard arc</u> is represented by a line with an arrow.
                        </li>
                    </ul>
                    <div style={{
                        borderRadius: "10px",
                        border: "1px solid #000",
                    }}>

                        <svg transform={"translate(-40, -30)"} width={250} height={120}>
                            <SvgModel width={250} height={120} modelJson={sources.readArcEnabled}/>
                        </svg>
                        <svg transform={"translate(-40, -30)"} width={250} height={120}>
                            <SvgModel width={250} height={120} modelJson={sources.readArcDisabled}/>
                        </svg>
                        <ul>
                            <li>
                                <u>Read arcs</u> begin with a transition and end with a place.
                            </li>
                            <li>
                                It is enabled if the place has tokens &gt;= it's weight.
                            </li>
                            <li>
                                It is disabled if the place has tokens &lt; it's weight.
                            </li>
                        </ul>
                    </div>
                    <ul>
                        <li>
                            A <u>read arc</u> (above) or <u>inhibitor arc</u> (below) are each represented by a line
                            with a
                            circle.
                        </li>
                    </ul>
                    <div style={{
                        borderRadius: "10px",
                        border: "1px solid #000",
                    }}>
                        <svg transform={"translate(-40, -30)"} width={250} height={120}>
                            <SvgModel width={250} height={120} modelJson={sources.inhibitorArcEnabled}/>
                        </svg>
                        <svg transform={"translate(-40, -30)"} width={250} height={120}>
                            <SvgModel width={250} height={120} modelJson={sources.inhibitorArcDisabled}/>
                        </svg>
                        <ul>
                            <li>
                                <u>Inhibitor Arcs</u> begin with a place and end with a transition.
                            </li>
                            <li>
                                It is enabled if the place has tokens &lt; it's weight.
                            </li>
                            <li>
                                It is disabled if the place has tokens &gt;= it's weight.
                            </li>
                        </ul>
                    </div>
                </Card>
                <Card>
                    <div style={{
                        padding: "20px",
                        border: "1px solid #000",
                    }}>
                        <h2>Put it all together</h2>
                        <svg transform={"translate(0, -50)"} width={500} height={350}>
                            <SvgModel width={500} height={350} modelJson={sources.testModelWithState([0])}/>
                        </svg>
                        <p>
                            This is a simple Petri Net model with 1 place, 4 transitions, and 4 arcs.
                        </p>
                        <ul>
                            <li>
                                In this state, txn0, and txn3 are enabled.
                            </li>
                            <ul>
                                <li>
                                    txn0 is enabled because it can add tokens to place0 until capacity is reached.
                                </li>
                                <li>
                                    txn3 is enabled because it's inhibitor arc is satisfied.
                                </li>
                            </ul>
                            <li>
                                NOTE: that txn2, and txn3 are not connected to any standard arcs
                            </li>
                            <ul>
                                <li>
                                    This means they can be fired any number of times as long as they are enabled.
                                </li>
                                <li>
                                    This is by design, since <u>read arcs</u> and <u>inhibitor arcs</u> do not consume
                                    or produce tokens.
                                </li>
                            </ul>
                        </ul>
                        <div style={{
                            padding: "20px",
                            border: "1px solid #000",
                            marginBottom: "5px",
                        }}>
                            <SvgModel width={500} height={350} modelJson={sources.testModelWithState([1])}/>
                            <p>
                                1. After triggering txn0 - the place has 1 token.
                            </p>
                        </div>
                        <div style={{
                            padding: "20px",
                            border: "1px solid #000",
                            marginBottom: "5px",
                        }}>
                            <SvgModel width={500} height={350} modelJson={sources.testModelWithState([2])}/>
                            <p>
                                2. Triggering txn0 again increments to 2
                            </p>
                        </div>
                        <div style={{
                            padding: "20px",
                            border: "1px solid #000",
                            marginBottom: "5px",
                        }}>
                            <SvgModel width={500} height={350} modelJson={sources.testModelWithState([3])}/>
                            <p>
                                3. Triggering txn0 a third time increments to 3
                                <ul>
                                    <li>
                                        txn0 is now disabled.
                                    </li>
                                    <ul>
                                        <li>
                                            txn0 is disabled the capacity of place0 is reached.
                                        </li>
                                    </ul>
                                    <li>
                                        txn1 is now enabled.
                                    </li>
                                    <ul>
                                        <li>
                                            txn1 is enabled because the token weight of the arc from place0 is
                                            satisfied.
                                        </li>
                                    </ul>
                                    <li>
                                        txn2 is now enabled.
                                    </li>
                                    <ul>
                                        <li>
                                            txn2 is enabled because it has an read arc from place0 that is satisified.
                                        </li>
                                    </ul>
                                </ul>
                            </p>
                        </div>
                        <div style={{
                            padding: "20px",
                            border: "1px solid #000",
                            marginBottom: "5px",
                        }}>
                            <SvgModel width={500} height={350} modelJson={sources.testModelWithState([0])}/>
                            <p>
                                4. Triggering txn1 decrements place0 to 0
                            </p>
                            <ul>
                                <li>
                                    txn3 is now enabled.
                                </li>
                                <ul>
                                    <li>
                                        txn3 is enabled because it has an inhibitor arc from place0 that is now
                                        satisified.
                                    </li>
                                </ul>

                            </ul>
                        </div>
                        <div style={{
                            border: "1px solid #000",
                            textAlign: "center",
                        }}>
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
                            <div style={{
                                position: "relative",
                                padding: "20px",
                                marginTop: "-15px"
                            }}>
                                Try it out! <a href={testModelLink}>
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

                                }}>
                                    Open in App
                                </button>
                            </a>
                            </div>
                        </div>
                    </div>
                </Card>
            </Paper>
            <BottomNav/>
            <FlowerBar/>
            <Footer/>
        </React.Fragment>
    )
}
