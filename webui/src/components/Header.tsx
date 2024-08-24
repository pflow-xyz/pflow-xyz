import * as React from 'react';
import AppBar from '@mui/material/AppBar';
import {Toolbar, Typography} from "@mui/material";
import Button from "@mui/material/Button";
import {Link} from "react-router-dom";


function Logo() {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width="150" height="33" fill="none">
            <g fill="#FFF" transform="scale(0.3,0.3)">
                <path
                    d="M100.88 28.02H78.46v5.61h-5.6v5.6h-5.6v-5.6h5.6v-5.61h5.6V5.6h-5.6V0H61.65v5.6h-5.6v28.02h-5.6V5.6h-5.6V0H33.64v5.6h-5.6v22.42h5.6v5.61h5.6v5.6h-5.6v-5.6h-5.6v-5.61H5.6v5.61H0v11.21h5.6v5.6h28.02v5.6H5.6v5.61H0v11.21h5.6v5.6h22.42v-5.6h5.6v-5.61h5.6v5.61h-5.6v5.6h-5.6v22.42h5.6v5.6h11.21v-5.6h5.6V72.86h5.6v28.02h5.6v5.6h11.21v-5.6h5.6V78.46h-5.6v-5.6h-5.6v-5.61h5.6v5.61h5.6v5.6h22.42v-5.6h5.6V61.65h-5.6v-5.61H72.84v-5.6h28.02v-5.6h5.6V33.63h-5.6v-5.61zM67.25 56.04v5.61h-5.6v5.6H44.84v-5.6h-5.6V44.84h5.6v-5.6h16.81v5.6h5.6v11.21zM157.14 28.02h-11.21v11.21h11.21zM190.77 39.23h11.21V28.02h-33.63v11.21z"/>
                <path
                    d="M179.56 72.86h-11.21V39.23h-11.21v56.05h-11.21v11.21h33.63V95.28h-11.21V84.07h33.63V72.86zM201.98 50.44v22.42h11.21V39.23h-11.21zM235.61 28.02H224.4v11.21h11.21v33.63H224.4v11.21h33.63V72.86h-11.21V39.23h11.21V28.02h-11.21V16.81h-11.21z"/>
                <path
                    d="M246.82 5.6v11.21h22.42V5.6zM302.87 61.65V5.6h-22.42v11.21h11.21v56.05h-11.21v11.21h33.63V72.86h-11.21zM336.5 50.44V39.23h-11.21v33.63h11.21zM358.92 50.44h-11.21v11.21h11.21zM358.92 39.23h11.21V28.02H336.5v11.21zM347.71 72.86H336.5v11.21h33.63V72.86zM370.13 50.44v22.42h11.21V39.23h-11.21zM414.97 39.23V28.02h-22.42v11.21h11.21v22.42h11.21zM426.18 61.65h-11.21v11.21h11.21zM437.39 72.86h-11.21v11.21h11.21zM448.6 50.44V28.02h-11.21v44.84h11.21zM459.81 72.86H448.6v11.21h11.21zM471.02 61.65h-11.21v11.21h11.21zM482.23 28.02h-11.21v33.63h11.21V39.23h11.21V28.02z"/>
            </g>
        </svg>
    )
}


export default function Header() {
    return (
        <div style={{
            zIndex: 1,
        }}>
            <AppBar position="static" sx={{
                bgcolor: "#1C1C1D",
            }}>
                <Toolbar>
                    <Typography
                        variant="h6"
                        noWrap
                        component="div"
                        sx={{flexGrow: 1, display: {xs: 'none', sm: 'block'}}}
                    >
                        <Link to={"/"}>
                            <Logo/>
                        </Link>
                    </Typography>
                    <Link to={"/docs"} style={{
                        color: "black",
                        textDecoration: "none",
                    }}>
                        <div
                            style={{
                                borderRadius: "10px",
                                background: "#EBFF00",
                                border: "1px solid #EBFF00",
                                color: "black",
                                paddingTop: "5px",
                                paddingBottom: "5px",
                                paddingLeft: "10px",
                                paddingRight: "10px",
                            }}>
                            <Typography style={{
                                color: "black",
                                fontSize: "20px",
                            }}>
                                Documentation
                            </Typography>
                        </div>
                    </Link>
                    &nbsp;
                    <Link to={"/editor"}>
                        <Button sx={{
                            borderRadius: "10px",
                            border: "1px solid #EBFF00",
                            color: "#c4c8a6",
                            backgroundColor: "#333",
                        }}>
                            <Typography variant="h6" noWrap>
                                Editor
                            </Typography>
                        </Button>
                    </Link>
                    <a href={"https://app.pflow.xyz"}>
                        <Button sx={{
                            borderRadius: "10px",
                            border: "1px solid #EBFF00",
                            color: "#c4c8a6",
                            marginLeft: "3px",
                            backgroundColor: "#1C1C1D",
                        }}>
                            <Typography variant="h6" noWrap>
                                app
                            </Typography>
                        </Button>
                    </a>
                </Toolbar>
            </AppBar>
        </div>
    );
}