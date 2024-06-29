import Footer from "../components/Footer";
import React from "react";
import Header from "../components/Header";
import {Paper} from "@mui/material";
import BottomNav from "../components/BottomNav";
import FlowerBar from "../components/FlowerBar";
import {
    Adjust,
    ArrowRightAlt,
    CheckBoxOutlineBlank,
    ClearAll,
    CopyAll,
    ControlCamera,
    Delete,
    Download,
    DragHandle,
    Image,
    PlayCircleOutlined,
    RadioButtonUnchecked,
    Redo,
    Share,
    StopCircleOutlined,
    Undo,
    UploadFile
} from "@mui/icons-material";
import CameraIcon from "@mui/icons-material/Camera";
import ConnectMetamask from "../components/editor/ConnectMetamask";
import {MetaModel} from "../lib/pflow";
import ImportContract from "../components/editor/ImportContract";
import SourceCode from "../components/SourceCode";


export default function AppManual(): React.ReactElement {

    return (<React.Fragment>
            <Header/>
            <Paper sx={{
                marginBottom: "5px",
                padding: "30px",
                maxWidth: "870px",
                margin: "auto",
                justifyContent: "center",
                alignContent: "center",
                minHeight: "20vh",
            }}>
                <h1>Manual</h1>
                <p> This is the manual for the application. </p>
                <ul>
                    <li>
                        <a href="#editor-basics">Editor Basics</a> Identify tools in the editor.
                    </li>
                    <li>
                        <a href="#share-model">Hot Keys</a> Keyboard shortcuts for the editor.
                    </li>
                    <li>
                        <a href="#solidity-basics">Import From Solidity</a> Import a model from a deployed contract.
                    </li>
                    <li>
                        <a href="#share-model">Share Model</a> Export a model as a markdown image.
                    </li>
                </ul>
                <h2 id="editor-basics">Editor Basics</h2>
                <table style={{
                    width: "100%",
                    border: "1px solid #E0E0E0",
                    borderCollapse: "collapse",
                    textAlign: "left",
                    fontSize: "14px",
                }}>
                    <tbody>
                    <tr>
                        <th>Icon</th>
                        <th>HotKey(s)</th>
                        <th>Action</th>
                        <th>Description</th>
                    </tr>
                    <tr>
                        <td><ControlCamera/></td>
                        <td>0,1,Esc</td>
                        <td>Select</td>
                        <td>
                            Select an element in the model. <br/>
                            Click on an empty space to deselect.
                        </td>
                    </tr>
                    <tr>
                        <td><CameraIcon/></td>
                        <td>2,s</td>
                        <td>Snapshot</td>
                        <td>
                            Populate the canvas with a snapshot of the model.<br/>
                            (not interactive)
                        </td>
                    </tr>
                    <tr>
                        <td><PlayCircleOutlined/></td>
                        <td>3,x</td>
                        <td>Run</td>
                        <td>Run the model interactively.</td>
                    </tr>
                    <tr>
                        <td><StopCircleOutlined/></td>
                        <td>3,x,Esc</td>
                        <td>Stop</td>
                        <td>Stop the running model</td>
                    </tr>
                    <tr>
                        <td><RadioButtonUnchecked/></td>
                        <td>4,p</td>
                        <td>Place</td>
                        <td>
                            Add a place element when clicked on the canvas.
                        </td>
                    </tr>
                    <tr>
                        <td><CheckBoxOutlineBlank/></td>
                        <td>5,t</td>
                        <td>Transition</td>
                        <td>
                            Add a transition element when clicked on the canvas.
                        </td>
                    </tr>
                    <tr>
                        <td><ArrowRightAlt/></td>
                        <td>6,a</td>
                        <td>Arc</td>
                        <td>
                            Select a place or transition <br/> and then click on another place or transition to create
                            an arc.
                        </td>
                    </tr>
                    <tr>
                        <td><Adjust/></td>
                        <td>7,k</td>
                        <td>Token</td>
                        <td>
                            Add a token to a place or transition. <br/>
                            Right click to remove a token.
                        </td>
                    </tr>
                    <tr>
                        <td><Delete/></td>
                        <td>8,d</td>
                        <td>Delete</td>
                        <td>
                            Click on an element to delete it. <br/>
                            Click on the midpoint of an arc to delete it.
                        </td>
                    </tr>
                    <tr>
                        <td><DragHandle/></td>
                        <td>9</td>
                        <td>Resize</td>
                        <td>
                            Toggles full page / half page view.
                        </td>
                    </tr>
                    </tbody>
                </table>
                <h2 id="share-model">Hot Keys</h2>
                <table style={{
                    width: "100%",
                    border: "1px solid #E0E0E0",
                    borderCollapse: "collapse",
                    textAlign: "left",
                    fontSize: "14px",
                }}>
                    <tbody>
                    <tr>
                        <th>HotKey(s)</th>
                        <th>Action</th>
                        <th>Description</th>
                    </tr>
                    <tr>
                        <td>←,↑,→,↓</td>
                        <td>Move</td>
                        <td>
                            Moves the selected element <br/>in the direction of the arrow key.
                        </td>
                    </tr>
                    <tr>
                        <td>[tab]</td>
                        <td>Next</td>
                        <td>
                            Selects the next element<br/> in the model.
                        </td>
                    </tr>
                    <tr>
                        <td>Shift+[tab]</td>
                        <td>Next</td>
                        <td>
                            Selects the previous element<br/> in the model.
                        </td>
                    </tr>
                    <tr>
                        <td>[ctl]+z,[cmd]+z</td>
                        <td>Undo</td>
                        <td>
                            Undo the last action.
                        </td>
                    </tr>
                    <tr>
                        <td>[ctl]+y,[cmd]+y</td>
                        <td>Redo</td>
                        <td>
                            Replay the last action from the undo stack.
                        </td>
                    </tr>
                    </tbody>
                </table>
                <h2> Menu Actions </h2>
                <table style={{
                    width: "100%",
                    border: "1px solid #E0E0E0",
                    borderCollapse: "collapse",
                    textAlign: "left",
                    fontSize: "14px",
                }}>
                    <tbody>
                    <tr>
                        <th>Icon</th>
                        <th>Action</th>
                        <th>Description</th>
                    </tr>
                    <tr>
                        <td><UploadFile/></td>
                        <td>[File] Import Json</td>
                        <td>
                            Import a model from a JSON file.
                        </td>
                    </tr>
                    <tr>
                        <td><Download/></td>
                        <td>[File] Export Json</td>
                        <td>
                            Export the model to a JSON file.
                        </td>
                    </tr>
                    <tr>
                        <td><CopyAll/></td>
                        <td>[File] Export Solidity</td>
                        <td>
                            Export model to Solidity code.
                        </td>
                    </tr>
                    <tr>
                        <td><Image/></td>
                        <td>[File] Snapshot Png</td>
                        <td>
                            Export a snapshot of the model to a PNG file.
                        </td>
                    </tr>
                    <tr>
                        <td><Undo/></td>
                        <td>[Edit] Undo Change</td>
                        <td>
                            Undo the last change.
                        </td>
                    </tr>
                    <tr>
                        <td><Redo/></td>
                        <td>[Edit] Redo Change</td>
                        <td>
                            Replay the last change from the undo stack.
                        </td>
                    </tr>
                    <tr>
                        <td><ClearAll/></td>
                        <td>[Edit] Clear All</td>
                        <td>
                            Remove all elements from the model.
                        </td>
                    </tr>
                    </tbody>
                </table>
                <h2 id="solidity-basics">Import From Solidity</h2>
                <table style={{
                    width: "100%",
                    border: "1px solid #E0E0E0",
                    textAlign: "left",
                    fontSize: "14px",

                }}>
                    <table>
                        <tr>
                            <td>
                                <ConnectMetamask metaModel={(new MetaModel({editor: false}))}/>
                            </td>
                            <td>
                                Connect to the Ethereum network to import a model.
                            </td>
                        </tr>
                        <tr>
                            <td>
                                <ImportContract metaModel={(new MetaModel({editor: false}))}/>
                            </td>
                            <td>
                                Import a model from a deployed contract, converting it to Json.
                            </td>
                        </tr>
                    </table>
                </table>
                <h2>Share Model</h2>
                <table style={{
                    width: "100%",
                    border: "1px solid #E0E0E0",
                    textAlign: "left",
                    fontSize: "14px",

                }}>
                    <tbody>
                    <tr>
                        <td>
                            <Share/>
                        </td>
                        <td>
                            &nbsp;&nbsp;Click share icon to export the model as a markdown image.
                        </td>
                        <td>
                            Data is hosted on the pflow.dev server.
                        </td>
                    </tr>
                    <tr>
                        <td colSpan={3} rowSpan={2}>
                            <SourceCode id={"markdown-shared"}
                                        code={`[![pflow](https://pflow.dev/img/zb2rhbwjreyoKLR4C7C6uUFco1nJMBiovNqbXGcuEmoBRDXfB.svg)](https://pflow.dev/p/zb2rhbwjreyoKLR4C7C6uUFco1nJMBiovNqbXGcuEmoBRDXfB/)`}
                                        language={"JavaScript"}/>
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
