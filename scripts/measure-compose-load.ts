// measure-compose-load.ts — what the composition page (public/compose.html)
// loads, how many bytes cross the wire, and when it is ready. Drives a headless
// Chrome over the DevTools protocol (no npm, no dependencies); numbers go to
// docs/compose-load-budget.md.
//
//   make build && ./bin/webserver -port 8135 -data /tmp/pflow-data &
//   deno run -A scripts/measure-compose-load.ts --url http://127.0.0.1:8135/compose.html
//
//   --profiles none,4g,3g   network + CPU profiles (default none,4g,3g; see PROFILES)
//   --runs N                repeat each load N times, report the median (default 3)
//   --views                 after the cold load, open each view and report what it requests
//   --list                  print every request of the first cold run, not just the groups
//   --accept-br             send Accept-Encoding: gzip, deflate, br (Chrome sends br over https only)
//   --json FILE             write the raw results as JSON
//
// "cold" is a new Chrome profile (empty cache); "warm" is a second tab of the
// same profile after the first has settled. Bytes are what Chrome reports:
// wire = encoded body bytes, decoded = bytes after Content-Encoding. Times are
// milliseconds from the navigation request. Run it with `deno run -A`; it
// launches /Applications/Google Chrome.app (override with CHROME=...).

const CHROME = Deno.env.get("CHROME") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type Profile = { desc: string; down: number; up: number; latency: number; cpu: number };
const PROFILES: Record<string, Profile> = {
  none: { desc: "no throttling", down: -1, up: -1, latency: 0, cpu: 1 },
  "4g": { desc: "4G (WebPageTest: 9 Mbps down, 9 Mbps up, 170 ms) + 4x CPU", down: 9e6 / 8, up: 9e6 / 8, latency: 170, cpu: 4 },
  "3g": { desc: "Fast 3G (DevTools preset: 1.6 Mbps down, 0.75 Mbps up, 562.5 ms) + 4x CPU", down: 1.6e6 / 8, up: 0.75e6 / 8, latency: 562.5, cpu: 4 },
};

// Installed before the page's own scripts: paint times, the moment the wasm is
// instantiated, and the moment the page says it has drawn (body[data-ready]).
const INSTRUMENT = `(() => {
  const m = (window.__perf = { marks: {}, longTasks: 0 });
  const at = (k) => { if (!(k in m.marks)) m.marks[k] = performance.now(); };
  for (const k of ['instantiate', 'instantiateStreaming']) {
    const orig = WebAssembly[k];
    WebAssembly[k] = function (...a) { return orig.apply(this, a).then((r) => { at('wasm'); return r; }); };
  }
  new MutationObserver(() => { if (document.body && document.body.dataset.ready === '1') at('ready'); })
    .observe(document, { attributes: true, subtree: true, attributeFilter: ['data-ready'] }); // document: documentElement does not exist yet
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) m.marks[e.name] = e.startTime; }).observe({ type: 'paint', buffered: true }); } catch {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) m.longTasks += e.duration; }).observe({ type: 'longtask', buffered: true }); } catch {}
})();`;

type Req = {
  id: string; url: string; host: string; type: string; startMs: number; endMs: number | null; status: number;
  wire: number; decoded: number; transfer: number; cache: string; encoding: string; ctype: string;
  cacheControl: string; etag: boolean; lastModified: boolean; initiator: string; failed: string | null; protocol: string;
};
type Load = { reqs: Req[]; marks: Record<string, number>; longTasks: number; load: number; dcl: number; acceptEncoding: string };

