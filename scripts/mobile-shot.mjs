#!/usr/bin/env node
// mobile-shot.mjs — headless-Chrome mobile screenshotter for manual QA.
//
// Drives Chrome over raw CDP (no deps) with a phone-sized viewport, touch
// emulation and a mobile UA, so the mobile media queries and _isNarrowViewport()
// take the same branch a real phone does.
//
//   node scripts/mobile-shot.mjs <url> <out.png> [WxH] [--dark] [--wait ms] [--eval 'js']
//
// Example:
//   node scripts/mobile-shot.mjs 'http://127.0.0.1:3999/?cid=...' /tmp/a.png 390x844

import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, def = null) => {
    const i = args.indexOf(name);
    if (i === -1) return def;
    const v = args[i + 1];
    args.splice(i, v === undefined || v.startsWith('--') ? 1 : 2);
    return v === undefined || v.startsWith('--') ? true : v;
};

const dark = !!flag('--dark', false);
const waitMs = Number(flag('--wait', 2500));
const evalJs = flag('--eval', null);
const [url, out, size = '390x844'] = args;

if (!url || !out) {
    console.error('usage: mobile-shot.mjs <url> <out.png> [WxH] [--dark] [--wait ms] [--eval js]');
    process.exit(2);
}

const [width, height] = size.split('x').map(Number);
const PORT = 9222 + (process.pid % 500);

const profile = await mkdtemp(join(tmpdir(), 'pflow-shot-'));
const chrome = spawn('google-chrome', [
    '--headless=new',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
    for (let i = 0; i < 100; i++) {
        try {
            const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
            const list = await res.json();
            const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
            if (page) return page.webSocketDebuggerUrl;
        } catch { /* chrome not up yet */ }
        await sleep(100);
    }
    throw new Error('chrome debug endpoint never came up');
}

const wsUrl = await findTarget();
const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let msgId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id);
        pending.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    }
};
const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++msgId;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
});

try {
    await send('Page.enable');
    await send('Runtime.enable');
    await send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 3, mobile: true,
        screenWidth: width, screenHeight: height,
    });
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await send('Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' });
    await send('Emulation.setUserAgentOverride', {
        userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
            + '(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    });
    await send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
    });

    await send('Page.navigate', { url });
    await sleep(waitMs);
    if (evalJs) {
        const r = await send('Runtime.evaluate', { expression: evalJs, awaitPromise: true, returnByValue: true });
        if (r.result?.value !== undefined) console.error('[eval]', JSON.stringify(r.result.value));
        await sleep(800);
    }

    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(out, Buffer.from(data, 'base64'));
    console.log(out);
} finally {
    ws.close();
    chrome.kill();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
}
