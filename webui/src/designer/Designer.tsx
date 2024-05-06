import React, {useEffect} from 'react';
import Model from './Model';
import {MetaModel} from "../pflow";
import FileMenu from "./FileMenu";
import EditMenu from "./EditMenu";
import HelpMenu from "./HelpMenu";
import ConnectMetamask from "../editor/ConnectMetamask";
import ImportContract from "../editor/ImportContract";

interface DesignerProps {
    metaModel: MetaModel;
}

export default function Designer(props: DesignerProps): React.ReactElement {
    const {metaModel} = props;
    const onClick = async (evt: React.MouseEvent) => {
        return props.metaModel.editorClick(evt);
    };

    const [svgWidth, setSvgWidth] = React.useState(window.innerWidth);

    useEffect(() => {
        const handleResize = () => {
            setSvgWidth(window.innerWidth);
        };

        // Add event listeners
        window.addEventListener('orientationchange', handleResize);
        window.addEventListener('resize', handleResize);

        // Cleanup function to remove event listeners
        return () => {
            window.removeEventListener('orientationchange', handleResize);
            window.removeEventListener('resize', handleResize);
        };
    }, []); // Empty dependency array means this effect runs once on mount and cleanup on unmount


    return <React.Fragment>
        <svg id="pflow-svg-outer"
             width={svgWidth}
             height={metaModel.height}
             onClick={onClick}
        >

            <foreignObject id="designer-canvas" x={0} y={0} width={"100%"} height={metaModel.height}>
                <canvas id="pflow-canvas" width={svgWidth} height={metaModel.height}/>
            </foreignObject>

            <rect x={0} y={0} width={svgWidth} height={60} fill="#EBE9E5" stroke="#OOOOOO"/>

            <foreignObject id="import-eth-contract" x={svgWidth / 2 - 200} y={-4} width={"600px"} height="42px">
                <ImportContract metaModel={metaModel}/>
            </foreignObject>

            <svg id="pflow-svg"
                 width={svgWidth}
                 height={metaModel.height}
                 onContextMenu={(evt) => evt.preventDefault()}
            >
                <defs>
                    <marker id="markerArrow1" markerWidth="23" markerHeight="13" refX="31" refY="6" orient="auto">
                        <rect className="arrowSpace1" width="28" height="3" fill="#ffffff" stroke="#ffffff" x="3"
                              y="5"/>
                        <path d="M2,2 L2,11 L10,6 L2,2"/>
                    </marker>
                    <marker id="markerInhibit1" markerWidth="23" markerHeight="13" refX="31" refY="6" orient="auto">
                        <rect className="inhibitSpace1" width="28" height="3" fill="#ffffff" stroke="#ffffff" x="3"
                              y="5"/>
                        <circle cx="5" cy="6.5" r={4}/>
                    </marker>
                </defs>
                <Model metaModel={metaModel}/>
            </svg>


            <foreignObject id="pflow-logo" x={10} y={10} width={150} height={35}>
                <a href={"./"}>
                    <svg width="150" height="35" stroke="#FFFFFF">
                        <g transform="scale(.3,.3)">
                            <path
                                d="M100.88 28.02H78.46v5.61h-5.6v5.6h-5.6v-5.6h5.6v-5.61h5.6V5.6h-5.6V0H61.65v5.6h-5.6v28.02h-5.6V5.6h-5.6V0H33.64v5.6h-5.6v22.42h5.6v5.61h5.6v5.6h-5.6v-5.6h-5.6v-5.61H5.6v5.61H0v11.21h5.6v5.6h28.02v5.6H5.6v5.61H0v11.21h5.6v5.6h22.42v-5.6h5.6v-5.61h5.6v5.61h-5.6v5.6h-5.6v22.42h5.6v5.6h11.21v-5.6h5.6V72.86h5.6v28.02h5.6v5.6h11.21v-5.6h5.6V78.46h-5.6v-5.6h-5.6v-5.61h5.6v5.61h5.6v5.6h22.42v-5.6h5.6V61.65h-5.6v-5.61H72.84v-5.6h28.02v-5.6h5.6V33.63h-5.6v-5.61zM67.25 56.04v5.61h-5.6v5.6H44.84v-5.6h-5.6V44.84h5.6v-5.6h16.81v5.6h5.6v11.21zm89.89-28.02h-11.21v11.21h11.21zm33.63 11.21h11.21V28.02h-33.63v11.21z"/>
                            <path
                                d="M179.56 72.86h-11.21V39.23h-11.21v56.05h-11.21v11.21h33.63V95.28h-11.21V84.07h33.63V72.86zm22.42-22.42v22.42h11.21V39.23h-11.21zm33.63-22.42H224.4v11.21h11.21v33.63H224.4v11.21h33.63V72.86h-11.21V39.23h11.21V28.02h-11.21V16.81h-11.21z"/>
                            <path
                                d="M246.82 5.6v11.21h22.42V5.6zm56.05 56.05V5.6h-22.42v11.21h11.21v56.05h-11.21v11.21h33.63V72.86h-11.21zm33.63-11.21V39.23h-11.21v33.63h11.21zm22.42 0h-11.21v11.21h11.21zm0-11.21h11.21V28.02H336.5v11.21zm-11.21 33.63H336.5v11.21h33.63V72.86zm22.42-22.42v22.42h11.21V39.23h-11.21zm44.84-11.21V28.02h-22.42v11.21h11.21v22.42h11.21zm11.21 22.42h-11.21v11.21h11.21zm11.21 11.21h-11.21v11.21h11.21zm11.21-22.42V28.02h-11.21v44.84h11.21zm11.21 22.42H448.6v11.21h11.21zm11.21-11.21h-11.21v11.21h11.21zm11.21-33.63h-11.21v33.63h11.21V39.23h11.21V28.02z"/>
                        </g>
                    </svg>
                </a>
            </foreignObject>
            <foreignObject id="filemenu-foreign" x={160} y={9} width={"200px"} height="40px">
                <FileMenu metaModel={metaModel}/>
            </foreignObject>
            <foreignObject id="editmenu-foreign" x={220} y={9} width={"200px"} height="40px">
                <EditMenu metaModel={metaModel}/>
            </foreignObject>
            <foreignObject id="editmenu-foreign" x={280} y={9} width={"200px"} height="40px">
                <HelpMenu/>
            </foreignObject>
            <foreignObject id="pflow-foreign" x={svgWidth - 163} y={12} width={"100%"} height="40px">
                <ConnectMetamask metaModel={metaModel}/>
            </foreignObject>
        </svg>
    </React.Fragment>
        ;
}
