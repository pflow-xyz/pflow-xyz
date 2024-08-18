import {Fragment} from "react";
import {Link} from "react-router-dom";
import LogoCard from "./LogoCard";

export default function BottomNav() {
    return (
        <Fragment>
            <div style={{
                backgroundColor: "white",
            }}>

                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1440 350">
                    <line x1="0" y1="0" x2="1440" y2="0" style={{
                        stroke: "black",
                        strokeWidth: "2",
                    }}/>
                    <foreignObject x="0" y="-20" width="100%" height="100%">
                        <div style={{
                            display: "flex",
                            height: "100%",
                            padding: "2em",
                        }}>
                            <div style={{
                                display: "flex",
                                padding: "2em",
                            }}>
                                <div style={{
                                    border: "1px solid black",
                                    paddingLeft: "1em",
                                    paddingRight: "1em",
                                    marginBottom: "1em",
                                    borderRadius: "10px",
                                    minWidth: "150px",
                                }}>
                                    <Link to={"/"}><LogoCard/> </Link>
                                </div>
                            </div>
                        </div>
                    </foreignObject>
                    <foreignObject x="190" y="-10" width="100%" height="100%">
                        <div style={{
                            padding: "3em",
                        }}>
                            <div style={{}}>
                                <div style={{}}>
                                    <ul>
                                        <li>
                                            <Link to="/app" style={{
                                                color: "black",
                                            }}>
                                                Editor-App
                                            </Link>
                                        </li>
                                        <li>
                                            <a href={"https://app.pflow.xyz"}
                                               style={{color: "black",}}
                                            >Explorer-Dapp </a>
                                        </li>
                                        <li>
                                            <Link to="/docs" style={{color: "black",}}>
                                                Documentation
                                            </Link>
                                        </li>
                                        <ul>
                                            <li>
                                                <Link to="/app-manual" style={{
                                                    color: "black",
                                                }}>
                                                    Manual
                                                </Link>
                                            </li>
                                            <li>
                                                <Link to="/docs-petri-net-101" style={{color: "black",}}>
                                                    Petri-Net 101
                                                </Link>
                                            </li>
                                            <li>
                                                <Link to="/docs-model-types" style={{color: "black",}}>
                                                    Model Types
                                                </Link>
                                            </li>
                                            <li>
                                                <Link to="/docs-metamodel-overview" style={{color: "black",}}>
                                                    Metamodel
                                                </Link>
                                            </li>
                                        </ul>
                                        <li>
                                            <Link to="/examples" style={{color: "black",}}>
                                                Examples
                                            </Link>
                                        </li>
                                        <ul>
                                            <li>
                                                <Link to="/examples-dining-philosophers" style={{color: "black",}}>
                                                    Dining Philosophers
                                                </Link>
                                            </li>
                                            <li>
                                                <Link to="/examples-tic-tac-toe" style={{color: "black",}}>
                                                    Tic Tac Toe
                                                </Link>
                                            </li>
                                            <li>
                                                <Link to="/examples-konami-code" style={{color: "black",}}>
                                                    Konami Code
                                                </Link>
                                            </li>
                                            <li>
                                                <Link to="/examples-h2-combustion" style={{color: "black",}}>
                                                    2H₂+2O₂&nbsp;-&gt;&nbsp;2H₂O Combustion
                                                </Link>
                                            </li>
                                        </ul>
                                    </ul>
                                </div>
                            </div>
                        </div>
                    </foreignObject>
                </svg>
            </div>
        </Fragment>
    )

}