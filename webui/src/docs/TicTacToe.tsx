import Footer from "../components/Footer";
import React from "react";
import Header from "../components/Header";
import {SvgModel} from "../components/ReadonlyModel";
import {Paper} from "@mui/material";
import BottomNav from "../components/BottomNav";
import FlowerBar from "../components/FlowerBar";
import * as sources from "../lib/sources";
import {MetaModel} from "../lib/pflow";
import {Link} from "react-router-dom";
import {modelObjectToLink} from "../lib/pflow/export";

function gameState(taken: string[]): MetaModel {
    const metaModel = new MetaModel({
        editor: false,
    })
    metaModel.restartStream(true)
    let net = JSON.parse(JSON.stringify(sources.ticTacToe));
    for (let i = 0; i < taken.length; i++) {
        if (net.places[taken[i]]) {
            net.places[taken[i]].initial = 0;
        }
    }
    net.places["next"].initial = taken.length % 2;
    metaModel.loadJson(net)
    return metaModel
}

type GamePieceProps = {
    id: string
    x: string
    y: string
    taken: string[]
    showId?: boolean
}

function GamePiece(props: GamePieceProps): React.ReactElement {
    if (props.taken.includes(props.id)) {
        let label = props.showId ? props.id : props.id[0]
        return <foreignObject x={props.x} y={props.y} width="100" height="100" transform="translate(-20,-80)">
            <p style={{
                top: props.y,
                left: props.x,
                fontSize: "40px",
                color: "black",
            }}>{label}</p>
        </foreignObject>
    }
    return <React.Fragment/>
}

type GameBoardProps = {
    taken: string[]
    showId?: boolean
}

function GameBoard({taken, showId}: GameBoardProps): React.ReactElement {
    return <svg id="board" width="500" height="400" transform={"translate(0,-50)"}>
        <rect id="00" x="100" y="100" width="100" height="100" fill="#ffffff" stroke="#000000"></rect>
        <rect id="01" x="200" y="100" width="100" height="100" fill="#ffffff" stroke="#000000"></rect>
        <rect id="02" x="300" y="100" width="100" height="100" fill="#ffffff" stroke="#000000"></rect>

        <rect id="10" x="100" y="200" width="100" height="100" fill="#ffffff" stroke="#000000"></rect>
        <rect id="11" x="200" y="200" width="100" height="100" fill="#ffffff" stroke="#000000"></rect>
        <rect id="12" x="300" y="200" width="100" height="100" fill="#ffffff" stroke="#000000"></rect>

        <rect id="20" x="100" y="300" width="100" height="100" fill="#ffffff" stroke="#000000"></rect>
        <rect id="21" x="200" y="300" width="100" height="100" fill="#ffffff" stroke="#000000"></rect>
        <rect id="22" x="300" y="300" width="100" height="100" fill="#ffffff" stroke="#000000"></rect>

        <GamePiece id="O00" x="122" y="175" showId={showId} taken={taken}/>
        <GamePiece id="O01" x="222" y="175" showId={showId} taken={taken}/>
        <GamePiece id="O02" x="322" y="175" showId={showId} taken={taken}/>

        <GamePiece id="X00" x="122" y="175" showId={showId} taken={taken}/>
        <GamePiece id="X01" x="222" y="175" showId={showId} taken={taken}/>
        <GamePiece id="X02" x="322" y="175" showId={showId} taken={taken}/>

        <GamePiece id="O10" x="122" y="275" showId={showId} taken={taken}/>
        <GamePiece id="O11" x="222" y="275" showId={showId} taken={taken}/>
        <GamePiece id="O12" x="322" y="275" showId={showId} taken={taken}/>

        <GamePiece id="X10" x="122" y="275" showId={showId} taken={taken}/>
        <GamePiece id="X11" x="222" y="275" showId={showId} taken={taken}/>
        <GamePiece id="X12" x="322" y="275" showId={showId} taken={taken}/>

        <GamePiece id="O20" x="122" y="375" showId={showId} taken={taken}/>
        <GamePiece id="O21" x="222" y="375" showId={showId} taken={taken}/>
        <GamePiece id="O22" x="322" y="375" showId={showId} taken={taken}/>

        <GamePiece id="X20" x="122" y="375" showId={showId} taken={taken}/>
        <GamePiece id="X21" x="222" y="375" showId={showId} taken={taken}/>
        <GamePiece id="X22" x="322" y="375" showId={showId} taken={taken}/>
    </svg>
}

export default function TicTacToe(): React.ReactElement {

    const elevation = 5;

    return (<React.Fragment>
            <Header/>
            <Paper elevation={elevation} sx={{
                marginBottom: "5px",
                padding: "20px",
                maxWidth: "900px",
                margin: "auto",
                textAlign: "center",
            }}>
                <h1>TicTacToe</h1>
                <p> A game of TicTacToe - This model shows available moves for a given state.<br/> Fireable transitions are hilighted in green.</p>
                <GameBoard taken={["X00", "X01", "X02", "X10", "X11", "X12", "X20", "X21", "X22"]} showId={true}/>
                <p style={{
                    maxWidth: "600px",
                    margin: "auto",
                }}>
                    The game board is represented as a 3x3 grid. Each square can be taken by either player X or player
                    O.
                    The squares are labeled with the player and the square coordinates. For example, "X11" is player X
                    taking the center square.
                </p>
                <svg width={900} height={600}>
                    <g transform="translate(120,-30)">
                        <SvgModel metaModel={gameState([])} width={900} height={900}/>
                    </g>
                </svg>
                <GameBoard taken={["X11"]} showId={false}/>
                <p>
                    Move 1: Player X takes the center square. "X11"
                </p>
                <svg width={900} height={600}>
                    <g transform="translate(120,-30)">
                        <SvgModel metaModel={gameState(["11"])} width={900} height={900}/>
                    </g>
                </svg>
                <GameBoard taken={["X11", "O00"]} showId={false}/>
                <p>
                    Move 2: Player O takes the top left square. "O00"
                </p>
                <svg width={900} height={600}>
                    <g transform="translate(120,-30)">
                        <SvgModel metaModel={gameState(["11", "00"])} width={900} height={900}/>
                    </g>
                </svg>
                <p style={{
                    maxWidth: "600px",
                    margin: "auto",
                }}>
                    Notice that the Petri-net is enforcing some of the rules of TicTacToe.
                    Namely, that players must take turns and that a square can only be taken once.
                    Detecting a win condition is outside the scope of the Petri-net model.
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

                onClick={async (evt) => {
                    try {
                        const link = await modelObjectToLink(sources.ticTacToe);
                        window.location.href = link;
                    } catch (error) {
                        console.error({error});
                    }
                }}>
                    Open in App
                </button>
                </p>
                <p>
                    Read more about the <Link to="/docs-metamodel-overview">Metamodel</Link> Abstract Contract.
                </p>
            </Paper>
            <BottomNav/>
            <FlowerBar/>
            <Footer/>
        </React.Fragment>
    )
}
