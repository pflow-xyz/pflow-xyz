import Header from "./components/Header";
import TopBanner from "./components/TopBanner";
import ProblemStatement from "./components/ProblemStatement";
import {Fragment} from "react";
import PetriNetSuperBasic from "./components/PetriNetSuperBasic";
import BottomBanner from "./components/BottomBanner";
import Footer from "./components/Footer";
import BottomNav from "./components/BottomNav";
import FlowerBar from "./components/FlowerBar";

export default function Homepage() {
    return (
        <Fragment>
            <Header/>
            <TopBanner/>
            <ProblemStatement/>
            <PetriNetSuperBasic/>
            <BottomBanner/>
            <BottomNav/>
            <FlowerBar/>
            <Footer/>
        </Fragment>
    )
}