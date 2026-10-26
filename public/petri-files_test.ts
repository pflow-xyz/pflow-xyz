// The account-file commands (file.save, file.open, file.list, file.get,
// file.write, file.delete, export.artifact {name}): pflow-native's file-system
// writes, saved to the signed-in user's own files over /api/files
// (cmd/webserver/files.go). Run headless with a fake fetch.
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { ACCOUNT_FILE_EXTENSIONS, CommandError, Registry, SIGN_IN_TO_SAVE, checkAccountName, createHeadlessHost } from "./petri-commands.js";

const net = () => ({
    "@context": "https://pflow.xyz/schema", "@type": "PetriNet", token: ["https://pflow.xyz/tokens/black"],
    places: { S: { initial: [9], capacity: [0], x: 0, y: 0 }, I: { initial: [1], capacity: [0], x: 100, y: 0 } },
    transitions: { infect: { x: 50, y: 0, rate: 0.5 } },
    arcs: [{ source: "S", target: "infect", weight: [1] }, { source: "I", target: "infect", weight: [1] }, { source: "infect", target: "I", weight: [2] }],
});

type Call = { url: string; method: string; headers: Record<string, string>; body?: any };

// A fake fetch that records each call and answers with `reply(call)`.
function fakeFetch(reply: (c: Call) => Response) {
    const calls: Call[] = [];
    const fetch = (url: string, init: any = {}) => {
        const c: Call = { url, method: init.method || "GET", headers: init.headers || {}, body: init.body };
        calls.push(c);
        return Promise.resolve(reply(c));
    };
    return { calls, fetch };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// The server's /api/files contract in memory, for round trips (one account).
function fakeServer() {
    const files = new Map<string, Uint8Array>();
    return fakeFetch((c) => {
        if (c.headers.Authorization !== "Bearer tok") return json(401, { error: "sign in to save: files are kept in your own account, and this request is not signed in" });
        const u = new URL(c.url, "https://pflow.xyz");
        const name = decodeURIComponent(u.pathname.replace(/^\/api\/files\/?/, ""));
        if (!name) return json(200, { files: [...files].map(([n, b]) => ({ name: n, size: b.length, modified: "2026-10-26T00:00:00Z", kind: "net" })), usage: { files: files.size }, limits: {} });
        if (c.method === "GET") return files.has(name) ? new Response(files.get(name) as BodyInit) : json(404, { error: `you have no file named ${name}` });
        if (c.method === "DELETE") return files.delete(name) ? json(200, { deleted: name }) : json(404, { error: `you have no file named ${name}` });
        if (files.has(name) && u.searchParams.get("overwrite") !== "true") return json(409, { error: `you already have a file named ${name}; save with overwrite to replace it`, name });
        const created = !files.has(name);
        const bytes = typeof c.body === "string" ? new TextEncoder().encode(c.body) : c.body;
        files.set(name, bytes);
        return json(created ? 201 : 200, { name, size: bytes.length, created });
    });
}

const ACCOUNT_CALLS: [string, Record<string, unknown>][] = [
    ["file.save", { name: "sir.json" }], ["file.open", { name: "sir.json" }], ["file.list", {}], ["file.get", { name: "sir.json" }],
    ["file.write", { name: "a.svg", content: "<svg/>" }], ["file.delete", { name: "sir.json" }],
];

Deno.test("account files: signed out, every command says to sign in to save and sends nothing", async () => {
    const { calls, fetch } = fakeFetch(() => json(200, {}));
    const r: any = new Registry(createHeadlessHost(net(), { fetch }));
    for (const [id, args] of ACCOUNT_CALLS) {
        const e = await assertRejects(() => r.execute(id, args), CommandError, "Sign in to save");
        assertEquals((e as any).code, "unauthenticated", id);
    }
    // export.artifact {name} too.
    const run = await r.execute("sim.ssa", { t_end: 1, runs: 2, seed: 1, points: 3 });
    await assertRejects(() => r.execute("export.artifact", { id: run.artifact, name: "run.csv" }), CommandError, "Sign in to save");
    assertEquals(calls.length, 0);
    assert(/sign in to save/i.test(SIGN_IN_TO_SAVE));
    // The plain headless host (the chat's sandbox) has no sign-in at all.
    await assertRejects(() => new Registry(createHeadlessHost(net())).execute("file.list"), CommandError, "Sign in to save");
});

Deno.test("account files: file.save PUTs the document as JSON-LD, refuses an existing name, replaces with overwrite", async () => {
    const { calls, fetch } = fakeFetch((c) => (c.url.includes("overwrite=true") ? json(200, { name: "sir.json", size: 1, created: false }) : json(201, { name: "sir.json", size: 1, created: true })));
    const r: any = new Registry(createHeadlessHost(net(), { token: "tok", fetch }));
    const out = await r.execute("file.save", { name: "sir.json" });
    assertEquals(out, { name: "sir.json", size: 1, created: true });
    const c = calls[0];
    assertEquals([c.method, c.url], ["PUT", "/api/files/sir.json"]);
    assertEquals(c.headers.Authorization, "Bearer tok");
    assertEquals(c.headers["Content-Type"], "application/json");
    assert(c.body.endsWith("}\n"));
    const saved = JSON.parse(c.body);
    assertEquals(saved.transitions.infect.rate, 0.5); // rates are part of the document
    assertEquals(saved.places.S.capacity, [null]); // unbounded, as file.export_json writes it
    assertEquals(saved, (await r.execute("file.export_json")).json);

    await r.execute("file.save", { name: "sir.json", overwrite: true });
    assertEquals(calls[1].url, "/api/files/sir.json?overwrite=true");
    await r.execute("file.save", { name: "plain" }); // no extension: .json
    assertEquals(calls[2].url, "/api/files/plain.json");
    await r.execute("file.save", { name: "ld.jsonld" });
    assertEquals(calls[3].headers["Content-Type"], "application/ld+json");
    assertEquals(r.journal.length, 0); // saving does not change the document

    // A conflict comes back as the server words it, coded.
    const conflict = fakeFetch(() => json(409, { error: "you already have a file named sir.json; save with overwrite to replace it" }));
    const r2: any = new Registry(createHeadlessHost(net(), { token: "tok", fetch: conflict.fetch }));
    const e = await assertRejects(() => r2.execute("file.save", { name: "sir.json" }), CommandError, "overwrite");
    assertEquals((e as any).code, "conflict");
});

Deno.test("account files: names are checked before anything is sent, as the server checks them", async () => {
    const { calls, fetch } = fakeFetch(() => json(201, {}));
    const r: any = new Registry(createHeadlessHost(net(), { token: "tok", fetch }));
    for (const name of ["../x.json", "a/b.json", ".hidden.json", "a..json", "x.svg", "café.json", "a%2fb.json", "a b.json", "x".repeat(101)]) {
        await assertRejects(() => r.execute("file.save", { name }), CommandError, "name", name);
    }
    await assertRejects(() => r.execute("file.open", { name: "a.csv" }), CommandError, ".json .jsonld");
    await assertRejects(() => r.execute("file.write", { name: "x.exe", content: "x" }), CommandError, "extension");
    await assertRejects(() => r.execute("file.write", { name: "x.png", content: "x" }), CommandError, "renders no PNG");
    await assertRejects(() => r.execute("file.delete", { name: "/etc/passwd" }), CommandError, "name");
    assertEquals(calls.length, 0);
    // The same table as internal/userfiles' TestCheckName.
    for (const ok of ["sir.json", "SIR-v2.jsonld", "a.svg", "plot.png", "r_1.csv", "labels.jsonl", "notes.txt", "x.JSON", "0.json"]) checkAccountName(ok);
    for (const bad of ["", ".json", "noext", "a.exe", "x.json.", "-x.json", "_x.json", "a∕b.json", "a\\b.json", "a\u0000.json"]) {
        let threw = false;
        try { checkAccountName(bad); } catch (e) { threw = e instanceof CommandError; }
        assert(threw, JSON.stringify(bad));
    }
    assertEquals(ACCOUNT_FILE_EXTENSIONS, [".csv", ".json", ".jsonl", ".jsonld", ".png", ".svg", ".txt"]);
});

Deno.test("account files: save, list, open, delete round trip against the API", async () => {
    const server = fakeServer();
    const host: any = createHeadlessHost(net(), { token: "tok", fetch: server.fetch, apiBase: "https://pflow.xyz" });
    const r: any = new Registry(host);
    await r.execute("file.save", { name: "sir.json" });
    assertEquals(server.calls[0].url, "https://pflow.xyz/api/files/sir.json");
    const list = await r.execute("file.list");
    assertEquals(list.files.map((f: any) => f.name), ["sir.json"]);
    await r.execute("file.new");
    assertEquals(Object.keys(host.getModel().places), []);
    const opened = await r.execute("file.open", { name: "sir.json" });
    assertEquals(opened.name, "sir.json");
    assertEquals(opened.errors, []);
    assertEquals(Object.keys(host.getModel().places), ["S", "I"]);
    assertEquals(host.getModel().transitions.infect.rate, 0.5);
    assertEquals(r.journal.map((s: any) => s.command), ["file.new", "file.open"]);
    await r.execute("edit.undo"); // the open is one undo step
    assertEquals(Object.keys(host.getModel().places), []);
    assertEquals(await r.execute("file.delete", { name: "sir.json" }), { deleted: "sir.json" });
    const gone = await assertRejects(() => r.execute("file.open", { name: "sir.json" }), CommandError, "no file named sir.json");
    assertEquals((gone as any).code, "not_found");
});

Deno.test("account files: file.open checks the net as file.load_json does", async () => {
    const bad = { ...net(), arcs: [{ source: "S", target: "nowhere", weight: [1] }] };
    const { fetch } = fakeFetch((c) => new Response(c.url.endsWith("text.json") ? "not json" : JSON.stringify(bad)));
    const host: any = createHeadlessHost(net(), { token: "tok", fetch });
    const r: any = new Registry(host);
    await assertRejects(() => r.execute("file.open", { name: "bad.json" }), CommandError, "error(s)");
    assertEquals(Object.keys(host.getModel().places), ["S", "I"]); // untouched
    const repaired = await r.execute("file.open", { name: "bad.json", repair: true });
    assert(repaired.errors.length > 0);
    await assertRejects(() => r.execute("file.open", { name: "text.json" }), CommandError, "not JSON");
});

Deno.test("account files: file.get reads text and PNGs, file.write and file.delete send what they say", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255]);
    const { calls, fetch } = fakeFetch((c) => {
        if (c.method === "GET") return new Response(c.url.endsWith(".png") ? png : "time,S\n0,9\n");
        if (c.method === "DELETE") return json(200, { deleted: "a.csv", usage: { files: 0, bytes: 0 } });
        return json(201, { name: "net.svg", size: 6, created: true });
    });
    const r: any = new Registry(createHeadlessHost(net(), { token: "tok", fetch }));
    assertEquals(await r.execute("file.get", { name: "a.csv" }), { name: "a.csv", mime: "text/csv", size: 11, content: "time,S\n0,9\n" });
    const img = await r.execute("file.get", { name: "shot.png" });
    assertEquals(img.content_base64, btoa(String.fromCharCode(...png)));
    assertEquals(img.size, 10);
    await r.execute("file.write", { name: "net.svg", content: "<svg/>", overwrite: true });
    assertEquals([calls[2].method, calls[2].url, calls[2].body, calls[2].headers["Content-Type"]], ["PUT", "/api/files/net.svg?overwrite=true", "<svg/>", "image/svg+xml"]);
    assertEquals((await r.execute("file.delete", { name: "a.csv" })).deleted, "a.csv");
    assertEquals([calls[3].method, calls[3].url], ["DELETE", "/api/files/a.csv"]);
});

