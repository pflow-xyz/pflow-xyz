import {Fragment} from "react";
import TitleCard from "./TitleCard";

export default function BottomBanner() {
    return (
        <Fragment>
            <div style={{
                position: "relative",
                display: "flex"
            }}>
                <div style={{
                    position: "absolute",
                    top: "50%",
                    left: "50%",
                    transform: "translate(-50%, -50%)",
                    zIndex: "1",
                }}>
                    <TitleCard/>
                </div>
                <video width="100%" height="100%" id="background-video" autoPlay loop muted poster="" style={{
                    zIndex: "-1",
                    overflow: "hidden",
                    right: "0",
                }}>
                    <source src="/p-flower.mp4" type="video/mp4"/>
                </video>
            </div>
        </Fragment>
    )
}