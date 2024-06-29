import CodeEditor from "@uiw/react-textarea-code-editor";
import React from "react";

type SourceCodeProps = {
    id: string;
    code: string;
    language: string;
}
export default function SourceCode(props: SourceCodeProps) {

    return <CodeEditor
        id={props.id}
        value={props.code}
        data-color-mode="light"
        language={props.language}
        placeholder="source"
        padding={15}
        style={{
            fontSize: 12,
            backgroundColor: "#FFFFFF",
            border: "1px solid #E0E0E0",
            fontFamily: "ui-monospace,SFMono-Regular,SF Mono,Consolas,Liberation Mono,Menlo,monospace",
        }}
    />
}