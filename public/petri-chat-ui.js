// petri-chat-ui.js — the Assistant panel: a dockable chat beside the net.
//
// The loop is petri-chat.js; this file is its view. The panel is not modal,
// so the net stays on screen (ROADMAP: "the guided flow should end with a net
// they can see, read and edit"). The Tools section says what the assistant can
// use and what it has used: every call is listed with its arguments and result,
// and can be rerun or copied as an MCP call. Pending edits show as a diff with
// Apply / Discard. <petri-view> loads this only when /api/llm/status reports the
// chat available.
//
// Wording rule (as for drafting): replies are the assistant's; results are
// the engines'. The panel never restyles a reply as a result.

import { fitPanel } from './petri-panel-frame.js';

const MODES = [['auto', 'Auto'], ['build', 'Build'], ['analyse', 'Analyse'], ['explain', 'Explain']];

// The Tools section's groups, by the command's prefix. One that is not named here is listed under its prefix.
const TOOL_GROUPS = { file: 'File', edit: 'Edit', net: 'Net', sim: 'Simulate', opt: 'Optimize', analysis: 'Analysis', view: 'Canvas', artifact: 'Results' };

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

let manifestPromise = null;
function loadManifest() {
    manifestPromise ||= fetch(new URL('./llm-tools.json', import.meta.url)).then((r) => {
        if (!r.ok) throw new Error(`tool manifest: ${r.status}`);
        return r.json();
    });
    return manifestPromise;
}

function turnPoster(view) {
    return async (body) => {
        const res = await fetch('/api/llm/turn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${view._authToken}` },
            body: JSON.stringify(body),
        });
        const out = await res.json().catch(() => ({}));
        if (!res.ok) {
            const wait = res.status === 429 && out.retry_after_s ? ` (try again in ${out.retry_after_s < 120 ? `${out.retry_after_s} s` : `${Math.round(out.retry_after_s / 3600)} h`})` : '';
            throw new Error(`${out.error || `the assistant failed (${res.status})`}${wait}`);
        }
        return out;
    };
}

/**
 * Open (or focus) the Assistant panel. `message` is sent as the first turn (the landing page's prompt); it waits in
 * the box for someone who cannot send it yet.
 */
