import {Model, ModelDeclaration, newModel} from "./model";
import {compress, decompress} from "brotli-wasm";

/*
 */

/**
 * Compress a string using brotli
 *
 * NOTE: does not work in the browser use brotliPromise instead
 * ```
 * import brotliPromise from 'brotli-wasm';
 *
 * async function compressBrotliEncode(data: string): Promise<string> {
 *     const brotli = await brotliPromise;
 *     const encoder = new TextEncoder();
 *     const encodedData = encoder.encode(data);
 *     const compressedData = brotli.compress(encodedData);
 *     const byteNumbers = new Array(compressedData.length);
 *     for (let i = 0; i < compressedData.length; i++) {
 *         byteNumbers[i] = compressedData[i];
 *     }
 *     const byteArray = new Uint8Array(byteNumbers);
 *     // @ts-ignore
 *     const byteCharacters = String.fromCharCode.apply(null, byteArray);
 *     return btoa(byteCharacters);
 * }
 * ```
 */
export function compressBrotliEncode(data: string): string {
    return Buffer.from(
        compress(Buffer.from(data))
    ).toString("base64");
}

/**
 * Decompress a string using brotli
 *
 * NOTE: does not work in the browser use brotliPromise instead
 * ```
 * import brotliPromise from 'brotli-wasm';
 *
 * async function decompressBrotliDecode(data: string): Promise<string> {
 *     const brotli = await brotliPromise;
 *     const byteCharacters = atob(data);
 *     const byteNumbers = new Array(byteCharacters.length);
 *     for (let i = 0; i < byteCharacters.length; i++) {
 *         byteNumbers[i] = byteCharacters.charCodeAt(i);
 *     }
 *     const byteArray = new Uint8Array(byteNumbers);
 *     const decompressedData = brotli.decompress(byteArray);
 *     const textDecoder = new TextDecoder();
 *     return textDecoder.decode(decompressedData);
 * }
 * ```
 *
 * @param data
 */
export async function decompressBrotliDecode(data: string): Promise<string> {
    return Buffer.from(
        decompress(Buffer.from(data, "base64"))
    ).toString();
}

export async function decompressModel(data: string, version: string = "v0"): Promise<Model> {
    return decompressBrotliDecode(data).then((json) => {
        const m = JSON.parse(json) as ModelDeclaration;
        if (m.version !== version) {
            throw new Error(`Invalid model version: ${m.version} expected: ${version}`);
        }
        return newModel({
            declaration: m,
            type: m.modelType,
        });
    });
}
