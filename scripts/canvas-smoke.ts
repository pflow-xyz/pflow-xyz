// Browser check of the composition canvas as an MCP App (cmd/webserver/mcpapp/canvas.html, pflow_canvas).
//
//   deno run -A scripts/canvas-smoke.ts http://127.0.0.1:8080/ [--chrome /path/to/chrome] [--shots dir]
//
// This page plays the host. It reads the tool and the ui:// resource from the server's /mcp as a host does, draws the
// resource in a frame with the sandbox and the CSP the MCP Apps spec gives as the default, answers the view's bridge
// messages, and proxies its tools/call to the real server. Then it uses the canvas with nothing but clicks.
//
// What this cannot show is that Claude itself renders it: that needs a deployed server added as a custom connector.
// Not part of `make test` (it needs Chrome and a running server). Exit status 1 on any failure.

// deno-lint-ignore-file no-explicit-any
import { Page, sleep, startChrome } from "./cdp.ts";

const args = Deno.args;
const base = args.find((a) => a.startsWith("http"));
if (!base) {
  console.error("usage: deno run -A scripts/canvas-smoke.ts <server url> [--chrome path] [--shots dir]");
  Deno.exit(2);
}
const flag = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const CHROME = flag("--chrome") ?? Deno.env.get("CHROME") ?? "/usr/bin/google-chrome";
const SHOTS = flag("--shots");
// Chrome would put a sandboxed frame in its own process, out of this page's frame tree and out of its console: keep it
// in, so the checks can reach the frame's DOM and a CSP violation reaches page.problems.
const { newPage, stop } = await startChrome(CHROME, "canvas-smoke-", ["--disable-features=IsolateSandboxedIframes"]);

