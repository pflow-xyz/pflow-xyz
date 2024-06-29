import {Model} from "../protocol";
import {MetaModel} from "./metamodel";
import {compressBrotliEncode} from "./compression";

export function downloadModelJson(data: string) {
    try {
        JSON.parse(data);
    } catch (e) {
        console.error(e);
        return;
    }
    const element = document.createElement("a");
    const file = new Blob([data], {type: "text/plain"});
    element.href = URL.createObjectURL(file);
    element.download = "model.json";
    document.body.appendChild(element); // Required for this to work in FireFox
    element.click();
}

export function downloadSolidity(data: string) {
    const element = document.createElement("a");
    const file = new Blob([data], {type: "text/plain"});
    element.href = URL.createObjectURL(file);
    element.download = "model.sol";
    document.body.appendChild(element); // Required for this to work in FireFox
    element.click();
}

export async function modelObjectToLink(model: object) {
    const m = new MetaModel({
        editor: false,
    });
    await m.loadJson(model);
    m.zippedJson = await compressBrotliEncode(m.toJson());
    console.log({zippedJson: m.zippedJson})
    return "/?z=" + m.zippedJson;
}

export async function modelToLink(model: Model) {
    const m = new MetaModel({
        editor: false,
    });
    await m.loadJson(model.toObject());
    m.zippedJson = await compressBrotliEncode(m.toJson());
    return "/?z=" + m.zippedJson;
}


