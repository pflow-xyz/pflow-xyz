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
            <div>

            <div style={{
                fontFamily: "GT_America-Light",
                fontSize: "30px",
                fontWeight: "600",
            }}>
                Pflow is a&nbsp;
                <div style={{
                    display: "inline",
                    backgroundColor: "#EBFF00",
                    color: "black",
                    borderRadius: "10px",
                    border: "3px solid #EBFF00",
                    fontFamily: "GT_America-Light",
                    fontSize: "30px",
                    fontWeight: "900",
                }}>
                    Web3&nbsp;SDK
                </div>
            </div>
            </div>
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