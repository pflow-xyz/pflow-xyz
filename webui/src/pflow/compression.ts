import * as mm from "../protocol";

import brotliPromise from 'brotli-wasm';

function getQueryParams(str = window?.location?.search, separator = '&'): Record<string, any> {
    const obj: Record<string, any> = {};
    if (str.length === 0) return obj;
    const c = str.substring(0, 1);
    const s = c === '?' || c === '#' ? str.substring(1) : str;

    const a = s.split(separator);
    for (let i = 0; i < a.length; i++) {
        const p = a[i].indexOf('=');
        if (p < 0) {
            obj[a[i]] = '';
            continue;
        }
        let k = decodeURIComponent(a[i].substring(0, p)),
            v = decodeURIComponent(a[i].substring(p + 1));

        const bps = k.indexOf('[');
        if (bps < 0) {
            obj[k] = v;
            continue;
        }

        const bpe = k.substring(bps + 1).indexOf(']');
        if (bpe < 0) {
            obj[k] = v;
            continue;
        }

        const bpv = k.substring(bps + 1, bps + bpe - 1);
        k = k.substring(0, bps);
        if (bpv.length <= 0) {
            if (typeof obj[k] != 'object') obj[k] = [];
            obj[k].push(v);
        } else {
            if (typeof obj[k] != 'object') obj[k] = {};
            obj[k][bpv] = v;
        }
    }
    return obj;
}

export async function loadModelFromPermLink(): Promise<mm.Model> {
    let zippedJson = getQueryParams()['z']
    if (!zippedJson) {
        const cid = sessionStorage.getItem('cid')
        if (cid) {
            zippedJson = sessionStorage.getItem('data');
        }
    }
    if (zippedJson) {
        return decompressBrotliDecode(zippedJson).then((json: string) => {
            const m = JSON.parse(json) as mm.ModelDeclaration;
            if (m.version !== 'v0') {
                console.warn("model version mismatch, expected: v0 got: " + m.version);
                m.version = 'v0';
            }
            return mm.newModel({
                declaration: m,
                type: m.modelType,
            });
        });
    }
    return Promise.reject('no model found');
}

/**
 * Compress data using brotli & base64 encode
 */
export async function compressBrotliEncode(data: string): Promise<string> {
    const brotli = await brotliPromise;
    const encoder = new TextEncoder();
    const encodedData = encoder.encode(data);
    const compressedData = brotli.compress(encodedData);
    const byteNumbers = new Array(compressedData.length);
    for (let i = 0; i < compressedData.length; i++) {
        byteNumbers[i] = compressedData[i];
    }
    const byteArray = new Uint8Array(byteNumbers);
    // @ts-ignore
    const byteCharacters = String.fromCharCode.apply(null, byteArray);
    return btoa(byteCharacters);
}

/**
 * Decode with base64 & decompress brotli encoded data
 */
export async function decompressBrotliDecode(data: string): Promise<string> {
    const brotli = await brotliPromise;
    const byteCharacters = atob(data);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
        byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    const decompressedData = brotli.decompress(byteArray);
    const textDecoder = new TextDecoder();
    return textDecoder.decode(decompressedData);
}
