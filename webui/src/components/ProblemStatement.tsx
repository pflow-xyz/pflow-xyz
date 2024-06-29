import {Card, Typography} from "@mui/material";
import Grid2 from "@mui/material/Unstable_Grid2";

export default function ProblemStatement() {
    return (
        <div style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            background: "#1E1E1D",
            minHeight: "40em",
            padding: "2em",
        }}>
            <Grid2 container spacing={2} sx={{}}>
                <Card sx={{
                    borderRadius: "10px",
                    border: "2px solid #EBFF00",
                    bgcolor: "#1E1E1D",
                    color: "#FFFFFF",
                    maxWidth: "600px",
                    margin: "2em",
                    paddingBottom: "2em",
                }}>
                    <Typography sx={{
                        fontFamily: "GT_America-Light",
                        fontSize: "1.5em",
                        paddingBottom: "3em",
                        padding: "0.5em",
                    }}>
                        Problem:
                    </Typography>
                    <Typography sx={{
                        fontFamily: "GT_America-Light",
                        fontSize: "1.5em",
                        paddingLeft: "1em",
                        paddingTop: "3em",
                    }}>
                        &nbsp;&nbsp;<u>Composability</u> is a blessing and a curse.
                    </Typography>
                    <Typography sx={{
                        fontFamily: "GT_America-Light",
                        fontSize: "1.5em",
                        paddingLeft: "1em",
                        paddingTop: "3em",
                    }}>
                        &nbsp;&nbsp;&nbsp;&nbsp; The <u>complexity of smart contracts</u> makes it
                        difficult to <u>understand and verify</u> their behavior.
                    </Typography>

                </Card>
                <Card sx={{
                    borderRadius: "10px",
                    border: "2px solid #EBFF00",
                    bgcolor: "#1E1E1D",
                    color: "#FFFFFF",
                    maxWidth: "600px",
                    margin: "2em"
                }}>
                    <Typography sx={{
                        fontFamily: "GT_America-Light",
                        fontSize: "1.5em",
                        paddingTop: "0.5em",
                        paddingLeft: "0.5em",
                    }}>
                        Solution:
                    </Typography>
                    <Typography sx={{
                        paddingLeft: "1em",
                        paddingRight: "1em",
                        paddingTop: "3em",
                        fontFamily: "GT_America-Light",
                        fontSize: "1.5em",
                    }}>
                        &nbsp;&nbsp;&nbsp;&nbsp; Pflow empowers anyone to build smart contracts
                        in a way that is <u>easy to understand and verify</u>.
                    </Typography>
                    <Typography sx={{
                        paddingLeft: "1em",
                        paddingTop: "1.5em",
                        fontFamily: "GT_America-Light",
                        fontSize: "1.5em",
                        paddingBottom: "3em",
                    }}>
                        &nbsp;&nbsp;&nbsp;&nbsp;Pflow’s framework <u>reduces code complexity</u>
                        &nbsp; and allows users to <u>visually analyze contracts</u>.
                    </Typography>
                </Card>
            </Grid2>
        </div>
    )
}