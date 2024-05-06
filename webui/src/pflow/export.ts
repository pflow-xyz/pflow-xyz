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