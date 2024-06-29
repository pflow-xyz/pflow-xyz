import {styled, Typography} from "@mui/material";
import Button from "@mui/material/Button";
import {Link} from "react-router-dom";

const ButtonSection = styled('div')(({theme}) => ({
    width: '100%',
    minHeight: '4em',
    display: 'flex',
    justifyContent: 'center',
    background: '#1E1E1D',
}));

export default function ButtonDivider() {
    return (
        <ButtonSection sx={{
            background: "#1E1E1D",
        }}>
            <div style={{
                paddingBottom: "3em",
            }}>

                <Link to="/suggest">

                    <Button sx={{
                        margin: "2em",
                        borderRadius: "10px",
                        background: "#EBFF00",
                        border: "2px solid #EBFF00",
                        color: "black"
                    }}>
                        <Typography variant="h6">
                            Suggest a Model to Develop
                        </Typography>
                    </Button>
                </Link>
                <Link to={"/examples"}>
                    <Button sx={{margin: "2em", borderRadius: "10px", border: "2px solid #EBFF00", color: "white"}}>
                        <Typography variant="h6">
                            Explore Examples
                        </Typography>
                    </Button>
                </Link>
            </div>
        </ButtonSection>
    );
}
