import {Card} from "@mui/material";
import React from "react";

type NoteProps = {
    x: number;
    y: number;
    text: string;
    maxWidth?: string;
}

type OverlayNoteProps = {
    notes: NoteProps[];
    width: number;
    height: number;
}

export default function OverlayNote(props: OverlayNoteProps) {
    return (
        <svg style={{
            position: "absolute",
            zIndex: 1,
        }} fill="black" width={props.width} height={props.height}>
            <rect fill="transparent" width={props.width} height={props.height}/>
            {props.notes.map((note, index) => (
                <foreignObject x={note.x} y={note.y} width="100%" height="100%">
                    <Card sx={{
                        maxWidth: note.maxWidth,
                        padding: "20px",
                        borderRadius: "10px",
                        border: "1px solid #00000022",
                    }}>
                        <p key={index}>{note.text}</p>
                    </Card>
                </foreignObject>
            ))}
        </svg>
    )
}
