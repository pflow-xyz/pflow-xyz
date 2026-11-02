// petri-chat-ui.js — the Ask pane: one docked panel beside the net (docs/design/agent-first-analysis.md sections 3, 4, 6, 9).
//
// It replaces the Assistant panel and its mode tabs. There is one input and no mode to pick: the server labels the
// message, the head shows the label as a chip ("Analysing") and "Not what I meant" opens a small menu to send the message
// again as Build, Analyse or Explain (ChatSession.resend). Explain never edits (ChatSession enforces it).
//
// Describe is the first turn of a build conversation on an empty canvas (design 4.6). The server labels a message in the
// call that answers it, so in auto mode there is no label before the first message: on an empty canvas the words decide
// (petri-ask-pane.js sendPlan: a description is drafted, a question goes to the model), and "Not what I meant" corrects
// either way (a described net is withdrawn and its words sent as Analyse or Explain; a question can be drafted by Build
// instead). A message after a described net refines the pending net; Regenerate is the only way to draft again.
//
// What the pane is made of:
//   the head          the title, the intent chip with its menu, New, close
//   the state line    why the model cannot be asked, when it cannot (askState: the five states below), with the one
//                     quiet "Sign in to ask in your own words", the reset time of the quota, or Try again
//   the log           the session list: what the person typed, the assistant's replies, the question card, the router's
//                     cards, and every RESULT as a card (petri-results-pane.js: the answer labelled assistant, the evidence
//                     labelled engine, the Assumed rows with Change, the provenance footer with its five actions, the
//                     follow-ups). The empty log offers suggested questions for this net and the goal cards
//   the pending card  edits waiting to be applied (a diff, the draft's notes, assumptions and rates, the problems list first
//                     when the check warns), with Apply / Discard (and Regenerate for a described net)
//   Tools             what the assistant can use and what it has run; the rest is under Tools (Cmd/Ctrl-K)
//   the input         one box. With the model it asks; without it the words go to the keyword router
//
// The five states of the input (askState, petri-ask.js), the same pane in each:
//   agent        signed in, allowed, quota left, upstream up: the words go to the model
//   signed-out   the words go to the router (the closest goals as cards, no model); one quiet line offers the sign-in and
//                keeps the words across the GitHub round trip (petri-landing.js keepPending)
//   not-allowed  as signed out, with no sign-in nag (the account is not on the list; signing in again changes nothing)
//   quota        as signed out, with the reset time; every card in the list can still be rerun, edited and changed: those
//                run no model
//   upstream     the model did not answer: one retry (retryingPoster), then the router, with the failed message kept in the
//                input and Try again
// ("off", a server with no chat, is the router with nothing else said.)
//
// A goal run from a card (no model) and one the model chose land as the same card: ChatSession.runCall('run_goal') is the
// one path, through the engine guard, so the footer's Rerun / Edit settings / Change work on both.
//
// The logic is petri-ask-pane.js (and petri-ask.js, petri-chat.js, tested with deno); this file is the DOM and stays thin.
// The conversation outlives the panel: closing it detaches the element (the cards keep their wiring) and the next open puts
// it back. <petri-view> loads this only when asked.
//
// Wording rule (as for drafting): replies are the assistant's; results are the engines'. The pane never restyles a reply as a result.

import { fitPanel } from './petri-panel-frame.js';
import { renderMarkdown } from './petri-markdown.js';
import { askState, intentChip, isTransient, normalizeIntent, otherIntents, suggestPrompts, suggestPromptsFor } from './petri-ask.js';
import {
    availableGoals, cardForm, draftError, emptyCanvas, gateOf, goalCard, notThatText, proposalFromDraft, retryingPoster, routeCards, sendPlan, setRate, toolsInfo,
} from './petri-ask-pane.js';
import { ResultsList } from './petri-results-pane.js';
import { readForm, renderFormHtml, showFormErrors } from './petri-schema-form.js';

// The Tools section's groups, by the command's prefix. One that is not named here is listed under its prefix.
const TOOL_GROUPS = { file: 'File', edit: 'Edit', net: 'Net', sim: 'Simulate', opt: 'Optimize', analysis: 'Analysis', view: 'Canvas', artifact: 'Results' };
// open_view: the classic dialog each view name stands for (the view's own methods; a vendored view without one says so)
const VIEW_OPENERS = {
    analysis: '_showSimulationDialog', simulate: '_openWorkbench', structure: '_openStructureDialog', results: '_showResultsDialog',
    app: '_openAppView', components: '_openComponents', check: '_showCheckDialog',
};

function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const loadedJson = new Map();
/** A static JSON file next to this module, fetched once. Null for a file the server does not have. */
function loadJson(name) {
    if (!loadedJson.has(name)) {
        loadedJson.set(name, fetch(new URL(`./${name}`, import.meta.url)).then((r) => {
            if (!r.ok) throw new Error(`${name}: ${r.status}`);
            return r.json();
        }));
    }
    return loadedJson.get(name);
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
            const err = new Error(`${out.error || `the assistant failed (${res.status})`}${wait}`);
            err.status = res.status;
            err.retryAfter = out.retry_after_s; // ChatSession waits out a short 429 and retries
            err.reset = out.reset; // when a daily limit lifts (the state line says so)
            throw err;
        }
        return out;
    };
}

/** The first sentence of a goal's answer shape, for its card in the grid. (No lookbehind: old Safari.) */
function firstSentence(text) {
    const m = /^[\s\S]*?\.(?=\s|$)/.exec(String(text || ''));
    return (m ? m[0] : String(text || '')).trim();
}

const INPUT_WORDS = {
    agent: 'Ask about the net, or say what to build…',
    router: 'Say what you want to know…',
    card: 'Or type your own answer…',
};

class AskPane {
    constructor(view) {
        this.view = view;
        this.status = { enabled: false };
        this.quotaLeft = undefined;
        this.lastError = null;
        this.retried = false;
        this.busy = false;
        this.lastText = '';
        this.userBubble = null;
        this.lastBubble = null;
        this.openCard = null;
        this.draft = null; // {description, draft, warnings} while a described net waits as the pending change
        this.shownIntent = null; // the chip after a described net, which no server label named
        this.pendingToken = 0;
        this.emptyToken = 0;
        this.turnStart = null; // a marker in the log where the last turn began
        this.toolsListed = null;
        this.panel = null;
    }

    // ---- set up ----

    async init({ mode } = {}) {
        const { view } = this;
        const [chatMod, fullManifest, goalManifest, catalog, live, status] = await Promise.all([
            import('./petri-chat.js'), loadJson('llm-tools.json'), loadJson('llm-goal-tools.json').catch(() => null), loadJson('goals.json'),
            view.commands(), view._llmStatus(true),
        ]);
        this.chatMod = chatMod;
        this.fullManifest = fullManifest;
        this.goalManifest = goalManifest;
        this.catalog = catalog;
        this.live = live;
        this.status = status || { enabled: false };
        if (!view._solverModule) view._solverModule = await import('./petri-solver.js');
        this.session(mode);
        this.build();
        this.results = await new ResultsList(this.env()).load();
        this.paintAll();
        this.fit();
        this.watch();
    }