export async function openChat(view, { mode, message } = {}) {
    if (view._chatPanel?.isConnected) {
        if (mode) view._chatPanel._setMode(mode);
        const box = view._chatPanel.querySelector('.pv-chat-input');
        if (message) box.value = message;
        box.focus();
        return view._chatPanel;
    }
    const [stepsMod, R, manifest, reg, status] = await Promise.all([
        import('./petri-chat.js'), import('./petri-results.js'), loadManifest(), view.commands(), view._llmStatus(true),
    ]);
    const { ChatSession } = stepsMod;
    if (!view._solverModule) view._solverModule = await import('./petri-solver.js');

    const panel = document.createElement('aside');
    panel.className = 'pv-chat';
    panel.setAttribute('aria-label', 'Assistant');
    panel.innerHTML = `
        <div class="pv-chat-head">
            <strong>Assistant</strong>
            <div class="pv-chat-modes" role="tablist">${MODES.map(([m, l]) => `<button type="button" class="pv-btn pv-chat-mode" data-mode="${m}" role="tab">${l}</button>`).join('')}</div>
            <button type="button" class="pv-btn" data-act="new" title="Start a new conversation">New</button>
            <button type="button" class="pv-dialog-close-icon" data-act="close" title="Close">×</button>
        </div>
        <div class="pv-chat-steps" hidden></div>
        <div class="pv-chat-quota pv-result-dim"></div>
        <div class="pv-chat-detected pv-result-dim" hidden></div>
        <div class="pv-chat-log" aria-live="polite"></div>
        <div class="pv-chat-pending" hidden></div>
        <details class="pv-chat-tools">
            <summary>Tools <span class="pv-chat-tools-count pv-result-dim"></span></summary>
            <div class="pv-chat-tools-runs">
                <div class="pv-chat-tools-head">Run in this conversation</div>
                <p class="pv-chat-calls-empty pv-result-dim">None yet. Each tool the assistant runs is listed here with its arguments and result, to rerun or copy as an MCP call.</p>
                <ol class="pv-chat-calls"></ol>
            </div>
            <div class="pv-chat-tools-head">What it can use</div>
            <p class="pv-chat-tools-note pv-result-dim" hidden></p>
            <div class="pv-chat-avail"></div>
        </details>
        <div class="pv-chat-status pv-result-dim"></div>
        <form class="pv-chat-form">
            <textarea class="pv-chat-input" rows="2" placeholder="Ask about the net, or say what to build…"></textarea>
            <button type="submit" class="pv-btn pv-btn-primary">Send</button>
        </form>`;
    document.body.appendChild(panel);
    view._chatPanel = panel;
    const $ = (s) => panel.querySelector(s);
    const log = $('.pv-chat-log');
    fitPanel(view, panel, {
        around: (apply) => {
            const pinned = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
            apply();
            if (pinned) log.scrollTop = log.scrollHeight; // the newest message stays in sight as the panel shrinks
        },
    });

    if (!status.signed_in) {
        log.innerHTML = `<p>The assistant uses Gemini, so it needs a GitHub sign-in to apply a fair-use limit.</p>
            <button type="button" class="pv-btn pv-btn-primary" data-act="login">🔑 Login with GitHub</button>`;
        $('[data-act="login"]').addEventListener('click', () => view._loginWithGitHub());
        $('.pv-chat-form').hidden = true;
    }
    if (status.remaining_today !== undefined) $('.pv-chat-quota').textContent = `${status.remaining_today} model calls left today`;

    let chat = new ChatSession({ live: reg, manifest, post: turnPoster(view), mode: mode || 'auto' });
    // The count is of the tools there are, then of the calls made: a bare count of calls read 0 on every new conversation,
    // as if there were no tools at all.
    let listed = null;
    const renderTools = () => {
        const tools = chat.tools;
        const runs = chat.calls.length;
        $('.pv-chat-tools-count').textContent = status.signed_in
            ? `${tools.length} available, ${runs ? `${runs} run` : 'none run yet'}`
            : `${tools.length} after sign-in`;
        $('.pv-chat-tools-runs').hidden = !status.signed_in;
        $('.pv-chat-calls-empty').hidden = runs > 0;
        const left = manifest.tools.length - tools.length;
        const note = $('.pv-chat-tools-note');
        note.hidden = status.signed_in && !left;
        note.textContent = !status.signed_in ? 'Sign in and the assistant can use these on your net.' : left ? `Explain mode does not edit, so the ${left} tools that do are left out.` : '';
        if (listed === tools.length) return; // the list changes with the mode, and redrawing it would close what is open
        listed = tools.length;
        const groups = new Map();
        for (const t of tools) {
            const prefix = t.command.split('.')[0];
            const name = TOOL_GROUPS[prefix] || prefix[0].toUpperCase() + prefix.slice(1);
            groups.set(name, [...(groups.get(name) || []), t]);
        }
        $('.pv-chat-avail').innerHTML = [...groups].map(([name, ts]) => `<details class="pv-chat-avail-group"><summary>${esc(name)} <span class="pv-result-dim">(${ts.length})</span></summary>
            <ul>${ts.map((t) => `<li><code>${esc(t.command)}</code> ${esc(t.description)}</li>`).join('')}</ul></details>`).join('');
    };
    const renderSteps = () => {
        const box = $('.pv-chat-steps');
        box.hidden = chat.effectiveMode !== 'build';
        const { STEPS } = stepsMod;
        const at = STEPS.indexOf(chat.step);
        box.innerHTML = STEPS.map((s, i) => `<button type="button" class="pv-chat-step${i === at ? ' pv-active' : i < at ? ' pv-chat-step-past' : ''}" data-step="${s}" title="Move the interview to ${s}">${s}</button>`).join('');
        box.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => { chat.step = b.dataset.step; renderSteps(); }));
    };
    const setMode = (m) => {
        chat.setMode(m);
        panel.querySelectorAll('.pv-chat-mode').forEach((b) => {
            const on = b.dataset.mode === m;
            b.classList.toggle('pv-active', on);
            b.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        renderSteps(); // after chat.setMode: the row is shown or hidden by the mode just chosen
        renderTools();
    };
    panel._setMode = setMode;
    setMode(chat.mode);
    panel.querySelectorAll('.pv-chat-mode').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

    const FEELS = { frustrated: 'sounds frustrated', confused: 'sounds unsure', positive: 'sounds happy' };
    // Auto mode: show what it picked, with a button per mode to override it
    // (the next message then runs in that mode, as if chosen by hand).
    const showDetected = (a) => {
        const box = $('.pv-chat-detected');
        const label = MODES.find(([m]) => m === a.mode)[1];
        const feel = FEELS[a.sentiment] ? ` · ${FEELS[a.sentiment]}` : '';
        box.hidden = false;
        box.innerHTML = `Detected: <strong>${esc(label)}</strong>${a.fallback ? ' (unsure, kept the previous mode)' : ''}${esc(feel)}
            ${MODES.filter(([m]) => m !== 'auto' && m !== a.mode).map(([m, l]) => `<button type="button" class="pv-btn" data-force="${m}">Use ${esc(l)}</button>`).join('')}`;
        box.querySelectorAll('[data-force]').forEach((b) => b.addEventListener('click', () => { setMode(b.dataset.force); box.hidden = true; }));
        if (a.sentiment === 'frustrated' || a.sentiment === 'confused') $('.pv-chat-input').placeholder = 'Say what is unclear, or ask me to explain step by step…';
    };

    const say = (who, text) => {
        const p = document.createElement('div');
        p.className = `pv-chat-msg pv-chat-${who}`;
        p.textContent = text;
        log.appendChild(p);
        log.scrollTop = log.scrollHeight;
    };

    const renderPending = async () => {
        const box = $('.pv-chat-pending');
        if (!chat.pending) { box.hidden = true; box.innerHTML = ''; return; }
        let gate = '';
        try {
            const w = await chat.weights();
            const parts = (r) => [...r.dead_transitions.map((t) => `dead ${t}`), ...r.unmarked_siphons.map((s) => `empty siphon {${s.join(', ')}}`),
                ...r.unreachable_goals.map((g) => `unreachable goal: ${g}`), ...r.lost_laws.map((l) => `lost law ${l}`)];
            gate = `<p class="${w.worse ? 'pv-chat-err' : 'pv-result-dim'}">Defect weight ${w.before.weight} → ${w.after.weight}${w.worse ? ': these edits make the net worse' : ''}.
                ${parts(w.after).length ? `<br>${esc(parts(w.after).join('; '))}` : ''}</p>`;
            box.dataset.worse = w.worse ? '1' : '';
        } catch { /* the gate is advice */ }
        const d = chat.diff();
        const lines = [...d.added.map((x) => `+ ${x}`), ...d.removed.map((x) => `− ${x}`), ...d.changed.map((x) => `~ ${x}`),
            ...d.arcsAdded.map((x) => `+ arc ${x}`), ...d.arcsRemoved.map((x) => `− arc ${x}`)];
        box.hidden = false;
        box.innerHTML = `<strong>Pending edits</strong> (not on the net yet)
            <ul>${lines.slice(0, 30).map((l) => `<li><code>${esc(l)}</code></li>`).join('')}${lines.length > 30 ? `<li>… ${lines.length - 30} more</li>` : ''}${d.empty ? '<li>no structural change (marking or undo only)</li>' : ''}</ul>
            ${gate}
            <button type="button" class="pv-btn pv-btn-primary" data-act="apply">${box.dataset.worse ? 'Apply anyway' : 'Apply'} (one undo step)</button>
            <button type="button" class="pv-btn" data-act="discard">Discard</button>`;
        box.querySelector('[data-act="apply"]').addEventListener('click', () => { chat.apply(); renderPending(); say('note', 'Applied. Undo brings the previous net back.'); });
        box.querySelector('[data-act="discard"]').addEventListener('click', () => { chat.discard(); renderPending(); say('note', 'Discarded the pending edits.'); });
    };

    const renderCall = (entry) => {
        const li = document.createElement('li');
        li.className = entry.ok ? 'pv-chat-call' : 'pv-chat-call pv-chat-call-err';
        const args = JSON.stringify(entry.args);
        li.innerHTML = `<code>${esc(entry.command || entry.name)}</code> <span class="pv-result-dim">${esc(args.length > 120 ? args.slice(0, 117) + '…' : args)} · ${entry.ms} ms</span>
            ${entry.ok ? '' : `<div class="pv-chat-err">${esc(entry.error)}</div>`}
            <div class="pv-chat-call-acts">
                ${entry.artifacts.map((id) => `<button type="button" class="pv-btn" data-show="${esc(id)}">${esc(id)}</button>`).join('')}
                <button type="button" class="pv-btn" data-act="rerun">Rerun</button>
                <button type="button" class="pv-btn" data-act="mcp">Copy MCP call</button>
            </div>
            <div class="pv-chat-art"></div>`;
        li.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => {
            const art = reg.artifact(b.dataset.show);
            const box = li.querySelector('.pv-chat-art');
            const r = R.renderArtifact(view._solverModule, art, { width: 520, height: 300 });
            box.innerHTML = `<div class="pv-result-dim">${esc(art.title)}</div>${r.svg || ''}${r.html}`;
            if (r.plotData) view._solverModule.SVGPlotter.setupInteractivity(r.plotData);
            R.wireArtifact(box, art, (cid, cargs) => reg.execute(cid, cargs), (m) => say('note', m));
        }));
        li.querySelector('[data-act="rerun"]').addEventListener('click', async () => {
            const again = await chat.rerun(entry);
            renderCall(again);
            renderPending();
        });
        li.querySelector('[data-act="mcp"]').addEventListener('click', () =>
            view._copyMcpCall({ source: { command: entry.command || entry.name, args: entry.args } }));
        $('.pv-chat-calls').appendChild(li);
        renderTools();
    };

    $('[data-act="new"]').addEventListener('click', () => {
        const m = chat.mode;
        chat = new ChatSession({ live: reg, manifest, post: turnPoster(view), mode: m });
        $('.pv-chat-detected').hidden = true;
        log.innerHTML = '';
        $('.pv-chat-calls').innerHTML = '';
        renderSteps(); // a new session has no auto label yet
        renderTools();
        renderPending();
    });
    $('[data-act="close"]').addEventListener('click', () => panel.remove());

    const input = $('.pv-chat-input');
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('.pv-chat-form').requestSubmit(); }
    });
    $('.pv-chat-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        // On a phone an open Tools section stands in for the log (petri-view.css): the answer has to be in sight.
        if (!log.clientHeight) $('.pv-chat-tools').open = false;
        say('user', text);
        const send = $('.pv-chat-form button');
        send.disabled = true;
        try {
            const out = await chat.send(text, (ev) => {
                if (ev.type === 'round') $('.pv-chat-status').textContent = ev.round === 1 ? 'Thinking…' : `Thinking… (step ${ev.round})`;
                if (ev.type === 'reply') say('assistant', ev.text);
                if (ev.type === 'call') { renderCall(ev.entry); $('.pv-chat-status').textContent = `ran ${ev.entry.command || ev.entry.name}`; }
                if (ev.type === 'auto') { showDetected(ev); renderSteps(); renderTools(); }
                if (ev.type === 'quota') $('.pv-chat-quota').textContent = `${ev.remaining} model calls left today`;
                if (ev.type === 'step') { renderSteps(); say('note', `Interview step: ${ev.step}`); }
                if (ev.type === 'checks' && ev.report.findings.length) say('note', `Checks: ${ev.report.findings.map((f) => f.category).join(', ')}`);
            });
            if (out.stopped) say('note', out.stopped);
        } catch (err) {
            say('note', err.message);
        } finally {
            $('.pv-chat-status').textContent = '';
            send.disabled = false;
            renderPending();
            input.focus();
        }
    });
    input.focus();
    if (message) {
        input.value = message;
        if (status.signed_in) $('.pv-chat-form').requestSubmit();
    }
    return panel;
}
