import {Card, Typography} from "@mui/material";

export default function TitleCard() {
    return (
        <Card sx={{
            borderRadius: "10px",
            border: "2px solid gray",
            maxWidth: "380px",
            color: "white",
            bgcolor: "#1C1C1D",
            padding: "1em",
            textAlign: "center",
        }}>
            <Typography sx={{
                fontFamily: "GT_America-Light",
                fontSize: "30px",
                fontWeight: "600",
            }}>
                Pflow is a&nbsp;
                <Typography sx={{
                    display: "inline",
                    bgcolor: "#EBFF00",
                    color: "black",
                    borderRadius: "10px",
                    border: "3px solid #EBFF00",
                    fontFamily: "GT_America-Light",
                    fontSize: "30px",
                    fontWeight: "900",
                }}>
                    Web3&nbsp;SDK
                </Typography>
            </Typography>
            <Typography sx={{
                fontFamily: "GT_America-Light",
                fontSize: "30px",
                textAlign: "center",
                fontWeight: "600",
            }}>
                &nbsp;for Visual State Machines
            </Typography>
        </Card>
    )
}