class Page {
  private n = 0;
  private pending = new Map<number, (v: any) => void>();
  private fail = new Map<number, (e: Error) => void>();
  private onEvent: Array<(m: string, p: any) => void> = [];
  constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string);
      if (m.id !== undefined) {
        const ok = this.pending.get(m.id), bad = this.fail.get(m.id);
        this.pending.delete(m.id); this.fail.delete(m.id);
        m.error ? bad?.(new Error(m.error.message)) : ok?.(m.result);
      } else if (m.method) for (const l of this.onEvent) l(m.method, m.params);
    };
  }
  send(method: string, params: any = {}): Promise<any> {
    const id = ++this.n;
    return new Promise((res, rej) => { this.pending.set(id, res); this.fail.set(id, rej); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(fn: (m: string, p: any) => void) { this.onEvent.push(fn); }
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }
  close() { try { this.ws.close(); } catch { /* closed */ } }
}

class Chrome {
  constructor(private proc: Deno.ChildProcess, readonly port: number, private dir: string) {}
  async page(): Promise<Page> {
    const t = await (await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    return new Page(ws);
  }
  async close() {
    try { this.proc.kill("SIGTERM"); await this.proc.status; } catch { /* gone */ }
    try { await Deno.remove(this.dir, { recursive: true }); } catch { /* ignore */ }
  }
}

async function launch(): Promise<Chrome> {
  const port = 9300 + Math.floor(Math.random() * 600);
  const dir = await Deno.makeTempDir({ prefix: "measure-chrome-" });
  const proc = new Deno.Command(CHROME, {
    args: ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`, "--no-first-run", "--no-default-browser-check",
      "--disable-gpu", "--disable-extensions", "--disable-background-networking", "about:blank"],
    stdout: "null", stderr: "null",
  }).spawn();
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); if (r.ok) { await r.body?.cancel(); return new Chrome(proc, port, dir); } } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  proc.kill("SIGTERM");
  throw new Error("Chrome did not start");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Records every request of a page: bytes, timing, headers. */
function track(p: Page) {
  const reqs = new Map<string, Req>();
  let t0: number | null = null;
  let docId = "";
  let acceptEncoding = "";
  p.on((m, e) => {
    if (m === "Network.requestWillBeSent") {
      if (e.request.url.startsWith("data:")) return;
      if (t0 === null && e.type === "Document") { t0 = e.timestamp; docId = e.requestId; }
      const prev = reqs.get(e.requestId);
      if (prev && e.redirectResponse) return; // a redirect keeps the first record
      const url = e.request.url;
      reqs.set(e.requestId, {
        id: e.requestId, url, host: new URL(url).host, type: e.type ?? "", startMs: ((e.timestamp - (t0 ?? e.timestamp)) * 1000),
        endMs: null, status: 0, wire: 0, decoded: 0, transfer: 0, cache: "", encoding: "", ctype: "", cacheControl: "", etag: false,
        lastModified: false, initiator: e.initiator?.url ? new URL(e.initiator.url).pathname.split("/").slice(-2).join("/") : (e.initiator?.type ?? ""),
        failed: null, protocol: "",
      });
    } else if (m === "Network.requestWillBeSentExtraInfo") {
      // the headers Chrome really sent (requestWillBeSent has only the page's own)
      const h = Object.fromEntries(Object.entries(e.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      if (h["accept-encoding"]) acceptEncoding = h["accept-encoding"];
    } else if (m === "Network.responseReceived") {
      const r = reqs.get(e.requestId); if (!r) return;
      const h = Object.fromEntries(Object.entries(e.response.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
      r.status = e.response.status; r.ctype = e.response.mimeType ?? ""; r.encoding = h["content-encoding"] ?? "";
      r.cacheControl = h["cache-control"] ?? ""; r.etag = !!h["etag"]; r.lastModified = !!h["last-modified"]; r.protocol = e.response.protocol ?? "";
      r.cache = e.response.fromDiskCache ? "disk" : e.response.fromServiceWorker ? "sw" : "";
    } else if (m === "Network.requestServedFromCache") {
      const r = reqs.get(e.requestId); if (r) r.cache = "memory";
    } else if (m === "Network.dataReceived") {
      const r = reqs.get(e.requestId); if (!r) return;
      r.decoded += e.dataLength; r.wire += e.encodedDataLength;
    } else if (m === "Network.loadingFinished") {
      const r = reqs.get(e.requestId); if (!r) return;
      r.endMs = (e.timestamp - (t0 ?? e.timestamp)) * 1000; r.transfer = e.encodedDataLength;
    } else if (m === "Network.loadingFailed") {
      const r = reqs.get(e.requestId); if (!r) return;
      r.endMs = (e.timestamp - (t0 ?? e.timestamp)) * 1000; r.failed = e.canceled ? "canceled" : e.errorText;
    }
  });
  return {
    reqs: () => [...reqs.values()],
    acceptEncoding: () => acceptEncoding,
    inflight: () => [...reqs.values()].filter((r) => r.endMs === null).length,
    mark: () => reqs.size,
  };
}

async function settle(p: Page, t: ReturnType<typeof track>, quietMs = 1500, maxMs = 120000) {
  const start = Date.now();
  let last = Date.now(), count = t.reqs().length;
  while (Date.now() - start < maxMs) {
    const now = t.reqs().length;
    if (now !== count || t.inflight() > 0) { last = Date.now(); count = now; }
    if (Date.now() - last > quietMs) return;
    await sleep(100);
  }
}

async function throttle(p: Page, prof: Profile, acceptBr: boolean) {
  await p.send("Network.emulateNetworkConditions", { offline: false, latency: prof.latency, downloadThroughput: prof.down, uploadThroughput: prof.up });
  await p.send("Emulation.setCPUThrottlingRate", { rate: prof.cpu });
  if (acceptBr) await p.send("Network.setExtraHTTPHeaders", { headers: { "Accept-Encoding": "gzip, deflate, br" } });
}

async function setup(chrome: Chrome, prof: Profile, acceptBr: boolean) {
  const p = await chrome.page();
  const t = track(p);
  await p.send("Page.enable"); await p.send("Runtime.enable"); await p.send("Network.enable");
  await p.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await p.send("Page.addScriptToEvaluateOnNewDocument", { source: INSTRUMENT });
  await throttle(p, prof, acceptBr);
  return { p, t };
}

async function loadOnce(chrome: Chrome, url: string, prof: Profile, acceptBr: boolean, keep = false): Promise<Load & { page?: Page; tracker?: ReturnType<typeof track> }> {
  const { p, t } = await setup(chrome, prof, acceptBr);
  await p.send("Page.navigate", { url });
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (await p.eval<boolean>("!!(window.__perf && window.__perf.marks.ready)").catch(() => false)) break;
    await sleep(50);
  }
  await settle(p, t);
  const perf = await p.eval<{ marks: Record<string, number>; longTasks: number }>(
    // the page's own marks (compose:shell, compose:registry-ready, compose:ready; app.js) join the observed ones
    "(() => { const m = JSON.parse(JSON.stringify(window.__perf)); for (const e of performance.getEntriesByType('mark')) m.marks[e.name] = e.startTime; return m; })()");
  const nav = await p.eval<{ load: number; dcl: number }>("(() => { const n = performance.getEntriesByType('navigation')[0]; return { load: n.loadEventEnd, dcl: n.domContentLoadedEventEnd }; })()");
  const out = { reqs: t.reqs(), marks: perf.marks, longTasks: perf.longTasks, load: nav.load, dcl: nav.dcl, acceptEncoding: t.acceptEncoding() };
  if (keep) return { ...out, page: p, tracker: t };
  p.close();
  return out;
}

// --- reporting ---------------------------------------------------------------------------------

const kb = (n: number) => (n / 1024).toFixed(n >= 100 * 1024 ? 0 : 1);
const ms = (n: number | undefined) => (n === undefined || Number.isNaN(n) ? "n/a" : n >= 10000 ? `${(n / 1000).toFixed(1)} s` : `${Math.round(n)} ms`);
const median = (xs: number[]) => { const s = xs.filter((x) => x !== undefined && !Number.isNaN(x)).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : NaN; };

function group(r: Req): string {
  const u = new URL(r.url);
  if (u.host !== new URL(location_).host) return `third party: ${u.host}`;
  const p = u.pathname;
  if (p.endsWith(".wasm")) return "wasm (registry)";
  if (p.includes("/vendor/pflow-native-wasm/") || p.endsWith("/petri-wasm.js")) return "wasm glue + command specs";
  if (p.includes("/compose/views/")) return "compose view modules";
  if (p.includes("/compose/assets/") || p.endsWith(".json")) return "compose data (json)";
  if (p.includes("/compose/chyp/")) return "compose chyp files";
  if (p.endsWith(".html")) return "html";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".js") || p.endsWith(".mjs")) return p.includes("/compose/") ? "compose core modules" : "other js (editor modules)";
  if (/\.(png|ico|svg|jpg|webp)$/.test(p)) return "images";
  if (/\.(woff2?|ttf)$/.test(p)) return "fonts";
  return "other";
}
let location_ = "http://127.0.0.1";

function table(loads: Load[], label: string, upTo?: "ready"): string {
  // the median run, by ready time, supplies the request list
  const sorted = [...loads].sort((a, b) => (a.marks.ready ?? 0) - (b.marks.ready ?? 0));
  const med = sorted[Math.floor(sorted.length / 2)];
  const readyAt = med.marks.ready ?? Infinity;
  const reqs = med.reqs.filter((r) => !upTo || (r.endMs !== null && r.endMs <= readyAt + 5));
  const groups = new Map<string, { n: number; wire: number; decoded: number; first: number; last: number }>();
  for (const r of reqs) {
    const g = group(r);
    const e = groups.get(g) ?? { n: 0, wire: 0, decoded: 0, first: Infinity, last: 0 };
    e.n++; e.wire += r.wire; e.decoded += r.decoded; e.first = Math.min(e.first, r.startMs); e.last = Math.max(e.last, r.endMs ?? r.startMs);
    groups.set(g, e);
  }
  const rows = [...groups.entries()].sort((a, b) => b[1].wire - a[1].wire);
  const tot = rows.reduce((a, [, e]) => ({ n: a.n + e.n, wire: a.wire + e.wire, decoded: a.decoded + e.decoded }), { n: 0, wire: 0, decoded: 0 });
  let s = `| ${label} | requests | wire KB | decoded KB | first start | last end |\n|---|---:|---:|---:|---:|---:|\n`;
  for (const [g, e] of rows) s += `| ${g} | ${e.n} | ${kb(e.wire)} | ${kb(e.decoded)} | ${ms(e.first)} | ${ms(e.last)} |\n`;
  s += `| **total${upTo ? " to ready" : ""}** | **${tot.n}** | **${kb(tot.wire)}** | **${kb(tot.decoded)}** | | |\n`;
  return s;
}

function timings(loads: Load[]): string {
  const m = (k: string) => median(loads.map((l) => l.marks[k]));
  return `first-paint ${ms(m("first-paint"))}, first-contentful-paint ${ms(m("first-contentful-paint"))}, DOMContentLoaded ${ms(median(loads.map((l) => l.dcl)))}, shell drawn (tabs + status line) ${ms(m("compose:shell"))}, wasm instantiated ${ms(m("wasm"))}, registry ready ${ms(m("compose:registry-ready"))}, **ready (first view drawn) ${ms(m("ready"))}**, load event ${ms(median(loads.map((l) => l.load)))}, long tasks ${ms(median(loads.map((l) => l.longTasks)))}`;
}

function listing(l: Load): string {
  let s = "| start | end | status | wire B | decoded B | enc | cache-control | etag | url |\n|---:|---:|---:|---:|---:|---|---|---|---|\n";
  for (const r of [...l.reqs].sort((a, b) => a.startMs - b.startMs)) {
    s += `| ${Math.round(r.startMs)} | ${r.endMs === null ? "" : Math.round(r.endMs)} | ${r.failed ?? r.status} | ${r.wire} | ${r.decoded} | ${r.encoding || "-"} | ${r.cacheControl || "-"} | ${r.etag ? "y" : "n"} | ${r.url.replace(/^https?:\/\/[^/]+/, (h) => (h === new URL(location_).origin ? "" : h))} |\n`;
  }
  return s;
}

// --- the views ----------------------------------------------------------------------------------

const VIEWS = ["cospan", "spiders", "operad", "string", "flat", "boundaries", "lens", "incidence", "process", "laws"];

async function viewsReport(chrome: Chrome, url: string, prof: Profile, acceptBr: boolean): Promise<string> {
  const l = await loadOnce(chrome, url, prof, acceptBr, true);
  const p = l.page!, t = l.tracker!;
  let s = "| view | opened in | new requests | new wire KB | third-party requests |\n|---|---:|---:|---:|---|\n";
  const base = url.replace(/#.*/, "");
  for (const v of VIEWS) {
    const before = new Set(t.reqs().map((r) => r.id));
    const t0 = Date.now();
    await p.eval(`location.hash = '#view=${v}&ex=orders'`);
    // a view is drawn when body[data-view] names it (the page sets it at the end of render)
    for (let i = 0; i < 2400; i++) { if (await p.eval<boolean>(`document.body.dataset.view === '${v}' && document.body.dataset.ready === '1'`)) break; await sleep(25); }
    const drawn = Date.now() - t0;
    if (v === "laws") {
      // the live check runs under Pyodide: wait for its terminal state (live, layout failed, or did not run)
      for (let i = 0; i < 2400; i++) {
        const txt = await p.eval<string>(`(document.querySelector('.lw-livebar')||{}).textContent||''`);
        if (/Shown: the live result|did not run|live layout failed/.test(txt)) break;
        await sleep(50);
      }
    }
    await settle(p, t, 800);
    const fresh = t.reqs().filter((r) => !before.has(r.id));
    const tp = fresh.filter((r) => r.host !== new URL(base).host);
    s += `| ${v} | ${v === "laws" ? `${ms(drawn)} (live check: ${ms(Date.now() - t0)})` : ms(drawn)} | ${fresh.length} | ${kb(fresh.reduce((a, r) => a + r.wire, 0))} | ${tp.length ? [...new Set(tp.map((r) => r.host))].map((h) => `${h} x${tp.filter((r) => r.host === h).length} (${kb(tp.filter((r) => r.host === h).reduce((a, r) => a + r.wire, 0))} KB)`).join("; ") : "none"} |\n`;
    if (v === "laws") {
      const failed = fresh.filter((r) => r.failed);
      if (failed.length) s += `| | | | | failed: ${failed.map((r) => `${r.url} (${r.failed})`).join("; ")} |\n`;
      const live = await p.eval<string>(`(document.querySelector('.lw-livebar')||{}).textContent||''`);
      s += `\nLaws live bar: ${live}\n\nThird-party requests while opening Laws:\n\n| host | url | status | wire KB | start | end |\n|---|---|---:|---:|---:|---:|\n`;
      for (const r of tp.sort((a, b) => a.startMs - b.startMs)) s += `| ${r.host} | ${r.url.replace(/^https:\/\/[^/]+/, "")} | ${r.failed ?? r.status} | ${kb(r.wire)} | ${ms(r.startMs)} | ${r.endMs === null ? "" : ms(r.endMs)} |\n`;
    }
  }
  p.close();
  return s;
}

// --- main ---------------------------------------------------------------------------------------

const a = Deno.args;
const opt = (n: string, d?: string) => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : d; };
const flag = (n: string) => a.includes(n);
const url = opt("--url", "http://127.0.0.1:8135/compose.html")!;
location_ = url;
const profiles = opt("--profiles", "none,4g,3g")!.split(",");
const runs = Number(opt("--runs", "3"));
const acceptBr = flag("--accept-br");
const out: Record<string, unknown> = { url, runs, when: new Date().toISOString() };

let md = `# measure-compose-load: ${url}\n\n${new Date().toISOString()}, ${runs} run(s) per cell, medians; Accept-Encoding sent: see below\n\n`;
for (const name of profiles) {
  const prof = PROFILES[name];
  if (!prof) { console.error(`unknown profile ${name}`); Deno.exit(2); }
  const cold: Load[] = [], warm: Load[] = [];
  for (let i = 0; i < runs; i++) {
    const chrome = await launch();
    try {
      cold.push(await loadOnce(chrome, url, prof, acceptBr));
      await sleep(500); // let the disk cache write finish
      warm.push(await loadOnce(chrome, url, prof, acceptBr));
    } finally { await chrome.close(); }
  }
  md += `## ${name}: ${prof.desc}\n\nAccept-Encoding sent by Chrome: \`${cold[0].acceptEncoding || "?"}\`\n\n`;
  md += `### cold\n\n${timings(cold)}\n\n${table(cold, "cold, everything until quiet")}\n${table(cold, "cold, until ready", "ready")}\n`;
  md += `### warm\n\n${timings(warm)}\n\n${table(warm, "warm, everything until quiet")}\n`;
  const warmReqs = warm[0].reqs;
  // Chrome reports a revalidated (304) response as a 200 whose body came from the cache: no body bytes on the wire, a few hundred bytes of headers
  const fromCache = warmReqs.filter((r) => r.cache), revalidated = warmReqs.filter((r) => !r.cache && r.wire === 0 && r.decoded > 0), full = warmReqs.filter((r) => !r.cache && r.wire > 0);
  md += `warm: ${fromCache.length} of ${warmReqs.length} requests served from cache without asking; ${revalidated.length} revalidated (304, headers only, ${kb(revalidated.reduce((x, r) => x + r.transfer, 0))} KB); ${full.length} fetched again in full (${kb(full.reduce((x, r) => x + r.wire, 0))} KB)\n\n`;
  if (name === profiles[0] && flag("--list")) md += `### every request of the first cold run\n\n${listing(cold[0])}\n`;
  out[name] = { cold, warm };
}
if (flag("--views")) {
  const name = profiles[0];
  const chrome = await launch();
  try { md += `## views (${name}): what each view requests when first opened\n\n${await viewsReport(chrome, url, PROFILES[name], acceptBr)}\n`; } finally { await chrome.close(); }
}
console.log(md);
const json = opt("--json");
if (json) await Deno.writeTextFile(json, JSON.stringify(out, null, 1));
Deno.exit(0);