Deno.test("account files: export.artifact with a name saves the export; without one it returns it as before", async () => {
    const { calls, fetch } = fakeFetch(() => json(201, { name: "run.csv", size: 10, created: true }));
    const r: any = new Registry(createHeadlessHost(net(), { token: "tok", fetch }));
    const run = await r.execute("sim.ode", { t_end: 2 });
    const plain = await r.execute("export.artifact", { id: run.artifact });
    assert(plain.content.startsWith("time,"));
    assertEquals(calls.length, 0);
    const saved = await r.execute("export.artifact", { id: run.artifact, name: "run.csv" });
    assertEquals(saved.created, true);
    assertEquals(saved.filename, plain.filename);
    assertEquals([calls[0].method, calls[0].url, calls[0].body], ["PUT", "/api/files/run.csv", plain.content]);
    await r.execute("export.artifact", { id: run.artifact, format: "json", name: "run.json", overwrite: true });
    assertEquals(calls[1].url, "/api/files/run.json?overwrite=true");
    assertEquals(JSON.parse(calls[1].body).id, run.artifact);
    await assertRejects(() => r.execute("export.artifact", { id: run.artifact, name: "run.json" }), CommandError, "saved as .csv");
    await assertRejects(() => r.execute("export.artifact", { id: run.artifact, overwrite: true }), CommandError, "overwrite goes with name");
});

