import Footer from "../components/Footer";
import React from "react";
import Header from "../components/Header";
import {Link} from "react-router-dom";
import {Paper} from "@mui/material";
import BottomNav from "../components/BottomNav";
import FlowerBar from "../components/FlowerBar";


export default function Examples(): React.ReactElement {

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
                <h1>Examples</h1>
                <p>Welcome to the examples.</p>
                <table style={{
                    width: "100%",
                    textAlign: "center",
                }}>
                    <tbody>
                    <tr>
                        <td>
                            <Link to="/examples-dining-philosophers">Dining Philosophers</Link>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <Link to="/examples-tic-tac-toe">Tic Tac Toe</Link>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <Link to="/examples-konami-code">Konami Code</Link>
                        </td>
                    </tr>
                    <tr>
                        <td>
                            <Link to="/examples-h2-combustion">H₂+O₂ Combustion</Link>
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