let failures = 0, checks = 0;
const ok = (cond: unknown, what: string, detail = "") => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL ${what}${detail ? `: ${detail}` : ""}`); }
};

// The host, evaluated in a same-origin page so it can POST to /mcp. `opts.args` are pflow_canvas's arguments.
const HOST = (opts: { theme: string; args?: unknown; modes?: string[]; updateContext?: boolean }) => `(async () => {
  const opts = ${JSON.stringify(opts)};
  const rpc = async (method, params) => {
    const r = await fetch('/mcp', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return r.json();
  };
  const host = window.__host = { calls: [], sizes: [], modes: [], contexts: [], listed: null, read: null, initialize: null };
  host.initialize = (await rpc('initialize', { protocolVersion: '2025-06-18' })).result;
  host.listed = (await rpc('tools/list', {})).result.tools.find((t) => t.name === 'pflow_canvas');
  const uri = host.listed._meta.ui.resourceUri;
  host.read = (await rpc('resources/read', { uri })).result.contents[0];
  const csp = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' data:; connect-src 'none'";
  const html = host.read.text.replace('<head>', '<head><meta http-equiv="Content-Security-Policy" content="' + csp + '">');
  document.body.replaceChildren();
  document.documentElement.style.background = opts.theme === 'dark' ? '#262624' : '#fff';
  document.body.style.margin = '0';
  const frame = document.createElement('iframe');
  frame.id = 'view';
  frame.setAttribute('sandbox', 'allow-scripts');
  frame.style.cssText = 'border:0;width:100%;height:600px;display:block';
  const send = (m) => frame.contentWindow.postMessage({ jsonrpc: '2.0', ...m }, '*');
  window.addEventListener('message', async (e) => {
    if (e.source !== frame.contentWindow) return;
    const m = e.data;
    if (m.method === 'ui/initialize') {
      host.appInit = m.params;
      send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, hostInfo: { name: 'smoke', version: '1' },
        hostCapabilities: { serverTools: {}, ...(opts.updateContext === false ? {} : { updateModelContext: { text: {} } }) },
        hostContext: { theme: opts.theme, displayMode: 'inline', availableDisplayModes: opts.modes ?? ['inline', 'fullscreen'],
          safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 } } } });
    } else if (m.method === 'ui/notifications/initialized') {
      host.initialized = true;
      const toolArgs = opts.args ?? {};
      send({ method: 'ui/notifications/tool-input', params: { arguments: toolArgs } });
      const r = await rpc('tools/call', { name: 'pflow_canvas', arguments: toolArgs });
      send({ method: 'ui/notifications/tool-result', params: r.result });
    } else if (m.method === 'tools/call') {
      host.calls.push(m.params.name);
      const r = await rpc('tools/call', m.params);
      send(r.error ? { id: m.id, error: r.error } : { id: m.id, result: r.result });
    } else if (m.method === 'ui/notifications/size-changed') {
      host.sizes.push(m.params);
      frame.style.height = m.params.height + 'px';
    } else if (m.method === 'ui/request-display-mode') {
      host.modes.push(m.params.mode);
      send({ id: m.id, result: { mode: m.params.mode } });
    } else if (m.method === 'ui/update-model-context') {
      host.contexts.push(m.params);
      send({ id: m.id, result: {} });
    }
  });
  frame.srcdoc = html;
  document.body.append(frame);
})()`;

/** Evaluate inside the sandboxed frame: an isolated world sees its DOM, and the page never hears of it. */
async function inFrame(page: Page) {
  const { frameTree } = await page.send("Page.getFrameTree");
  const frameId = frameTree.childFrames?.[0]?.frame?.id;
  if (!frameId) throw new Error("no frame");
  const { executionContextId } = await page.send("Page.createIsolatedWorld", { frameId, worldName: "smoke" });
  return async (expression: string) => {
    const r = await page.send("Runtime.evaluate", { expression, contextId: executionContextId, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
}

async function waitIn(view: (e: string) => Promise<any>, expression: string, ms = 15000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await view(expression)) return true;
    await sleep(50);
  }
  return false;
}

async function open(opts: Parameters<typeof HOST>[0], width = 1100, height = 900) {
  const page = await newPage(width, height);
  await page.goto(new URL("mcp.html", base).href);
  page.problems.length = 0; // the docs page is only the origin; what counts starts with the frame
  await page.eval(HOST(opts));
  // The frame's document is settled once the view has finished its handshake; before that its context can go away.
  if (!await page.waitFor(`window.__host.initialized === true`)) throw new Error("the view never finished the handshake");
  const view = await inFrame(page);
  return { page, view };
}

const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  await sleep(150);
  const { data } = await page.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
  await Deno.writeFile(`${SHOTS}/${name}.png`, Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
};

const host = (page: Page, expr: string) => page.eval(`window.__host.${expr}`);
const READY = `document.body.dataset.state === 'ready'`;
const click = (selector: string) => `document.querySelector(${JSON.stringify(selector)}).click()`;
const portSel = (subnet: string, id: string) => `[...document.querySelectorAll('.port')].find((b) => b.dataset.ref === ${JSON.stringify(JSON.stringify([subnet, id]))})`;
const status = `document.getElementById('status').textContent`;

try {
  // --- the wire contract, then the canvas under the default sandbox and CSP --------------------------------------
  console.log("catalog composition, wide");
  {
    const { page, view } = await open({ theme: "light" });
    ok(await waitIn(view, READY), "the canvas draws under the default sandbox and CSP", await view(status));
    ok((await host(page, "initialize.capabilities.extensions"))?.["io.modelcontextprotocol/ui"]?.mimeTypes?.includes("text/html;profile=mcp-app"), "initialize declares the UI extension");
    ok(await host(page, "initialize.capabilities.resources") !== undefined, "initialize declares resources");
    ok((await view(`self.origin`)) === "null", "the frame really is sandboxed, with no origin of its own");
    ok((await view(`document.querySelector('meta[http-equiv="Content-Security-Policy"]')?.content ?? ''`)).includes("connect-src 'none'"), "and carries the default CSP");
    ok((await host(page, "read.mimeType")) === "text/html;profile=mcp-app", "the resource has the MCP App MIME type");
    ok((await host(page, "appInit.appCapabilities.availableDisplayModes"))?.includes("fullscreen"), "the view declares its display modes");
    ok((await host(page, "appInit.appInfo.name")), "the view names itself in ui/initialize");
    ok(await host(page, "initialized"), "the view finishes the handshake");

    ok((await view(`document.querySelectorAll('.part').length`)) === 3, "three parts");
    ok((await view(`document.querySelectorAll('.port').length`)) === 21, "their ports", String(await view(`document.querySelectorAll('.port').length`)));
    ok((await view(`document.querySelectorAll('#wires path').length`)) === 3, "three wires for the three idiom links");
    ok((await view(`document.querySelectorAll('#links-items li').length`)) === 3, "three links listed");
    ok((await view(`document.querySelectorAll('#scenario-items button').length`)) === 4, "four scenarios");
    ok((await view(`document.querySelectorAll('#palette-items button').length`)) === 6, "six catalog parts");
    const sized = await page.eval(`window.__host.sizes.at(-1)`);
    ok(sized?.height > 100, "the view reports its height", JSON.stringify(sized));
    await shot(page, "canvas-light");

    // Pick a port: the lit set is the server's, not the page's.
    await view(`${portSel("orders", "dequeue")}.click()`);
    ok(await waitIn(view, `document.querySelectorAll('.port[data-lit]').length > 0`), "picking a port lights its targets", await view(status));
    ok((await page.eval(`window.__host.calls.includes('pflow_bundle_candidates')`)), "the legal targets come from pflow_bundle_candidates");
    ok((await view(`document.querySelectorAll('.port[data-lit]').length`)) === 14, "orders.dequeue lights the 14 the server says", String(await view(`document.querySelectorAll('.port[data-lit]').length`)));
    await shot(page, "canvas-linking");

    // Esc cancels.
    await view(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
    ok((await view(`document.querySelectorAll('.port[data-lit]').length`)) === 0, "Esc cancels the gesture");

    // Snap: the link is the server's answer, then it validates and Claude is told.
    await view(`${portSel("orders", "dequeue")}.click()`);
    await waitIn(view, `document.querySelectorAll('.port[data-lit]').length > 0`);
    await view(`${portSel("workers", "release")}.click()`);
    ok(await waitIn(view, `document.querySelectorAll('#links-items li').length === 4`), "picking a lit port adds the link", await view(status));
    ok(await waitIn(view, `document.querySelectorAll('#wires path').length === 4`), "and draws its wire");
    ok(await page.waitFor(`window.__host.calls.includes('pflow_bundle_add_link') && window.__host.calls.includes('pflow_bundle_validate')`), "through pflow_bundle_add_link and pflow_bundle_validate");
    ok(await page.waitFor(`window.__host.contexts.length === 1`), "Claude is told about the edit");
    ok((await page.eval(`window.__host.contexts[0].content[0].text`))?.includes("orders.dequeue to workers.release"), "in words and with the composition");

    // Remove it again.
    await view(`[...document.querySelectorAll('#links-items button')].at(-1).click()`);
    ok(await waitIn(view, `document.querySelectorAll('#links-items li').length === 3`), "a link can be removed");
    ok(await page.waitFor(`window.__host.contexts.length === 2`), "and Claude is told that too");

    // A scenario: the worker leak is the catalog's own documented finding.
    await view(click(`[data-scenario="charge-fails"]`));
    ok(await waitIn(view, `document.querySelectorAll('#result .fail').length === 1`), "a scenario shows its predicates", await view(status));
    ok((await view(`document.querySelector('#result .fail').textContent`))?.includes("the worker returns to the pool"), "including the one that does not hold");
    await shot(page, "canvas-scenario");

    // A scenario that stops says where and why.
    await view(click(`[data-scenario="second-order"]`));
    ok(await waitIn(view, `document.getElementById('result').textContent.includes('stopped at step 4')`), "a run that stops says where", await view(`document.getElementById('result').textContent`));
    ok((await view(`document.getElementById('result').textContent`))?.includes("next_reserve"), "and why");

    // Parts: take one out, its links go with it and the scenarios no longer apply.
    await view(click(`[data-part="workers"]`));
    ok(await waitIn(view, `document.querySelectorAll('.part').length === 2`), "a part can be removed", await view(status));
    ok((await view(`document.querySelectorAll('#links-items li').length`)) === 1, "its links go with it");
    ok((await view(status))?.includes("2 links"), "and the status says so", await view(status));
    ok((await view(`document.querySelectorAll('#scenario-items button').length`)) === 0, "the scenarios need all three anchors");
    await view(click(`[data-part="workers"]`));
    ok(await waitIn(view, `document.querySelectorAll('.part').length === 3`), "and put back");

    await view(click(`#fullscreen`));
    ok(await page.waitFor(`window.__host.modes.at(-1) === 'fullscreen'`), "the full screen button asks the host");
    ok(await waitIn(view, `document.getElementById('fullscreen').textContent.includes('Back')`), "and offers the way back");

    ok(page.problems.length === 0, "no CSP or console problem", page.problems.join(" | "));
    await page.close();
  }

  console.log("narrow and dark");
  {
    const { page, view } = await open({ theme: "dark" }, 320, 700);
    ok(await waitIn(view, READY), "draws at 320px");
    ok(await view(`document.documentElement.scrollWidth <= document.documentElement.clientWidth`), "no horizontal scroll at 320px", String(await view(`document.documentElement.scrollWidth`)));
    const small = await view(`[...document.querySelectorAll('button')].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).length`);
    ok(small === 0, "every button is at least 44px tall", String(small));
    ok((await view(`document.documentElement.style.colorScheme`)) === "dark", "the host's theme applies");
    await shot(page, "canvas-narrow-dark");
    ok(page.problems.length === 0, "no CSP or console problem", page.problems.join(" | "));
    await page.close();
  }

  console.log("a host with fewer abilities");
  {
    const { page, view } = await open({ theme: "light", modes: ["inline"], updateContext: false });
    ok(await waitIn(view, READY), "draws");
    ok(await view(`document.getElementById('fullscreen').hidden`), "no full screen button when the host has no full screen");
    await view(click(`#links-items button`));
    ok(await waitIn(view, `document.querySelectorAll('#links-items li').length === 2`), "edits still work without update-model-context");
    await sleep(100);
    ok((await page.eval(`window.__host.contexts.length`)) === 0, "and it does not send one");
    ok(page.problems.length === 0, "no problem", page.problems.join(" | "));
    await page.close();
  }

  console.log("someone else's composition");
  {
    const nasty = `<img src=x onerror="document.title='owned'">`;
    const bundle = {
      "@type": "PetriNetBundle", name: nasty,
      subnets: [
        { id: nasty, net_type: "ResourceNet", model: { places: [{ id: "a", initial: 1, exported: true }], transitions: [{ id: "t" }], arcs: [{ from: "a", to: "t", weight: 1 }] }, ports: [{ id: "a", kind: "out", place: "a" }] },
        { id: "bare", net_type: "ResourceNet", model: { places: [{ id: "b", initial: 0 }], transitions: [], arcs: [] } },
      ],
      links: [],
    };
    const { page, view } = await open({ theme: "light", args: { bundle } });
    ok(await waitIn(view, READY), "a composition passed in the call draws", await view(status));
    ok((await view(`document.querySelectorAll('img').length`)) === 0, "its text is text, never markup");
    ok((await view(`document.title`)) !== "owned", "nothing in it runs");
    ok((await view(`document.getElementById('palette').hidden`)), "no parts palette: it did not come from the catalog");
    ok((await view(`document.querySelector('[data-subnet="bare"]').textContent`))?.includes("no ports"), "a part with no ports says so");
    await page.close();
  }

  console.log("refusals");
  {
    const { page, view } = await open({ theme: "light", args: { instances: ["nope"] } });
    ok(await waitIn(view, `document.body.dataset.state === 'failed'`), "a refused call says why rather than hanging", await view(status));
    ok((await view(status))?.length > 0, "with the tool's words", await view(status));
    await page.close();
  }

  console.log("outside a host");
  {
    const page = await newPage(800, 600);
    await page.goto(new URL("mcp.html", base).href);
    const html = await page.eval(`fetch('/mcp',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'resources/read',params:{uri:'ui://pflow/canvas'}})}).then(r=>r.json()).then(j=>j.result.contents[0].text)`);
    await page.eval(`document.open(); document.write(${JSON.stringify(html)}); document.close();`);
    ok(await page.waitFor(`document.getElementById('status').textContent.includes('MCP host')`), "opened on its own it says it needs a host");
    await page.close();
  }
} catch (error) {
  failures++;
  console.log(`  FAIL ${(error as Error).stack ?? error}`);
} finally {
  await stop();
}

console.log(`${checks - failures}/${checks} checks passed`);
Deno.exit(failures ? 1 : 0);
