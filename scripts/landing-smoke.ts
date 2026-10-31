// Browser check of the landing chat (public/petri-landing.js, docs/landing-chat.md).
//
//   deno run -A scripts/landing-smoke.ts http://127.0.0.1:8080/ [--chrome /path/to/chrome]
//
// In headless Chrome: what a signed-out visitor sees and where each route goes, and the sessions a signed-in
// one gets. It cannot sign in to GitHub, so a signed-in page has its fetch of /api/llm/status, /api/llm/turn and
// /auth/user answered in the page: this proves the route, the mode and the message reach the Assistant's
// request, and says nothing about Gemini or the real sign-in.
//
// Not part of `make test` (it needs Chrome and a running server). Exit status 1 on any failure.
import { sleep, startChrome } from "./cdp.ts";

const url = Deno.args.find((a) => a.startsWith("http"));
if (!url) { console.error("usage: deno run -A scripts/landing-smoke.ts <url of /> [--chrome path]"); Deno.exit(2); }
const chromeArg = Deno.args.indexOf("--chrome");
const CHROME = chromeArg >= 0 ? Deno.args[chromeArg + 1] : Deno.env.get("CHROME") ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const { newPage, stop } = await startChrome(CHROME, "landing-smoke-");

let failures = 0, checks = 0;
const ok = (cond: unknown, what: string, detail = "") => {
  checks++;
  if (!cond) { failures++; console.log(`  FAIL ${what}${detail ? `: ${detail}` : ""}`); }
};
const q = (s: string) => JSON.stringify(s);
const text = (sel: string) => `(document.querySelector(${q(sel)})?.textContent || '')`;

/** Before any script: a signed-in session, with the model's route answered here and the requests kept. */
const SIGNED_IN = (seed = "") => `
  window.__turns = [];
  try { localStorage.setItem('pflow_auth_token', 'smoke-token'); ${seed} } catch {}
  const real = window.fetch;
  const json = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'Content-Type': 'application/json' } });
  window.fetch = async (u, opts) => {
    const path = new URL(String(u?.url ?? u), location.href).pathname;
    // As the server: signed in only with the token, so the page must have it by the time it asks.
    const bearer = new Headers(opts?.headers).get('Authorization') === 'Bearer smoke-token';
    if (path === '/api/llm/status') return json(bearer ? { enabled: true, chat: true, signed_in: true, allowed: true, model: 'smoke', remaining_today: 7 } : { enabled: true, chat: true, signed_in: false });
    if (path === '/auth/user') return bearer ? json({ user: { id: '1', email: '', user_name: 'smoke', full_name: 'Smoke' } }) : new Response('{}', { status: 401 });
    if (path === '/api/llm/turn') {
      if (!bearer) return new Response('{"error":"sign in"}', { status: 401 });
      const body = JSON.parse(opts.body);
      window.__turns.push(body);
      return json({ reply: 'smoke reply', tool_calls: [], message: { role: 'model', parts: [{ text: 'smoke reply' }] }, remaining_today: 6, mode: body.mode === 'auto' ? 'analyse' : body.mode });
    }
    return real(u, opts);
  };`;

// One Chrome profile serves every page here, and showEditor() remembers pflow_skip_landing: each page starts clean.
const CLEAN = `try { localStorage.clear(); sessionStorage.clear(); } catch {}`;
// The example cards' thumbnails are stored nets: a scratch server's empty store answers 404 for them.
const problemsOf = (p: any) => p.problems.filter((x: string) => !/\/img\/z\w+\.svg/.test(x));

async function open(path: string, before?: string, width = 1280, height = 900) {
  const p = await newPage(width, height);
  await p.send("Page.addScriptToEvaluateOnNewDocument", { source: CLEAN + (before ?? "") });
  await p.goto(new URL(path, url).href);
  return p;
}
const routed = (p: any) => p.waitFor(`document.querySelector('#landing-chat-hint')?.textContent.length > 0`, 20000);