    /** What the cards ask of the pane (petri-results-pane.js ResultsList). */
    env() {
        const self = this;
        return {
            view: this.view, catalog: this.catalog, live: this.live,
            get host() { return self.log; },
            get chat() { return self.chat; },
            get runner() { return self.runner; },
            announce: (t) => this.announce(t),
            toast: (m, k) => this.view._toast(m, k),
            scrolled: (el) => this.scrolled(el),
            followUp: (question) => this.followUp(question),
            notThat: (result) => this.notThat(result),
        };
    }

    /** The conversation: a goals session when the server has the goal tools, else the full tool set; and the session that runs goals with no model. */
    session(mode) {
        const { ChatSession } = this.chatMod;
        const st = askState(this.status);
        const useGoals = !!this.goalManifest && (st.toolset === 'goals' || !st.canAsk);
        const poster = retryingPoster(turnPoster(this.view), { onRetry: () => { this.retried = true; this.setStatusLine('The assistant did not answer. Trying once more.'); } });
        this.chat = new ChatSession({
            live: this.live, manifest: useGoals ? this.goalManifest : this.fullManifest, allManifest: this.fullManifest, goals: this.catalog,
            post: poster, mode: this.modeOf(mode), toolset: useGoals ? 'goals' : 'all', netCid: this.view._originalCid || null,
        });
        this.runner = this.chat.toolset === 'goals' ? this.chat
            : this.goalManifest ? new ChatSession({
                live: this.live, manifest: this.goalManifest, allManifest: this.fullManifest, goals: this.catalog, toolset: 'goals', mode: 'analyse',
                post: async () => { throw new Error('this session never asks the model'); }, netCid: this.view._originalCid || null,
            }) : null;
    }

    /** A session mode: auto, or one of the three intents ('design' is build). */
    modeOf(mode) {
        return !mode || mode === 'auto' ? 'auto' : normalizeIntent(mode) || 'auto';
    }

    build() {
        const panel = document.createElement('aside');
        panel.className = 'pv-chat pv-ask';
        panel.setAttribute('aria-label', 'Ask');
        panel.innerHTML = `
            <div class="pv-chat-head">
                <strong>Ask</strong>
                <span class="pv-ask-intent" hidden>
                    <span class="pv-ask-chip" aria-live="polite"></span>
                    <button type="button" class="pv-btn pv-btn-sm pv-ask-notmeant" aria-haspopup="menu" aria-expanded="false" hidden>Not what I meant</button>
                    <div class="pv-ask-menu" role="menu" aria-label="Send the message again as" hidden></div>
                </span>
                <button type="button" class="pv-btn" data-act="new" title="Start a new conversation">New</button>
                <button type="button" class="pv-dialog-close-icon" data-act="close" title="Close" aria-label="Close">×</button>
            </div>
            <div class="pv-chat-steps" hidden></div>
            <div class="pv-chat-quota pv-result-dim"></div>
            <p class="pv-ask-state" role="status" hidden></p>
            <div class="pv-chat-log" role="log" aria-live="off" aria-label="Conversation and results" tabindex="-1"></div>
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
            <div class="pv-ask-sr" aria-live="polite" aria-atomic="true"></div>
            <form class="pv-chat-form">
                <textarea class="pv-chat-input" rows="2" aria-label="Ask"></textarea>
                <button type="submit" class="pv-btn pv-btn-primary">Send</button>
            </form>`;
        this.panel = panel;
        panel._ask = this;
        panel._setMode = (m) => this.setMode(m);
        document.body.appendChild(panel);
        this.log = this.$('.pv-chat-log');
        this.input = this.$('.pv-chat-input');
        this.sendBtn = this.$('.pv-chat-form button');
        this.view._chatPanel = panel;
        this.view._chatKeep = { chat: this.chat };
        this.wire();
    }

    $(sel) {
        return this.panel.querySelector(sel);
    }

    fit() {
        fitPanel(this.view, this.panel, {
            around: (apply) => {
                const pinned = this.log.scrollTop + this.log.clientHeight >= this.log.scrollHeight - 8;
                apply();
                if (pinned) this.log.scrollTop = this.log.scrollHeight; // the newest message stays in sight as the panel shrinks
            },
        });
    }

