import Footer from "./components/Footer";
import React from "react";
import Header from "./components/Header";
import {Paper} from "@mui/material";
import BottomNav from "./components/BottomNav";
import Button from "@mui/material/Button";
import FlowerBar from "./components/FlowerBar";


export default function Suggest(): React.ReactElement {

    return (<React.Fragment>
            <Header/>
            <Paper sx={{
                marginBottom: "5px",
                padding: "20px",
                maxWidth: "900px",
                margin: "auto",
                justifyContent: "center",
                alignContent: "center",
                minHeight: "50vh",
            }}>
                <div style={{
                    float: "right",
                }}>
                    <svg width="291" height="302" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <g transform="translate(40,80)">
                            <path
                                d="M63.5696 116.717H52.9743V106.14H42.3979V95.5449H31.8027H21.2263H10.6311H0.0546875V106.14V116.717H10.6311V127.293H21.2263V137.888H31.8027H42.3979H52.9743H63.5696V127.293V116.717Z"
                                fill="black"/>
                            <path
                                d="M63.5696 0.281982H52.9743H42.3979V10.8584V21.4536H52.9743H63.5696V10.8584V0.281982Z"
                                fill="black"/>
                            <path d="M148.237 21.4536V10.8584V0.281982H137.661H127.065V10.8584V21.4536H137.661H148.237Z"
                                  fill="black"/>
                            <path
                                d="M105.913 137.888V84.9685H127.084V63.7969H148.256V42.6252H127.084V21.4536H105.913V0.281982H84.7412V21.4536H63.5696V42.6252H42.3979V63.7969H63.5696V84.9685H84.7412V137.888H63.5696V159.06H84.7412V180.231H42.3979V201.403H148.256V180.231H105.913V159.06H127.084V137.888H105.913ZM84.7412 53.2016V42.6252H105.913V63.7969H84.7412V53.2016Z"
                                fill="black"/>
                            <path
                                d="M180.004 95.5449H169.409H158.832H148.237V106.14H137.661V116.717H127.065V127.293V137.888H137.661H148.237H158.832H169.409V127.293H180.004V116.717H190.58V106.14V95.5449H180.004Z"
                                fill="black"/>
                        </g>
                    </svg>
                </div>


                <div style={{
                    padding: "20px",
                    float: "right",
                }}>
                    <h1>Hello!</h1>
                    <b>updated 05/2024</b>
                    <p>
                        We are currently <button style={{
                        border: "1px solid black",
                        borderRadius: "10px",
                    }}>
                        seeking partners
                    </button>
                        &nbsp;to grow this project.
                    </p>
                    <p>
                        If you are interested in collaborating, please reach out.
                    </p>
                    <p>
                        <b>Twitter</b> <a href="https://twitter.com/@stackdump_eth">@stackdump_eth</a>
                    </p>
                    <p>
                        <b>Email</b> <a href="mailto:myork@stackdump.com">myork@stackdump.com</a>
                    </p>
                    <p>
                        <b>Encrypted Message</b> <a
                        href="https://flowcrypt.com/me/stackdump">https://flowcrypt.com/me/stackdump </a>
                    </p>
                    <p>
                        Help us improve by &nbsp;
                        <Button style={{
                            borderRadius: "10px",
                            background: "#EBFF00",
                            color: "black",
                            border: "1px solid black",
                            textDecoration: "none",
                        }}>
                            <a target="_blank"
                               href="https://docs.google.com/forms/d/e/1FAIpQLSfpRhVvxCyauDQVU2eOftx9EzD-l4-uXWoj4yFN6RjNvHnv1Q/viewform?usp=pp_url&entry.565725726=Don't+know&entry.1334143474=I+don't+code&entry.1167941346=Never"
                               style={{
                                   textDecoration: "none",
                                   color: "inherit",
                               }}
                            >
                                Taking A short Survey
                            </a>
                        </Button>
                    </p>
                </div>
            </Paper>
            <BottomNav/>
            <FlowerBar/>
            <Footer/>
        </React.Fragment>
    )
}