Deno.test("account files: refusals map to codes, with the server's message", async () => {
    const cases: [Response | Error, string, string][] = [
        [json(401, { error: "sign in to save: files are kept in your own account, and this request is not signed in" }), "unauthenticated", "sign in to save"],
        [json(403, { error: "cross-origin requests to account files are refused" }), "forbidden", "cross-origin"],
        [json(413, { error: "a file is at most 1048576 bytes", limit: 1048576 }), "too_large", "at most"],
        [json(507, { error: "your account holds 200 files, the most it can (delete one to save another)" }), "quota", "200 files"],
        [json(503, { error: "cannot check your sign-in right now; nothing was saved, try again shortly" }), "unavailable", "sign-in"],
        [json(400, { error: "a .json or .jsonld file must be JSON" }), "invalid", "must be JSON"],
        [new Response("<html>404</html>", { status: 404 }), "not_found", "answered 404"],
        [new Response("bad gateway", { status: 502 }), "failed", "answered 502"],
        [new TypeError("network down"), "unavailable", "cannot reach the server"],
    ];
    for (const [reply, code, text] of cases) {
        const fetch = () => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply.clone()));
        const r: any = new Registry(createHeadlessHost(net(), { token: "tok", fetch }));
        const e = await assertRejects(() => r.execute("file.save", { name: "x.json" }), CommandError, text);
        assertEquals((e as any).code, code, text);
    }
});

Deno.test("account files: the Assistant is not given them", async () => {
    const manifest = JSON.parse(await Deno.readTextFile(new URL("./llm-tools.json", import.meta.url)));
    const names = new Set(manifest.tools.map((t: any) => t.command));
    for (const [id] of ACCOUNT_CALLS) assert(!names.has(id), id);
});