    wire() {
        const { panel } = this;
        this.$('[data-act="close"]').addEventListener('click', () => this.close());
        this.$('[data-act="new"]').addEventListener('click', () => this.newConversation());
        this.input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.$('.pv-chat-form').requestSubmit(); }
        });
        this.$('.pv-chat-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.submit(this.input.value);
        });
        const notMeant = this.$('.pv-ask-notmeant');
        notMeant.addEventListener('click', () => this.toggleMenu());
        this.$('.pv-ask-menu').addEventListener('click', (e) => {
            const b = e.target.closest('[data-intent]');
            if (b) { this.toggleMenu(false); this.resendAs(b.dataset.intent); }
        });
        panel.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !this.$('.pv-ask-menu').hidden) { e.stopPropagation(); this.toggleMenu(false); notMeant.focus(); }
        });
        this.$('.pv-ask-state').addEventListener('click', (e) => {
            const b = e.target.closest('[data-ask]');
            if (b?.dataset.ask === 'signin') this.signIn();
            if (b?.dataset.ask === 'retry') this.retryLast();
        });
        this.log.addEventListener('click', (e) => this.onLogClick(e));
        this.$('.pv-chat-tools').addEventListener('click', (e) => {
            if (e.target.closest('[data-ask="palette"]')) import('./petri-palette-ui.js').then((m) => m.openPalette(this.view)).catch((err) => this.view._toast(`Tools are not available here: ${err.message}`, 'error'));
        });
    }

    /** The net changes under the pane: results made on the old one are stale, and the suggested questions are for this net. */
    watch() {
        let timer = null;
        const changed = () => {
            clearTimeout(timer);
            timer = setTimeout(() => { this.results?.refreshStale(); this.refreshEmpty().catch(() => {}); }, 250);
        };
        for (const ev of ['jsonld-updated', 'marking-changed']) this.view.addEventListener(ev, changed);
        this.changed = changed;
    }

    // ---- reopening ----

    reopen() {
        if (!this.panel.isConnected) {
            document.body.appendChild(this.panel);
            this.view._chatPanel = this.panel;
            this.fit();
        }
        return this;
    }

    async refreshStatus() {
        try { this.status = await this.view._llmStatus(true); } catch { /* the last status stands */ }
        this.paintAll();
    }

    close() {
        this.toggleMenu(false);
        this.panel.remove();
    }

    focus() {
        this.input.focus();
    }

    setMode(mode) {
        const m = this.modeOf(mode);
        this.chat.setMode(m);
        this.shownIntent = null;
        this.updateIntent();
        this.renderSteps();
        this.renderTools();
    }

    newConversation() {
        if (this.busy) return; // a turn still running would land its answer in the new conversation
        const mode = 'auto';
        this.session(mode);
        this.draft = null;
        this.shownIntent = null;
        this.lastError = null;
        this.retried = false;
        this.quotaLeft = undefined;
        this.openCard = null;
        this.results.reset();
        this.log.innerHTML = '';
        this.$('.pv-chat-calls').innerHTML = '';
        this.toolsListed = null;
        this.paintAll();
        this.view._chatKeep = { chat: this.chat };
    }

    /** A turn (or a draft) is under way: the box and New wait for it; nothing else about the pane changes. */
    setBusy(on) {
        this.busy = on;
        this.sendBtn.disabled = on;
        const fresh = this.$('[data-act="new"]');
        fresh.disabled = on;
        fresh.title = on ? 'Available when the answer has finished' : 'Start a new conversation';
        if (on) this.panel.setAttribute('aria-busy', 'true');
        else this.panel.removeAttribute('aria-busy');
    }

    // ---- the state ----

    get ask() {
        return askState(this.status, { error: this.lastError, quotaLeft: this.quotaLeft, retried: this.retried });
    }

    /** Everything that depends on the state: the line, the box, the empty log, the chip, the pending card, Tools. */
    paintAll() {
        this.paintState();
        this.refreshEmpty().catch(() => {});
        this.updateIntent();
        this.renderSteps();
        this.renderTools();
        this.renderPending();
    }

    paintState() {
        const a = this.ask;
        const line = this.$('.pv-ask-state');
        this.panel.dataset.state = a.state;
        const action = a.signIn ? '<button type="button" class="pv-prov-link" data-ask="signin">Sign in</button>'
            : a.state === 'upstream' && !a.retry && this.lastText ? '<button type="button" class="pv-prov-link" data-ask="retry">Try again</button>' : '';
        line.hidden = !a.words;
        line.innerHTML = a.words ? `${esc(a.words)} ${action}` : '';
        line.dataset.state = a.state;
        this.input.placeholder = this.openCard ? INPUT_WORDS.card : a.canAsk ? INPUT_WORDS.agent : INPUT_WORDS.router;
        this.sendBtn.textContent = a.canAsk ? 'Send' : 'Find questions';
        const left = this.quotaLeft ?? this.status.remaining_today;
        this.$('.pv-chat-quota').textContent = a.canAsk && left !== undefined ? `${left} model calls left today` : '';
        this.$('.pv-chat-quota').hidden = !this.$('.pv-chat-quota').textContent;
    }

    setStatusLine(text) {
        this.$('.pv-chat-status').textContent = text;
    }

    async signIn() {
        const words = this.input.value.trim() || this.lastText;
        if (words) {
            try { (await import('./petri-landing.js')).keepPending(sessionStorage, { route: 'auto', message: words }); } catch { /* the words are lost, the sign-in still works */ }
        }
        this.view._loginWithGitHub();
    }

    retryLast() {
        const text = this.input.value.trim() || this.lastText;
        this.lastError = null;
        this.retried = false;
        this.paintState();
        if (text) this.submit(text);
    }

    // ---- the log ----

    say(who, text) {
        const p = document.createElement('div');
        p.className = `pv-chat-msg pv-chat-${who}`;
        if (who === 'assistant') p.innerHTML = renderMarkdown(text);
        else p.textContent = text;
        this.log.appendChild(p);
        this.log.scrollTop = this.log.scrollHeight;
        if (who !== 'user') this.announce(text);
        return p;
    }

    announce(text) {
        const sr = this.$('.pv-ask-sr');
        sr.textContent = '';
        // (a change of text is what a live region reads: clear it first so the same sentence is read again)
        setTimeout(() => { sr.textContent = String(text).slice(0, 300); }, 20);
    }

    /** Keep the newest thing in sight: a card, a form opened on one or the router's cards from their top, anything else at the end. The page does not scroll with it. */
    scrolled(el) {
        if (el && (el.classList?.contains('pv-ask-card') || el.classList?.contains('pv-ask-edit') || el.classList?.contains('pv-ask-route'))) this.log.scrollTop = Math.max(0, el.offsetTop - this.log.offsetTop - 4);
        else this.log.scrollTop = this.log.scrollHeight;
    }

    onLogClick(e) {
        const b = e.target.closest('[data-pane]');
        if (!b || !this.log.contains(b)) return;
        const act = b.dataset.pane;
        if (act === 'suggest') this.submit(b.dataset.text, { as: b.dataset.as || undefined });
        if (act === 'goal') this.openGoalCard(b.dataset.goal);
    }

    // ---- the empty log: suggested questions and the goal cards ----

    /** The conversation has begun: the empty state goes, and one still being made (it awaits the suggestions) is not wanted any more. */
    hideEmpty() {
        this.emptyToken++;
        this.log.querySelector('.pv-ask-empty')?.remove();
    }

    /** The empty state, while the log holds nothing else: suggestions for this net (changing with it) and the goal cards. */
    async refreshEmpty() {
        const fresh = () => [...this.log.children].every((c) => c.classList.contains('pv-ask-empty'));
        if (!fresh()) return;
        const token = ++this.emptyToken;
        const model = this.view.getModel();
        const a = this.ask;
        const box = document.createElement('div');
        box.className = 'pv-ask-empty';
        if (emptyCanvas(model)) {
            let examples = [];
            if (a.canAsk) { try { examples = (await import('./petri-draft-ui.js')).DRAFT_EXAMPLES || []; } catch { /* no examples */ } }
            box.innerHTML = `<p class="pv-ask-hint">The canvas is empty. ${a.canAsk ? 'Describe a process in words and I will draft a net to read and edit, or add a place yourself.' : 'Add a place and a transition, or open an example. Describing a process in words needs the assistant.'}</p>
                ${examples.length ? `<div class="pv-ask-suggest" role="group" aria-label="Try describing">${examples.map(([t, text]) => `<button type="button" class="pv-btn" data-pane="suggest" data-as="build" data-text="${esc(text)}">${esc(t)}</button>`).join('')}</div>` : ''}`;
        } else {
            let prompts;
            try { prompts = await suggestPromptsFor(this.live, this.catalog); } catch { prompts = suggestPrompts(model, this.catalog); }
            if (token !== this.emptyToken) return; // a newer repaint
            const goals = availableGoals(this.catalog, model);
            box.innerHTML = `<p class="pv-ask-hint">${a.canAsk ? 'Ask about this net in your own words, or start from a question.' : 'Pick a question; it runs on this net without the assistant.'}</p>
                <div class="pv-ask-suggest" role="group" aria-label="Suggested questions">${prompts.map((p) => `<button type="button" class="pv-btn" data-pane="suggest" data-text="${esc(p.text)}" title="${esc(p.why)}">${esc(p.text)}</button>`).join('')}</div>
                <div class="pv-ask-label">All the questions</div>
                <div class="pv-ask-grid" role="list">${goals.map((g) => `<button type="button" class="pv-ask-goalcard" role="listitem" data-pane="goal" data-goal="${esc(g.id)}"><b>${esc(g.question)}</b><span class="pv-result-dim">${esc(firstSentence(g.answer))}</span></button>`).join('')}</div>`;
        }
        // (the suggestions take a moment: a message sent meanwhile, or a card that landed, means the log is not empty any more)
        if (token !== this.emptyToken || !fresh()) return;
        const old = this.log.querySelector('.pv-ask-empty');
        if (old) old.replaceWith(box);
        else this.log.appendChild(box);
    }

    // ---- the intent chip ----

    updateIntent() {
        // (a described net's label is the person's own, and newer than whatever the server last said)
        const mode = this.shownIntent || this.chat.intent;
        const chip = intentChip(mode);
        const wrap = this.$('.pv-ask-intent');
        const started = this.chat.messages.length > 0 || !!this.draft; // (a described net is a message sent, with no model turn)
        const show = !!chip && (this.chat.mode !== 'auto' || started || !!this.shownIntent);
        wrap.hidden = !show;
        if (chip) {
            this.$('.pv-ask-chip').textContent = chip.chip;
            this.panel.dataset.intent = chip.id;
        } else {
            delete this.panel.dataset.intent;
        }
        const can = show && started && this.ask.canAsk && !this.busy;
        const b = this.$('.pv-ask-notmeant');
        b.hidden = !can;
        if (!can) this.toggleMenu(false);
        this.$('.pv-ask-menu').innerHTML = chip ? otherIntents(chip.id).map((i) => `<button type="button" role="menuitem" class="pv-btn pv-btn-sm" data-intent="${i.id}">${esc(i.instead)}</button>`).join('') : '';
    }

    toggleMenu(open) {
        const menu = this.$('.pv-ask-menu');
        const b = this.$('.pv-ask-notmeant');
        const next = open ?? menu.hidden;
        menu.hidden = !next;
        b.setAttribute('aria-expanded', next ? 'true' : 'false');
        if (next) menu.querySelector('button')?.focus();
    }

    /** "Not what I meant": the last message again as another intent. On an empty canvas, a first message as Build is a Describe. */
    async resendAs(intent) {
        if (this.busy) return;
        const to = normalizeIntent(intent);
        if (!to) return;
        if (this.draft && !this.chat.messages.length) return this.resendDescribed(to);
        const started = this.chat.messages.filter((m) => m.role === 'user' && !m.parts?.some((p) => p.functionResponse)).length;
        // (not with a described net pending: a message after it refines that net, and drafting it again would replace the net)
        if (to === 'build' && started === 1 && !this.draft && emptyCanvas(this.view.getModel()) && this.ask.canAsk) {
            const text = this.chat.rewind();
            this.dropTurnFromLog();
            this.markTurn();
            this.userBubble = this.say('user', text);
            this.lastText = text;
            return this.describe(text);
        }
        this.dropTurnFromLog();
        await this.runTurn(async () => {
            const text = this.lastText;
            this.markTurn();
            this.userBubble = this.say('user', text);
            const out = await this.chat.resend(to, (ev) => this.onEvent(ev));
            if (this.chat.mode !== 'auto') this.chat.setMode(to); // a session that was stated stays as it was corrected
            return out;
        });
    }

    /** "Not what I meant" on a described message (it has no model turn to rewind): the draft is withdrawn and the same words go to the model as the other intent. */
    async resendDescribed(to) {
        const text = this.draft.description;
        this.chat.discard();
        this.draft = null;
        this.shownIntent = null;
        this.dropTurnFromLog();
        this.renderPending();
        this.markTurn();
        this.userBubble = this.say('user', text);
        this.lastText = text;
        this.chat.force(to);
        await this.runTurn(async () => {
            const out = await this.chat.send(text, (ev) => this.onEvent(ev));
            if (this.chat.mode !== 'auto') this.chat.setMode(to);
            return out;
        }, text);
    }

    /** A marker in the log where a turn begins, so that "Not what I meant" can take the whole turn out of it. */
    markTurn() {
        const m = document.createElement('div');
        m.className = 'pv-ask-turn';
        m.setAttribute('aria-hidden', 'true');
        this.log.appendChild(m);
        this.turnStart = m;
    }

    /** What the withdrawn turn left in the log: the message, the assistant's replies and the cards go (the message is sent again). */
    dropTurnFromLog() {
        const from = this.turnStart;
        if (!from?.isConnected) return;
        let n = from.nextSibling;
        while (n) {
            const next = n.nextSibling;
            if (n.classList?.contains('pv-ask-card')) this.results.items.delete(n.dataset.result);
            n.remove();
            n = next;
        }
        from.remove();
        this.turnStart = null;
        this.userBubble = null;
    }

    // ---- sending ----

    /**
     * What the person typed (or a suggestion, or a follow-up) goes where sendPlan says: the model, the Describe draft, or the
     * router. `as` states the intent for this message (an example on an empty canvas is a Describe).
     */
    async submit(raw, { as } = {}) {
        const text = String(raw ?? '').trim();
        if (!text || this.busy) return;
        const plan = sendPlan({
            ask: this.ask, intent: as ? normalizeIntent(as) : this.chat.intent, canvasEmpty: emptyCanvas(this.view.getModel()),
            started: this.chat.messages.length > 0, pending: !!(this.draft || this.chat.pending), text,
        });
        if (plan.do === 'nothing') return;
        this.input.value = '';
        this.hideEmpty();
        this.lastText = text;
        this.lastError = this.ask.state === 'upstream' ? null : this.lastError; // a new message is a new try
        this.retried = false;
        // a question card that is open is answered by these words (ChatSession.send does that): say so on the card
        if (this.openCard) this.answerCardWith(`Other: ${text}`);
        else this.markTurn();
        this.userBubble = this.say('user', text);
        if (plan.do === 'route') return this.route(text);
        if (plan.do === 'draft') return this.describe(text);
        if (as && normalizeIntent(as)) this.chat.force(as);
        return this.runTurn(() => this.chat.send(text, (ev) => this.onEvent(ev)), text);
    }

    /** One turn of the model, however it was started (send, answer, resend): the busy state around it, and what a failure does. */
    async runTurn(fn, text = this.lastText, { fresh = true, rewind = true } = {}) {
        this.setBusy(true);
        if (fresh) this.results.beginTurn();
        this.retried = false;
        // On a phone an open Tools section stands in for the log (petri-view.css): the answer has to be in sight.
        if (!this.log.clientHeight) this.$('.pv-chat-tools').open = false;
        try {
            const out = await fn();
            this.lastError = null;
            if (out?.stopped) this.say('note', out.stopped);
        } catch (err) {
            this.failed(err, text, { rewind });
        } finally {
            this.setBusy(false);
            this.setStatusLine('');
            this.paintState();
            this.updateIntent();
            this.renderTools();
            this.results.refreshStale();
            await this.renderPending();
            if (!this.openCard) this.input.focus();
        }
    }

    /** The model did not answer (or refused): take the message back, keep its words in the input, and say what the pane does now. */
    failed(err, text, { rewind = true } = {}) {
        this.lastError = err;
        if (rewind) { try { this.chat.rewind(); } catch { /* nothing was sent */ } }
        this.userBubble?.remove();
        this.userBubble = null;
        this.input.value = text;
        this.openCard = null;
        const a = this.ask;
        this.paintState();
        this.announce(a.words || String(err.message || err));
        if (a.router) this.route(text, { announce: false });
    }

    /** No model: the closest questions as cards, each with what it assumes and a small form for what it still needs. */
    route(text, { announce = true } = {}) {
        const model = this.view.getModel();
        const block = document.createElement('div');
        block.className = 'pv-ask-route';
        block.setAttribute('role', 'group');
        block.setAttribute('aria-label', 'Closest questions');
        if (emptyCanvas(model)) {
            block.innerHTML = '<p class="pv-ask-hint">The net is empty, so there is nothing to ask about yet. Add a place and a transition, or open an example. Describing a process in words needs the assistant.</p>';
            this.log.appendChild(block);
            this.scrolled();
            return;
        }
        const cards = routeCards(this.catalog, model, text);
        block.innerHTML = cards.length
            ? '<p class="pv-ask-hint">The closest questions I can run without the assistant:</p>'
            : '<p class="pv-ask-hint">No question matches those words. Pick one of these; each runs on this net without the assistant:</p>';
        const list = cards.length ? cards : availableGoals(this.catalog, model).map((g) => goalCard(g, model, text));
        for (const card of list) block.appendChild(this.routeCard(card, text));
        this.log.appendChild(block);
        this.scrolled(block);
        if (announce) this.announce(`${list.length} question${list.length === 1 ? '' : 's'} to run without the assistant.`);
    }

    openGoalCard(id) {
        const goal = this.catalog.goals.find((g) => g.id === id);
        if (!goal) return;
        this.hideEmpty();
        const block = document.createElement('div');
        block.className = 'pv-ask-route';
        block.setAttribute('role', 'group');
        block.setAttribute('aria-label', 'Question');
        block.appendChild(this.routeCard(goalCard(goal, this.view.getModel(), ''), ''));
        this.log.appendChild(block);
        this.scrolled(block);
        block.querySelector('select, input, button')?.focus();
    }

    /** One goal as a card: what it needs, what was assumed from the words (with a select to change it), the form, Run. */
    routeCard(card, text) {
        const { goal } = card;
        const model = this.view.getModel();
        const places = Object.keys(model.places || {});
        const transitions = Object.keys(model.transitions || {});
        const el = document.createElement('form');
        el.className = 'pv-ask-rcard';
        el.dataset.goal = goal.id;
        el.noValidate = true;
        const needs = card.missing.length ? `Needs: ${card.missing.map((i) => i.label || i.name).join('; ')}.` : 'Needs nothing: it uses the defaults the engine recommends.';
        const form = card.form.noForm ? card.form : cardForm(card);
        el.innerHTML = `<b class="pv-ask-q-text">${esc(goal.question)}</b>
            <p class="pv-result-dim">${esc(needs)}</p>
            ${card.assumed.length ? `<ul class="pv-ask-assumed-list">${card.assumed.map((a) => `<li>${esc(a.text)}</li>`).join('')}</ul>` : ''}
            ${form.noForm ? `<p class="pv-result-dim">${esc(form.noForm)}</p>` : form.fields.length ? renderFormHtml(form, { esc, places, transitions, idPrefix: `pv-rc-${goal.id}-${Math.random().toString(36).slice(2, 6)}` }) : ''}
            <div class="pv-form-summary" role="alert" hidden></div>
            <div class="pv-ask-acts">${goal.available === false || form.noForm ? '' : '<button type="submit" class="pv-btn pv-btn-primary pv-btn-sm">Run</button>'}</div>`;
        el.addEventListener('submit', async (e) => {
            e.preventDefault();
            const summary = el.querySelector('.pv-form-summary');
            const { args, errors } = form.fields.length ? readForm(el, form) : { args: {}, errors: [] };
            showFormErrors(el, errors);
            if (errors.length) { summary.hidden = false; summary.textContent = errors.map((x) => x.message).join(' · '); return; }
            summary.hidden = true;
            await this.runLocal(goal, { ...card.inputs, ...args }, text, el);
        });
        return el;
    }

    /** Run a goal with no model (ChatSession.runCall('run_goal'): through the engine guard) and land the result as a card. */
    async runLocal(goal, inputs, userText, formEl) {
        const summary = formEl?.querySelector('.pv-form-summary');
        if (!this.runner) {
            if (summary) { summary.hidden = false; summary.textContent = 'The goal tools are not available on this server.'; }
            return;
        }
        const btn = formEl?.querySelector('button[type="submit"]');
        btn?.setAttribute('aria-disabled', 'true');
        this.setStatusLine(`Running “${goal.question}”…`);
        const epoch = this.results.epoch;
        try {
            const entry = await this.runner.runCall({ name: 'run_goal', args: { goal_id: goal.id, inputs: JSON.stringify(inputs) } }, 0, { userText });
            if (epoch !== this.results.epoch) return; // New was pressed while it ran: this card belongs to the old conversation
            this.renderCall(entry);
            if (!entry.ok) {
                if (summary) { summary.hidden = false; summary.textContent = entry.error; }
                return;
            }
            this.results.beginTurn();
            this.results.add(entry.result, { pickedBy: 'you' });
            this.renderTools();
        } finally {
            btn?.removeAttribute('aria-disabled');
            this.setStatusLine('');
        }
    }

    // ---- events from the model's loop ----

    onEvent(ev) {
        switch (ev.type) {
        case 'round': this.setStatusLine(ev.round === 1 ? 'Thinking…' : `Thinking… (step ${ev.round})`); break;
        case 'reply': this.lastBubble = this.say('assistant', ev.text); break;
        case 'call': this.renderCall(ev.entry); this.setStatusLine(`ran ${ev.entry.command || ev.entry.name}`); break;
        case 'goal': this.results.add(ev.entry.result, { pickedBy: 'assistant', latest: true }); break;
        case 'command': this.results.add(ev.entry.shown, { pickedBy: 'assistant', latest: true }); break;
        case 'answer':
            // the reply that followed a goal result is that result's answer: it lives on the card, not twice in the log
            this.lastBubble?.remove();
            this.lastBubble = null;
            this.results.setAnswer(ev.result);
            break;
        case 'ask': this.showQuestion(ev.card); break;
        case 'open_view': this.openView(ev.view); break;
        case 'intent': this.shownIntent = null; this.updateIntent(); break;
        case 'wait': this.setStatusLine(`Rate limited; retrying in ${ev.seconds} s…`); break;
        case 'quota':
            this.quotaLeft = ev.remaining;
            if (ev.reset) this.status = { ...this.status, reset: ev.reset };
            this.paintState();
            break;
        case 'step': this.renderSteps(); this.say('note', `Interview step: ${ev.step}`); break;
        case 'checks': if (ev.report.findings.length) this.say('note', `Checks: ${ev.report.findings.map((f) => f.category).join(', ')}`); break;
        case 'toolset': this.toolsListed = null; this.renderTools(); break;
        default: break;
        }
    }

    openView(name) {
        const method = VIEW_OPENERS[name];
        if (typeof this.view[method] === 'function') this.view[method]();
        else this.view._toast(`The ${name} view is under Tools (${this.shortcut()})`);
    }

    shortcut() {
        return /mac|iphone|ipad|ipod/i.test(navigator.userAgentData?.platform || navigator.platform || '') ? '⌘K' : 'Ctrl K';
    }

    // ---- a question the model asks ----

    showQuestion(card) {
        const id = `pv-q-${Math.random().toString(36).slice(2, 7)}`;
        const el = document.createElement('div');
        el.className = 'pv-ask-q';
        el.setAttribute('role', 'group');
        el.setAttribute('aria-labelledby', `${id}-t`);
        el.innerHTML = `<p id="${id}-t" class="pv-ask-q-text"><strong>${esc(card.question)}</strong></p>
            <div class="pv-ask-opts">${card.options.map((o, i) => `<button type="button" class="pv-btn" data-q="opt" data-i="${i}"${o === card.default_option ? ' data-default="true"' : ''}>${esc(o)}</button>`).join('')}
                <button type="button" class="pv-btn" data-q="other" aria-expanded="false">Other…</button>
                <button type="button" class="pv-btn" data-q="decide" title="Record my pick as an assumption you can see and change">You decide</button></div>
            <form class="pv-ask-other" hidden><label for="${id}-o" class="pv-ask-sr">Your answer</label><input id="${id}-o" type="text" autocomplete="off" maxlength="300"> <button type="submit" class="pv-btn pv-btn-primary pv-btn-sm">OK</button></form>
            <p class="pv-result-dim pv-ask-q-why">I asked because a wrong guess would give a misleading answer. “You decide” records my pick as an assumption you can see.</p>`;
        this.log.appendChild(el);
        this.openCard = { el, card };
        this.paintState();
        el.addEventListener('click', (e) => {
            const b = e.target.closest('[data-q]');
            if (!b || this.openCard?.el !== el || this.busy) return;
            if (b.dataset.q === 'opt') this.answerCard(card.options[+b.dataset.i], card.options[+b.dataset.i]);
            if (b.dataset.q === 'decide') this.answerCard({ decide: true }, 'You decide');
            if (b.dataset.q === 'other') {
                const f = el.querySelector('.pv-ask-other');
                f.hidden = !f.hidden;
                b.setAttribute('aria-expanded', f.hidden ? 'false' : 'true');
                if (!f.hidden) f.querySelector('input').focus();
            }
        });
        el.querySelector('.pv-ask-other').addEventListener('submit', (e) => {
            e.preventDefault();
            const v = el.querySelector('.pv-ask-other input').value.trim();
            if (v) this.answerCard({ other: v }, `Other: ${v}`);
        });
        this.scrolled();
        this.announce(`Question: ${card.question}`);
        el.querySelector('[data-q="opt"]')?.focus();
    }

    /** The card is answered (by a button, or by words typed in the box): it collapses to the pick, and the loop goes on. */
    answerCardWith(label) {
        const open = this.openCard;
        if (!open) return;
        this.openCard = null;
        open.el.classList.add('pv-ask-q-done');
        open.el.innerHTML = `<p class="pv-ask-q-text"><strong>${esc(open.card.question)}</strong></p><p class="pv-result-dim">Answered: ${esc(label)}</p>`;
    }

    answerCard(choice, label) {
        this.answerCardWith(label);
        this.paintState();
        return this.runTurn(() => this.chat.answer(choice, (ev) => this.onEvent(ev)), this.lastText, { fresh: false });
    }

    // ---- Describe, folded in ----

    /** The first message on an empty canvas as a build: /api/llm/draft, the gate, and the net as the pending change. */
    async describe(description) {
        this.setBusy(true);
        this.setStatusLine('Asking Gemini for a draft…');
        try {
            const D = await import('./petri-draft-ui.js');
            let got = await D.requestDraft(this.view, description);
            if (!got.ok && !got.aborted && got.status !== 429 && isTransient(draftError(got))) {
                this.retried = true;
                this.setStatusLine('The assistant did not answer. Trying once more.');
                await new Promise((r) => setTimeout(r, 1200));
                got = await D.requestDraft(this.view, description);
            }
            if (!got.ok) { this.failed(draftError(got), description, { rewind: false }); return; }
            if (got.remaining_today !== undefined) { this.quotaLeft = got.remaining_today; this.paintState(); }
            this.setStatusLine('Checking the draft…');
            const { gate, issuesHtml } = await D.gateDraftResult(got.draft);
            if (!gate.ok) {
                this.noteHtml(`<strong>Check: the draft was not loaded (${gate.errors.length} problem${gate.errors.length === 1 ? '' : 's'})</strong>
                    ${issuesHtml}
                    <details><summary>Show raw reply</summary><pre class="pv-result-json">${esc(JSON.stringify(got.draft, null, 2))}</pre></details>
                    <button type="button" class="pv-btn pv-btn-sm" data-pane="redraft" data-text="${esc(description)}">Try again</button>`);
                return;
            }
            this.chat.proposeNet(gate.net, proposalFromDraft(got.draft));
            this.draft = { description, draft: got.draft, warnings: gate.warnings };
            this.shownIntent = 'build';
            this.say('note', `Drafted a net from your description. It is a pending change: read it, edit the rates, then Apply.`);
        } finally {
            this.setBusy(false);
            this.setStatusLine('');
            this.updateIntent();
            await this.renderPending();
            this.input.focus();
        }
    }

    noteHtml(html) {
        const p = document.createElement('div');
        p.className = 'pv-chat-msg pv-chat-note pv-ask-checknote';
        p.innerHTML = html;
        this.log.appendChild(p);
        this.log.scrollTop = this.log.scrollHeight;
        p.querySelector('[data-pane="redraft"]')?.addEventListener('click', (e) => { p.remove(); this.describe(e.currentTarget.dataset.text); });
        return p;
    }

    // ---- results ----

    /** A result from elsewhere (the Tools palette, an opened link): a card in this list. */
    async showResult(result) {
        await this.results.load();
        this.hideEmpty();
        this.results.beginTurn();
        return this.results.add(result, { pickedBy: 'you' });
    }

    /** A follow-up question goes in the box and is sent: no extra model call to make it up. */
    followUp(question) {
        if (!question) return;
        this.input.value = question;
        this.submit(question);
    }

    /** "Not that": the last message again, with the answer to leave and the instruction to pick another goal. */
    async notThat(result) {
        if (this.busy || !this.ask.canAsk) return;
        const q = result.goal?.question || result.title;
        let text;
        try { text = this.chat.rewind(); } catch { return; }
        this.results.setAside(result);
        this.markTurn();
        this.say('note', `Not “${q}”: looking for a different answer…`);
        this.lastText = text;
        this.userBubble = null;
        await this.runTurn(() => this.chat.send(notThatText(text, q), (ev) => this.onEvent(ev)), text);
    }

    // ---- pending edits ----

    async renderPending() {
        const token = ++this.pendingToken;
        const { chat } = this;
        const box = this.$('.pv-chat-pending');
        if (!chat.pending) { box.hidden = true; box.innerHTML = ''; return; }
        let gate = '';
        let worse = false;
        try {
            const w = await chat.weights();
            const parts = (r) => [...r.dead_transitions.map((t) => `dead ${t}`), ...r.unmarked_siphons.map((s) => `empty siphon {${s.join(', ')}}`),
                ...r.unreachable_goals.map((g) => `unreachable goal: ${g}`), ...r.lost_laws.map((l) => `lost law ${l}`)];
            worse = w.worse;
            gate = `<p class="${w.worse ? 'pv-chat-err' : 'pv-result-dim'}">Defect weight ${w.before.weight} → ${w.after.weight}${w.worse ? ': these edits make the net worse' : ''}.
                ${parts(w.after).length ? `<br>${esc(parts(w.after).join('; '))}` : ''}</p>`;
        } catch { /* the gate is advice */ }
        if (token !== this.pendingToken || !chat.pending) return;
        const d = chat.diff();
        const lines = [...d.added.map((x) => `+ ${x}`), ...d.removed.map((x) => `− ${x}`), ...d.changed.map((x) => `~ ${x}`),
            ...d.arcsAdded.map((x) => `+ arc ${x}`), ...d.arcsRemoved.map((x) => `− arc ${x}`)];
        box.hidden = false;
        box.dataset.worse = worse ? '1' : '';
        // The buttons come first: a described net's notes and a long diff are taller than the card, and Apply must not be below the fold.
        const shown = lines.length;
        box.innerHTML = `<div class="pv-ask-pending-head"><strong>Pending edits</strong> <span class="pv-result-dim">(not on the net yet)</span></div>
            <div class="pv-ask-acts">
                <button type="button" class="pv-btn pv-btn-primary" data-act="apply">${worse ? 'Apply anyway' : 'Apply'} (one undo step)</button>
                <button type="button" class="pv-btn" data-act="discard">Discard</button>
                ${this.draft ? '<button type="button" class="pv-btn" data-act="regenerate" title="A new draft from the same description (spends one)">Regenerate</button>' : ''}
            </div>
            <div class="pv-ask-problems" role="region" aria-label="Problems found" hidden></div>
            ${gate}
            <details class="pv-ask-diffbox"${shown <= 8 && !this.chat.proposal ? ' open' : ''}><summary>${d.empty ? 'No structural change' : `${shown} change${shown === 1 ? '' : 's'}`}</summary>
                <ul class="pv-ask-diff">${lines.slice(0, 30).map((l) => `<li><code>${esc(l)}</code></li>`).join('')}${lines.length > 30 ? `<li>… ${lines.length - 30} more</li>` : ''}${d.empty ? '<li>no structural change (marking or undo only)</li>' : ''}</ul></details>
            ${this.proposalHtml()}`;
        this.wirePending(box);
    }

    /** The draft's notes and assumptions, "Gemini's draft notes" as before (never an engine result), the rates editable in place. */
    proposalHtml() {
        const p = this.chat.proposal;
        if (!p || (!p.notes?.length && !p.assumptions?.length)) return '';
        const summary = p.notes.find((n) => n.kind === 'summary');
        const legend = p.notes.filter((n) => n.kind !== 'summary');
        // The rates are the pending net's own: a refinement the assistant made after the draft (a rate changed, a transition gone) shows here.
        const live = this.chat.model().transitions || {};
        const assumptions = p.assumptions.filter((a) => a.kind !== 'rate' || live[a.transition])
            .map((a) => (a.kind === 'rate' && Number.isFinite(live[a.transition].rate) ? { ...a, value: live[a.transition].rate } : a));
        return `<div class="pv-ask-proposal">
            <div class="pv-ask-label">Assumptions <span class="pv-result-dim">(Gemini's draft notes)</span></div>
            ${summary ? `<p>${esc(summary.text)}</p>` : ''}
            <ul class="pv-ask-assume">${assumptions.map((a) => (a.kind === 'rate'
                ? `<li class="pv-ask-rate"><label>Rate of <b>${esc(a.label)}</b> <input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" data-rate="${esc(a.transition)}" value="${esc(a.value)}" aria-label="Rate of ${esc(a.label)}"></label><span class="pv-form-err" role="alert" hidden></span></li>`
                : `<li>${esc(a.text)}</li>`)).join('') || '<li>None stated.</li>'}</ul>
            ${legend.length ? `<details><summary>What each part stands for (${legend.length})</summary><ul>${legend.map((n) => `<li><strong>${esc(n.label || n.id)}</strong> <span class="pv-result-dim">${esc(n.kind)}</span> ${esc(n.text)}</li>`).join('')}</ul></details>` : ''}
        </div>`;
    }

    wirePending(box) {
        const { chat } = this;
        box.querySelectorAll('[data-rate]').forEach((input) => input.addEventListener('change', async () => {
            const err = input.parentElement.nextElementSibling;
            const r = setRate(chat.proposal, input.dataset.rate, input.value);
            if (r.error) { err.hidden = false; err.textContent = r.error; input.setAttribute('aria-invalid', 'true'); return; }
            err.hidden = true;
            input.removeAttribute('aria-invalid');
            try {
                await chat.sandbox.execute('sim.set_rate', { id: input.dataset.rate, rate: r.value });
                chat.proposal = r.proposal;
                if (this.draft) this.draft.draft = { ...this.draft.draft, transitions: this.draft.draft.transitions.map((t) => (t.id === input.dataset.rate ? { ...t, rate: r.value } : t)) };
                this.results.refreshStale();
                await this.renderPending();
            } catch (e) {
                err.hidden = false;
                err.textContent = e.message || String(e);
            }
        }));
        const apply = box.querySelector('[data-act="apply"]');
        let seen = false;
        apply.addEventListener('click', async () => {
            // The problems check goes first: when it warns, the list is shown and a second click applies. The person decides.
            if (!seen) {
                const g = await gateOf(this.view, chat);
                if (g.warn) {
                    seen = true;
                    const P = await import('./petri-problems.js');
                    const out = box.querySelector('.pv-ask-problems');
                    out.hidden = false;
                    out.innerHTML = `<p class="pv-chat-err">${esc(g.message)}</p>${g.summary ? P.problemsListHtml(g.summary, { esc }) : ''}`;
                    apply.textContent = 'Apply anyway (one undo step)';
                    apply.focus();
                    this.announce(g.message);
                    return;
                }
            }
            await this.apply();
        });
        box.querySelector('[data-act="discard"]').addEventListener('click', () => {
            chat.discard();
            this.draft = null;
            this.shownIntent = null;
            this.say('note', 'Discarded the pending edits.');
            this.after();
        });
        box.querySelector('[data-act="regenerate"]')?.addEventListener('click', () => {
            if (this.draft && !this.busy) this.describe(this.draft.description);
        });
    }

    async apply() {
        if (this.draft) (await import('./petri-draft-ui.js')).applyDraftProposal(this.view, this.chat, this.draft);
        else this.chat.apply();
        this.draft = null;
        this.say('note', 'Applied. Undo brings the previous net back.');
        this.after();
    }

    after() {
        this.results.refreshStale();
        this.refreshEmpty().catch(() => {});
        this.renderPending();
        this.updateIntent();
    }

    // ---- Tools: what it can use, what it has run ----

    renderTools() {
        const { chat } = this;
        const a = this.ask;
        const tools = chat.tools;
        const runs = chat.calls.length;
        const info = toolsInfo({ toolset: chat.toolset, tools, manifest: chat.manifest, runs, state: a.state, mode: chat.effectiveMode, shortcut: this.shortcut() });
        this.$('.pv-chat-tools-count').textContent = info.count;
        this.$('.pv-chat-tools-runs').hidden = !info.showRuns;
        this.$('.pv-chat-calls-empty').hidden = runs > 0;
        const note = this.$('.pv-chat-tools-note');
        note.hidden = !info.note;
        note.innerHTML = info.note ? `${esc(info.note)}${chat.toolset === 'goals' && a.state !== 'signed-out' ? ' <button type="button" class="pv-prov-link" data-ask="palette">Open Tools</button>' : ''}` : '';
        const key = `${chat.toolset}:${tools.length}`;
        if (this.toolsListed === key) return; // the list changes with the mode, and redrawing it would close what is open
        this.toolsListed = key;
        const groups = new Map();
        for (const t of tools) {
            const prefix = t.command ? t.command.split('.')[0] : '';
            const name = t.command ? TOOL_GROUPS[prefix] || prefix[0].toUpperCase() + prefix.slice(1) : 'Ask';
            groups.set(name, [...(groups.get(name) || []), t]);
        }
        this.$('.pv-chat-avail').innerHTML = [...groups].map(([name, ts]) => `<details class="pv-chat-avail-group"><summary>${esc(name)} <span class="pv-result-dim">(${ts.length})</span></summary>
            <ul>${ts.map((t) => `<li><code>${esc(t.command || t.name)}</code> ${esc(t.description)}</li>`).join('')}</ul></details>`).join('');
    }

    renderSteps() {
        const { chat } = this;
        const box = this.$('.pv-chat-steps');
        box.hidden = chat.effectiveMode !== 'build';
        const { STEPS } = this.chatMod;
        const at = STEPS.indexOf(chat.step);
        box.innerHTML = STEPS.map((s, i) => `<button type="button" class="pv-chat-step${i === at ? ' pv-active' : i < at ? ' pv-chat-step-past' : ''}" data-step="${s}" title="Move the interview to ${s}">${s}</button>`).join('');
        box.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => { chat.step = b.dataset.step; this.renderSteps(); }));
    }

    /** One call the loop made, in the Tools section: its arguments and time, its artifacts, Rerun, Copy MCP call. */
    renderCall(entry) {
        const li = document.createElement('li');
        li.className = entry.ok ? 'pv-chat-call' : 'pv-chat-call pv-chat-call-err';
        const args = JSON.stringify(entry.args);
        const mcp = this.mcpFor(entry);
        li.innerHTML = `<code>${esc(entry.command || entry.name)}</code> <span class="pv-result-dim">${esc(args.length > 120 ? args.slice(0, 117) + '…' : args)} · ${entry.ms} ms</span>
            ${entry.ok ? '' : `<div class="pv-chat-err">${esc(entry.error)}</div>`}
            ${entry.warning ? `<div><span class="pv-engine-warn">${esc(entry.warning)}</span></div>` : ''}
            <div class="pv-chat-call-acts">
                ${(entry.artifacts || []).map((id) => `<button type="button" class="pv-btn" data-show="${esc(id)}">${esc(id)}</button>`).join('')}
                ${entry.kind === 'ask' || entry.kind === 'view' ? '' : '<button type="button" class="pv-btn" data-act="rerun">Rerun</button>'}
                ${mcp ? '<button type="button" class="pv-btn" data-act="mcp">Copy MCP call</button>' : ''}
            </div>
            <div class="pv-chat-art"></div>`;
        const R = this.results.R;
        li.querySelectorAll('[data-show]').forEach((b) => b.addEventListener('click', () => {
            const art = this.live.artifact(b.dataset.show);
            const box = li.querySelector('.pv-chat-art');
            const r = R.renderArtifact(this.view._solverModule, art, { width: 520, height: 300 });
            box.innerHTML = `<div class="pv-result-dim">${esc(art.title)}</div>${r.svg || ''}${r.html}`;
            if (r.plotData) this.view._solverModule.SVGPlotter.setupInteractivity(r.plotData);
            R.wireArtifact(box, art, (cid, cargs) => this.live.execute(cid, cargs), (m) => this.say('note', m));
        }));
        li.querySelector('[data-act="rerun"]')?.addEventListener('click', async () => {
            const epoch = this.results.epoch;
            const again = await this.chat.rerun(entry);
            if (epoch !== this.results.epoch) return;
            this.renderCall(again);
            if (again.ok && again.kind === 'goal') this.results.add(again.result, { pickedBy: 'you' });
            this.renderPending();
        });
        li.querySelector('[data-act="mcp"]')?.addEventListener('click', () => {
            if (this.view._copyToClipboard) this.view._copyToClipboard(mcp, () => this.view._toast('MCP call copied'), () => this.view._toast(mcp));
            else this.view._toast(mcp);
        });
        this.$('.pv-chat-calls').appendChild(li);
        this.renderTools();
    }

    /** The MCP tools/call params that repeat a logged call, or '' for the interface's own tools (a question card, a view). */
    mcpFor(entry) {
        if (entry.kind === 'goal' && entry.result?.record?.calls?.length) {
            const calls = entry.result.record.calls.map((c) => ({ name: c.command, arguments: c.args || {} }));
            return JSON.stringify(calls.length === 1 ? calls[0] : calls, null, 2);
        }
        if (entry.kind === 'ask' || entry.kind === 'view' || entry.kind === 'schema' || entry.kind === 'goal') return '';
        const command = entry.kind === 'command' ? entry.command : entry.command || entry.name;
        const args = entry.kind === 'command' ? entry.commandArgs : entry.args;
        return command ? JSON.stringify({ name: command, arguments: args || {} }, null, 2) : '';
    }
}

/**
 * Open (or focus) the Ask pane. `message` is sent as the first turn (the landing page's prompt, the menu's Ask bar). `mode` is
 * 'auto' (nothing forced: the server labels each message), or build / analyse / explain ('design' is build) for a link that
 * states one (/?route=build, the empty canvas's button). `focus: false` opens it without taking the keyboard (a result landing).
 * Resolves to the panel element; its `_ask` is the pane.
 */
export async function openChat(view, { mode, message, focus = true } = {}) {
    let pane = view._askPane;
    if (pane?.panel) {
        pane.reopen();
        await pane.refreshStatus();
        if (mode && pane.chat.mode !== pane.modeOf(mode)) pane.setMode(mode);
    } else {
        view._askOpening ||= (async () => {
            const p = new AskPane(view);
            await p.init({ mode });
            view._askPane = p;
            return p;
        })();
        try { pane = await view._askOpening; } finally { view._askOpening = null; }
        if (mode && pane.chat.mode !== pane.modeOf(mode)) pane.setMode(mode);
        pane.reopen();
    }
    if (message) {
        pane.input.value = message;
        await pane.submit(message);
    }
    if (focus) pane.focus();
    return pane.panel;
}
