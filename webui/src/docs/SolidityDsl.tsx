import {Container} from "@mui/material";
import Header from "../components/Header";
import React, {Fragment} from "react";
import Footer from "../components/Footer";
import BottomNav from "../components/BottomNav";
import FlowerBar from "../components/FlowerBar";

export default function SolidityDsl() {
    return (
        <Fragment>

            <Header/>
            <Container sx={{
                marginBottom: "5px",
                padding: "20px",
                maxWidth: "900px",
                margin: "auto",
                justifyContent: "center",
                textAlign: "center",
                alignContent: "center",
                minHeight: "90vh",
            }}>
                <h1>Solidity DSL</h1>
                <p>The Solidity DSL is a domain-specific language for writing smart contracts in Solidity.</p>
                <h2>Example</h2>
                <p>Here is an example of a Solidity DSL:</p>
            </Container>
            <BottomNav/>
            <FlowerBar/>
            <Footer/>
        </Fragment>
    )
}
