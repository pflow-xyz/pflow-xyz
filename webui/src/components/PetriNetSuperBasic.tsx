import Grid2 from "@mui/material/Unstable_Grid2";
import {Card, Typography} from "@mui/material";
import SuperModel from "./SuperModel";
import * as sources from "../lib/sources";

type SuperCardProps = {
    title: string
    jsonModel: string | object;
}

function SuperCard(props: SuperCardProps) {
    return <Card sx={{
        borderRadius: "10px",
        background: "#242425",
        border: "1px solid #EBFF00",
        color: "#FFFFFF",
        padding: "1em",
        margin: "1em",
    }}>
        <Typography sx={{
            textAlign: "center",
            fontSize: "1.5em",
        }}>
            {props.title}
        </Typography>
        <SuperModel width={120} height={100} modelJson={props.jsonModel}/>
    </Card>
}

export default function PetriNetSuperBasic() {
    return (
        <Grid2 container spacing={2} sx={{
            background: "transparent",
            minHeight: "20em",
            padding: "3em",
            justifyContent: "center",
        }}>
            <Card sx={{
                borderRadius: "10px",
                background: "#242425",
                maxWidth: "600px",
                color: "#FFFFFF",
                padding: "2em",
            }}>
                <Typography sx={{
                    textAlign: "center",
                    fontSize: "2em",
                }}>
                    What is a <u>Petri-net?</u>
                </Typography>
                <Typography sx={{
                    fontFamily: "GT_America-Light", // FIXME make it IBM
                    fontSize: "1.5em",
                    padding: "2em",
                }}>
                    Pflow uses Petri-nets for visual description.
                </Typography>
                <Grid2 container spacing={2} sx={{
                    justifyContent: "center",
                    padding: "2em",
                }}>
                    <SuperCard title="Place" jsonModel={sources.basicPlace}/>
                    <SuperCard title="Transition" jsonModel={sources.basicTransition}/>
                    <SuperCard title="Token" jsonModel={sources.basicPlaceToken}/>
                    <SuperCard title="Arc" jsonModel={sources.basicArc}/>
                </Grid2>
                <Typography sx={{
                    fontFamily: "GT_America-Light", // FIXME make it IBM
                    fontSize: "1.5em",
                    padding: "2em",
                }}>
                    These primitives <u>compose</u> to create models.
                </Typography>
                <div style={{
                    border: "1px solid #EBFF00",
                    borderRadius: "10px",
                    display: "flex",
                    justifyContent: "center",
                    padding: "1em",
                }}>
                    <img width="80%" src="/dining-philosophers.svg" alt="placeholder"/>
                </div>
                <Typography sx={{
                    fontFamily: "GT_America-Light", // FIXME make it IBM
                    fontSize: "1.5em",
                    padding: "2em",
                }}>
                    Models represent <u>systems of interacting components</u>.
                    Tokens represent information & resources flowing through the system.
                </Typography>
            </Card>
        </Grid2>
    )
}