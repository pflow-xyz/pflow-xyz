// REVIEW: should we keep canvas for snapshots?
import * as mm from "../protocol";

const domURL = window.URL || window.webkitURL || window;

export const elementId = 'pflow-canvas';

function getCanvas(): HTMLCanvasElement {
    const c = document.getElementById(elementId) as HTMLCanvasElement
    if (!c) {
        throw Error(`failed to get element:  '${elementId}'`);
    }
    return c
}

function getSvg(): SVGElement {
    const e = document.getElementById('pflow-svg') as unknown as SVGElement;
    if (!e) {
        throw Error(`failed to get element:  'pflow-svg'`);
    }
    return e
}

export function showCanvas(): void {
    getSvg().style.display = 'none';
    getCanvas().style.display = 'block';
}

export function downloadPngFromCanvas(timeout: number = 100): void {
    setTimeout(() => {
        const c = getCanvas();
        const a = document.createElement('a');
        a.download = 'snapshot.png';
        a.href = c.toDataURL('image/png');
        a.click();
        domURL.revokeObjectURL(a.href);
    }, timeout);
}

export function hideCanvas(): void {
    getSvg().style.display = 'block';
    const c = getCanvas();
    c.style.display = 'none';
    const ctx = c.getContext("2d");
    if (!ctx) {
        throw Error('failed to call: canvas.getContext()');
    }
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, c.width, c.height);
}

export function snapshotSvg(m: mm.Model, state: mm.Vector): void {
    const c = getCanvas();
    // show the canvas
    const ctx = c.getContext("2d");
    if (!ctx) {
        throw Error('failed to call: canvas.getContext()');
    }
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, c.width, c.height);
    let img = new Image();
    const snap = mm.snapshot(m, {state});
    let svgBlob = new Blob([snap], {type: 'image/svg+xml;charset=utf-8'});
    img.src = domURL.createObjectURL(svgBlob);
    img.onload = function () {
        ctx.drawImage(img, 0, 0);
        domURL.revokeObjectURL(img.src);
    };
}
