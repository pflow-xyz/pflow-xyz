import {Fragment} from "react";
import IntroCard101 from "./IntroCard101";

export default function BottomBanner() {
    return (
        <Fragment>
            <div style={{
                position: "relative", // Add this
            }}>
                <div style={{
                    position: "absolute", // Add this
                    top: "50%", // Adjust as needed
                    left: "50%", // Adjust as needed
                    transform: "translate(-50%, -50%)", // Centers the card
                    zIndex: "1", // Ensure the card is above the video
                }}>
                    <IntroCard101/>
                </div>
                <video width="100%" height="100%" id="background-video" autoPlay loop muted poster="" style={{
                    zIndex: "-1",
                    overflow: "hidden",
                    right: "0",
                }}>
                    <source src="/snowcrash.mp4" type="video/mp4"/>
                </video>
            </div>
        </Fragment>
    )
}