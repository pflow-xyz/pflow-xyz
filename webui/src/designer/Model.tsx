import React, {ReactElement} from 'react';
import Place from './Place';
import Arc from './Arc';
import Transition from './Transition';
import {MetaModel} from "../pflow";
import * as mm from "../protocol";

interface ModelProps {
    metaModel: MetaModel;
    schema?: string;
}

export default function Model(props: ModelProps) {
    const {metaModel, schema} = props;
    const {places, transitions} = metaModel.m.def;

    const placeElements = Array.from(places.keys()).map((label) =>
        <Place key={label} id={label} metaModel={metaModel}/>,
    );

    const transitionElements = Array.from(transitions.keys()).map((label) =>
        <Transition key={label} id={label} metaModel={metaModel}/>,
    );


    const arcs: ReactElement[] = metaModel.m.def.arcs.map((arc: mm.Arc, index: number) => {
        const source = arc.source.place || arc.source.transition;
        const target = arc.target.place || arc.target.transition;
        if (!source || !target) {
            return <React.Fragment key={index}/>;
        }
        const id = index.toString() + "_" + source.label + "_" + target.label;
        return <Arc key={id} id={id} metaModel={metaModel} arc={arc}/>;
    });

    return (
        <g id={schema} key={schema}>
            {arcs}
            {placeElements}
            {transitionElements}
        </g>
    );
}