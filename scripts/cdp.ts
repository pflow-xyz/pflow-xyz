// A minimal driver for headless Chrome over the DevTools protocol: nothing to install. Used by the
// browser checks (a11y-smoke.ts, views-smoke.ts).

// deno-lint-ignore-file no-explicit-any
const KEYS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Escape: { code: "Escape", vk: 27 },
  Tab: { code: "Tab", vk: 9 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
};

export class Page {
  private n = 0;
  private waiting = new Map<number, (v: any) => void>();
  private loaded: (() => void) | null = null;
  problems: string[] = [];
  paused: string[] = []; // requests held by hold() (Fetch.requestPaused)
  onPaused: ((request: any) => void) | null = null; // answer intercepted requests yourself, instead of holding them
  failAll = false;       // fail what hold() matches at once (an offline network) instead of holding it
  close: () => Promise<void> = async () => {};
  constructor(private ws: WebSocket) {
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data as string);
      if (m.id !== undefined) { this.waiting.get(m.id)?.(m); this.waiting.delete(m.id); return; }
      const p = m.params ?? {};
      if (m.method === "Page.loadEventFired") this.loaded?.();
      else if (m.method === "Fetch.requestPaused" && this.onPaused) this.onPaused(p);
      else if (m.method === "Fetch.requestPaused") { if (this.failAll) this.send("Fetch.failRequest", { requestId: p.requestId, errorReason: "InternetDisconnected" }).catch(() => {}); else this.paused.push(p.requestId); }
      else if (m.method === "Runtime.exceptionThrown") this.problems.push(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`);
      else if (m.method === "Runtime.consoleAPICalled" && (p.type === "error" || p.type === "assert")) this.problems.push(`console.${p.type}: ${(p.args ?? []).map((a: any) => a.value ?? a.description).join(" ")}`);
      else if (m.method === "Log.entryAdded" && p.entry?.level === "error") this.problems.push(`log.error: ${p.entry.text} ${p.entry.url ?? ""}`);
      else if (m.method === "Network.loadingFailed" && !p.canceled) this.problems.push(`request failed: ${p.errorText}`);
      else if (m.method === "Network.responseReceived" && p.response?.status >= 400) this.problems.push(`HTTP ${p.response.status}: ${p.response.url}`);
    };
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    const id = ++this.n;
    return new Promise((res, rej) => {
      this.waiting.set(id, (m) => (m.error ? rej(new Error(m.error.message)) : res(m.result)));
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async init(width = 1280, height = 900) {
    for (const d of ["Page", "Runtime", "Log", "Network"]) await this.send(`${d}.enable`);
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  }
  async goto(u: string) {
    const loaded = new Promise<void>((r) => { this.loaded = r; });
    await this.send("Page.navigate", { url: u });
    await loaded;
  }
  // deno-lint-ignore no-explicit-any
  async eval(expr: string): Promise<any> {
    const r = await this.send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }
  async press(key: string, shift = false) {
    const k = KEYS[key] ?? { code: `Key${key.toUpperCase()}`, vk: key.toUpperCase().charCodeAt(0), text: key };
    const modifiers = shift ? 8 : 0;
    await this.send("Input.dispatchKeyEvent", { type: k.text ? "keyDown" : "rawKeyDown", key, code: k.code, windowsVirtualKeyCode: k.vk, text: k.text, modifiers });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, code: k.code, windowsVirtualKeyCode: k.vk, modifiers });
    await sleep(40);
  }
  async click(x: number, y: number) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mousePressed" ? 1 : 0 });
    await sleep(100);
  }
  /** Hold the requests whose URL matches (before navigating); fail() ends them as an offline network would. */
  async hold(patterns: string[]) {
    await this.send("Fetch.enable", { patterns: patterns.map((urlPattern) => ({ urlPattern, requestStage: "Request" })) });
  }
  async fail() {
    for (const requestId of this.paused.splice(0)) await this.send("Fetch.failRequest", { requestId, errorReason: "InternetDisconnected" }).catch(() => {});
  }
  async waitFor(expr: string, ms = 20000): Promise<boolean> {
    for (let t = 0; t < ms; t += 100) { if (await this.eval(expr)) return true; await sleep(100); }
    return false;
  }
}
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Start Chrome: newPage(width, height) opens a page, stop() ends it all. */
export async function startChrome(CHROME: string, prefix: string) {
  const port = 9300 + Math.floor(Math.random() * 600);
  const profile = await Deno.makeTempDir({ prefix });
  const chrome = new Deno.Command(CHROME, {
    args: ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--disable-gpu", "--disable-extensions", "about:blank"],
    stdout: "null", stderr: "null",
  }).spawn();
  // Chrome takes a moment to listen.
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/json/version`); await r.body?.cancel(); if (r.ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  async function newPage(width = 1280, height = 900): Promise<Page> {
    const t = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })).json();
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const p = new Page(ws);
    p.close = async () => { ws.close(); try { const r = await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`); await r.body?.cancel(); } catch { /* gone */ } };
    await p.init(width, height);
    return p;
  }
  async function stop() {
    try { chrome.kill("SIGTERM"); } catch { /* gone */ }
    try { await chrome.status; } catch { /* ignore */ }
    try { await Deno.remove(profile, { recursive: true }); } catch { /* ignore */ }
  }
  return { newPage, stop };
}