try {
  console.log(`landing smoke: ${url}`);

  console.log("signed out");
  {
    const p = await open("/");
    ok(await routed(p), "the page opens on the prompt", problemsOf(p).join(" | "));
    ok(await p.eval(`document.getElementById('landing').style.display !== 'none' && document.getElementById('editor-wrapper').style.display === 'none'`), "the landing is shown, the editor is not");
    ok(await p.eval(`document.getElementById('landing-chat-q').tagName === 'H1' && document.querySelector('#landing-chat-input').getAttribute('aria-labelledby') === 'landing-chat-q'`), "the prompt is the page's heading and names the box");
    ok(await p.waitFor(`${text("#landing-chat-state")}.includes('GitHub sign-in')`, 15000), "it says the chat needs a sign-in, before anyone types");
    ok(await p.eval(`${text("#landing-chat-send")} === 'Sign in with GitHub and start'`), "the button says what it does");
    ok(await p.eval(`!document.getElementById('landing-chat-connector').hidden && !!document.querySelector('#landing-chat-connector a[href="/mcp.html"]')`), "the connector is offered");
    ok(problemsOf(p).length === 0, "no console problems", problemsOf(p).join(" | "));

    // what is typed waits in the tab; the redirect itself is GitHub's
    await p.eval(`document.querySelector('petri-view')._loginWithGitHub = () => { window.__login = true; }`);
    await p.eval(`document.querySelector('#landing-chat-input').value = 'a coffee shop'`);
    await p.eval(`document.querySelector('input[value="design"]').click()`);
    await p.eval(`document.querySelector('#landing-chat-send').click()`);
    ok(await p.waitFor(`window.__login === true`, 5000), "submitting starts the sign-in");
    ok((await p.eval(`sessionStorage.getItem('pflow_landing_pending')`)) === JSON.stringify({ route: "design", message: "a coffee shop" }), "the words and the route wait in the tab");
    await p.close();
  }
  {
    const p = await open("/");
    await routed(p);
    await p.eval(`document.querySelector('input[value="explore"]').click()`);
    ok(await p.waitFor(`${text("#landing-chat-send")} === 'Explore'`, 5000), "Explore needs no sign-in");
    await p.eval(`document.querySelector('#landing-chat-send').click()`);
    ok(await p.waitFor(`location.pathname === '/compose.html'`, 15000), "Explore opens the composition page");
    ok(await p.waitFor(`!!document.querySelector('a[href="/?route=design"]')`, 45000), "and it links back to a design session");
    await p.close();
  }
  {
    const p = await open("/");
    await routed(p);
    await p.eval(`document.getElementById('open-editor-btn').click()`);
    ok(await p.waitFor(`document.getElementById('editor-wrapper').style.display === 'block'`, 5000), "the editor is one click away");
    ok(!(await p.eval(`!!document.querySelector('.pv-chat')`)), "and opens with no chat nobody asked for");
    await p.close();
  }

  console.log("signed in, on the page");
  for (const [route, mode] of [["auto", "auto"], ["design", "build"], ["analyse", "analyse"], ["explain", "explain"]]) {
    const p = await open("/", SIGNED_IN());
    await routed(p);
    ok(await p.waitFor(`${text("#landing-chat-state")}.includes('7 model calls left today')`, 15000), `${route}: the quota line`);
    await p.eval(`document.querySelector('input[value=${q(route)}]').click()`);
    await p.eval(`document.querySelector('#landing-chat-input').value = 'where does it jam?'`);
    await p.eval(`document.querySelector('#landing-chat-send').click()`);
    ok(await p.waitFor(`document.querySelector('.pv-chat-user')?.textContent === 'where does it jam?'`, 20000), `${route}: the message opens the session`, problemsOf(p).join(" | "));
    ok(await p.waitFor(`window.__turns.length > 0`, 20000), `${route}: the Assistant asks the proxy`);
    ok((await p.eval(`window.__turns[0].mode`)) === mode, `${route}: in mode ${mode}`, await p.eval(`window.__turns[0].mode`));
    ok(await p.eval(`JSON.stringify(window.__turns[0].messages).includes('where does it jam?')`), `${route}: with the words`);
    ok(await p.waitFor(`document.querySelector('.pv-chat-assistant')?.textContent === 'smoke reply'`, 10000), `${route}: the reply shows beside the canvas`);
    ok(await p.eval(`document.getElementById('editor-wrapper').style.display === 'block' && document.getElementById('landing').style.display === 'none'`), `${route}: the canvas is there`);
    ok(problemsOf(p).length === 0, `${route}: no console problems`, problemsOf(p).join(" | "));
    await p.close();
  }

  console.log("back from the sign-in, and links");
  {
    const seed = `sessionStorage.setItem('pflow_landing_pending', ${q(JSON.stringify({ route: "design", message: "a queue" }))});`;
    const p = await open("/", SIGNED_IN(seed));
    ok(await p.waitFor(`document.querySelector('.pv-chat-user')?.textContent === 'a queue'`, 20000), "what was typed before the sign-in is sent after it");
    ok((await p.eval(`window.__turns[0]?.mode`)) === "build", "in the route that was chosen");
    ok((await p.eval(`sessionStorage.getItem('pflow_landing_pending')`)) === null, "once");
    await p.close();
  }
  {
    const p = await open("/?route=analyse", SIGNED_IN());
    ok(await p.waitFor(`document.querySelector('.pv-chat-mode.pv-active')?.dataset.mode === 'analyse'`, 20000), "?route= opens the Assistant in that mode");
    ok((await p.eval(`window.__turns.length`)) === 0, "and sends nothing by itself");
    await p.close();
  }
  {
    const p = await open("/?route=design");
    ok(await p.waitFor(`document.querySelector('.pv-chat-log')?.textContent.includes('GitHub sign-in')`, 20000), "?route= signed out: the panel asks for the sign-in");
    await p.close();
  }
  {
    const p = await open("/", `try { localStorage.setItem('pflow_skip_landing', '1'); } catch {}`);
    ok(await p.waitFor(`document.getElementById('editor-wrapper').style.display === 'block'`, 15000), "a returning visitor still lands in the editor");
    await sleep(500);
    ok(!(await p.eval(`!!document.querySelector('.pv-chat')`)), "with no chat opened");
    await p.close();
  }

  console.log("a phone");
  {
    const p = await open("/", undefined, 390, 780);
    await routed(p);
    ok(await p.eval(`document.documentElement.scrollWidth <= window.innerWidth`), "no sideways scroll", String(await p.eval(`document.documentElement.scrollWidth`)));
    ok(await p.eval(`(() => { const r = document.querySelector('#landing-chat-input').getBoundingClientRect(); return r.left >= 0 && r.right <= window.innerWidth && r.top >= 0; })()`), "the prompt fits");
    ok(await p.eval(`document.querySelector('#landing-chat-send').getBoundingClientRect().bottom <= document.documentElement.scrollHeight`), "the button is on the page");
    ok(await p.eval(`document.querySelector('#landing-chat-q').getBoundingClientRect().top >= document.querySelector('.landing-nav').getBoundingClientRect().bottom`), "the heading clears the nav");
    ok(await p.eval(`document.querySelector('.landing-hero-buttons').getBoundingClientRect().bottom <= document.querySelector('.landing-hero').getBoundingClientRect().bottom`), "the hero holds its buttons");
    await p.close();
  }
} finally {
  await stop();
}
console.log(`\n${checks - failures}/${checks} checks passed${failures ? `, ${failures} FAILED` : ""}`);
Deno.exit(failures ? 1 : 0);
