// diff.ts — the comparison the parity tests share (native_parity_test.ts, js_vs_wasm_test.ts).

/** Differences between expected and actual, as "path: reason" lines. */
export function diff(exp: unknown, act: unknown, path: string, tol: number, ignore: Set<string>, out: string[] = []): string[] {
    if (typeof exp === "number" && typeof act === "number") {
        if (exp === act) return out;
        if (Number.isInteger(exp) && Number.isInteger(act)) { out.push(`${path}: ${exp} != ${act}`); return out; }
        const scale = Math.max(Math.abs(exp), Math.abs(act));
        if (Math.abs(exp - act) > tol * Math.max(scale, 1e-12)) out.push(`${path}: ${exp} != ${act} (rel ${(Math.abs(exp - act) / scale).toExponential(2)} > ${tol})`);
        return out;
    }
    if (Array.isArray(exp) || Array.isArray(act)) {
        if (!Array.isArray(exp) || !Array.isArray(act)) { out.push(`${path}: array vs ${typeof (Array.isArray(exp) ? act : exp)}`); return out; }
        if (exp.length !== act.length) { out.push(`${path}: length ${exp.length} != ${act.length}`); return out; }
        exp.forEach((x, i) => diff(x, act[i], `${path}[${i}]`, tol, ignore, out));
        return out;
    }
    if (exp && act && typeof exp === "object" && typeof act === "object") {
        const ek = Object.keys(exp).filter((k) => !ignore.has(k)).sort();
        const ak = Object.keys(act).filter((k) => !ignore.has(k)).sort();
        if (ek.join("\0") !== ak.join("\0")) {
            out.push(`${path}: keys differ (only native: ${ek.filter((k) => !ak.includes(k)).join(",") || "-"}; only wasm: ${ak.filter((k) => !ek.includes(k)).join(",") || "-"})`);
        }
        for (const k of ek) if (ak.includes(k)) diff((exp as any)[k], (act as any)[k], `${path}.${k}`, tol, ignore, out);
        return out;
    }
    if (exp !== act) out.push(`${path}: ${JSON.stringify(exp)} != ${JSON.stringify(act)}`);
    return out;
}
