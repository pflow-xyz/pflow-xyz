// petri-results-pane.js — where a result lands (docs/design/agent-first-analysis.md sections 4.5 and 6).
//
// Every way of getting a result (the Ask pane's goals, the Tools palette, an opened link) hands it to
// showResult(view, result), so a result looks the same wherever it came from: the answer, the evidence, and the
// "How this was computed" footer with its five actions. This module is the one place that knows how. A result is a
// CARD in the Ask pane's session list (petri-chat-ui.js owns the pane; ResultsList below owns the cards), which is
// what replaces the Results dialog for agent results.
//
// A result:
//   {
//     title:     string                    what was asked or run, in words
//     source:    'ask' | 'palette' | 'link' | 'classic'
//     goal:      {id, question} | null
//     record:    a petri-provenance.js record (provenance() / recordFromGoalRun() / recordFromCall())
//     artifacts: Array<{id, title, data, source}>   the artifact OBJECTS the calls stored (not ids)
//     registry:  the Registry that holds them and that "Rerun" / "Edit settings" run on (a sandbox, never the live net)
//     answer:    {by: 'assistant', text, stray?} | null     model text, always labelled as the assistant's
//     warnings:  string[]                  a refused step, an engine override, a drift notice
//     stale:     boolean                   the net changed since the result was made
//   }
// and, when a ChatSession made it (petri-chat.js): id, inputs, assumed (each with how/label/value/change), caveat,
// answerShape, followUps (goal ids), onPending / onProposal. The pane sets `pickedBy` ('assistant' | 'you') when it
// adds one: "I answered: ..." and "Not that" are only for a goal the model chose.
//
// What a card shows, top to bottom (design 4.5): the goal the model chose ("I answered: ...", with Not that), the
// warning chips, the model's one or two sentences labelled `assistant`, the evidence labelled `engine` (the artifacts,
// petri-results.js), the goal's own answer shape and caveat (goals.json, never the model's), the Assumed rows each with
// a Change, the provenance footer with its five actions, and 2 to 3 follow-ups. A result made stale by a later edit to
// the net says so and offers Rerun.
//
// The footer's actions (design 6):
//   Rerun            the same calls again (ChatSession.rerunResult, seeds and all): if the net is the same and the
//                    artifacts have the same digests the card says "reproduced"; otherwise the rerun is a new card
//   Edit settings    a form per call generated from its JSON Schema, prefilled; Run adds a NEW card beside the old one
//   Copy MCP call    the tools/call params for the record's calls
//   Copy link        view._copyViewLink(record) when the view has it
//   Open in Tools    view._openPaletteFor(record) when the view has it
//
// The logic (what a card shows, what a Change patches) is petri-ask-pane.js; this file draws it and wires the events.

import { footerHtml, mcpCallText, wireFooter } from './petri-provenance.js';
import { renderMarkdown } from './petri-markdown.js';
import { announcement, cardModel, editSettings, isStaleResult, patchForChange, patchFromEdit, sameEvidence, withChange } from './petri-ask-pane.js';
import { readForm, renderFormHtml, showFormErrors } from './petri-schema-form.js';
import { netRevision } from './petri-chat.js';
import { createHeadlessHost } from './petri-commands.js';

function esc(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** The revision of a net as the sessions' sandboxes hold it (normalized the way createHeadlessHost does), so a fresh result is not "stale" on sight. Layout is not part of it (petri-chat.js netRevision). */
export function netKey(model) {
    return netRevision(createHeadlessHost(structuredClone(model)).getModel());
}

let cardSeq = 0;

/**
 * The session list of results. `env` is the Ask pane:
 *   view, host (the element cards are appended to), catalog (goals.json), live (the editor's Registry),
 *   chat (the ChatSession: rerunResult, model(), runCall), runner (the session that runs a goal with no model),
 *   announce(text), toast(text), followUp(question), notThat(result), scrolled() (the log should stay pinned)
 */
export class ResultsList {
    constructor(env) {
        this.env = env;
        /** @type {Map<string, {result: any, el: HTMLElement, stale: boolean, latest: boolean, note: any}>} */
        this.items = new Map();
        this.solver = null;
        this.R = null;
        /** Bumped by reset(): a run still going for a card of an earlier conversation must not land in this one. */
        this.epoch = 0;
    }

    /** A new conversation: the cards are gone, and what was still running for them is dropped when it finishes. */
    reset() {
        this.epoch++;
        this.items.clear();
    }

    async load() {
        this.R ||= await import('./petri-results.js');
        this.solver ||= this.env.view._solverModule || (this.env.view._solverModule = await import('./petri-solver.js'));
        return this;
    }

    /** A new turn begins: no earlier card is the latest answer any more (Not that applies to the last turn only). */
    beginTurn() {
        for (const item of this.items.values()) {
            if (!item.latest) continue;
            item.latest = false;
            this.renderHead(item);
        }
    }

    /**
     * Add a result as a card and return it. `after` puts it beside an earlier card (Edit settings, Change, Rerun);
     * otherwise it goes at the end of the list.
     * @param {any} result
     * @param {{pickedBy?: 'assistant'|'you', latest?: boolean, after?: {el: HTMLElement}|null}} [o]
     */
    add(result, { pickedBy, latest = false, after = null } = {}) {
        if (!result.id) result.id = `rc${++cardSeq}`;
        if (pickedBy) result.pickedBy = pickedBy;
        const el = document.createElement('article');
        el.className = 'pv-ask-card';
        el.dataset.result = result.id;
        el.dataset.source = result.source || 'ask';
        el.tabIndex = -1;
        el.setAttribute('aria-label', `Result: ${result.goal?.question || result.title || 'result'}`);
        el.innerHTML = `
            <div class="pv-ask-head"></div>
            <div class="pv-ask-warns"></div>
            <div class="pv-ask-answer"></div>
            <div class="pv-ask-evidence"></div>
            <div class="pv-ask-shape"></div>
            <div class="pv-ask-assumed"></div>
            <p class="pv-ask-stale" role="status" hidden></p>
            <p class="pv-ask-note" role="status" hidden></p>
            <div class="pv-ask-footer"></div>
            <div class="pv-ask-edit" hidden></div>
            <div class="pv-ask-follow"></div>`;
        const item = { result, el, stale: false, latest, note: null };
        if (after?.el?.isConnected) after.el.after(el);
        else this.env.host.appendChild(el);
        this.items.set(result.id, item);
        this.renderParts(item);
        this.renderEvidence(item);
        this.renderFooter(item, { open: this.items.size === 1 });
        el.addEventListener('click', (e) => this.onClick(item, e));
        wireFooter(el, result.record, this.handlers(item));
        this.refreshStale();
        this.env.announce?.(announcement(result));
        this.env.scrolled?.(el);
        return item;
    }

    model(item) {
        return cardModel(item.result, { catalog: this.env.catalog, stale: item.stale, latest: item.latest });
    }

    /** The parts that change after a card is made: the model's answer arrives after the evidence, and a net edit makes it stale. */
    renderParts(item) {
        this.renderHead(item);
        this.renderWarns(item);
        this.renderAnswer(item);
        this.renderShape(item);
        this.renderAssumed(item);
        this.renderStale(item);
        this.renderFollow(item);
    }

    $(item, sel) {
        return item.el.querySelector(sel);
    }

    renderHead(item) {
        const m = this.model(item);
        this.$(item, '.pv-ask-head').innerHTML = `<h4 class="pv-ask-title">${esc(m.answered || m.title)}</h4>`
            + `${m.notThat ? '<button type="button" class="pv-btn pv-btn-sm" data-ask="notthat" title="Ask again, and pick a different goal">Not that</button>' : ''}`;
    }

    renderWarns(item) {
        const m = this.model(item);
        this.$(item, '.pv-ask-warns').innerHTML = m.chips.map((c) => `<span class="pv-engine-warn" data-kind="${esc(c.kind)}"${c.title ? ` title="${esc(c.title)}"` : ''}>${esc(c.text)}</span>`).join(' ');
    }

    renderAnswer(item) {
        const m = this.model(item);
        this.$(item, '.pv-ask-answer').innerHTML = m.answer
            ? `<div class="pv-ask-line"><span class="pv-prov-chip pv-prov-ast" title="The assistant's own words: its judgment, not the engine's output">assistant</span><div class="pv-ask-md">${renderMarkdown(m.answer.text)}</div></div>`
            : '';
    }

    renderShape(item) {
        const m = this.model(item);
        this.$(item, '.pv-ask-shape').innerHTML = [
            m.answerShape ? `<p class="pv-ask-caveat"><strong>Reads as</strong> ${esc(m.answerShape)}</p>` : '',
            m.caveat ? `<p class="pv-ask-caveat"><strong>Caveat</strong> <span class="pv-result-dim">(from the goal)</span> ${esc(m.caveat)}</p>` : '',
        ].join('');
    }

    renderAssumed(item) {
        const m = this.model(item);
        const box = this.$(item, '.pv-ask-assumed');
        if (!m.assumed.length) { box.innerHTML = ''; return; }
        box.innerHTML = `<div class="pv-ask-label">Assumed</div><ul class="pv-ask-assumed-list">${m.assumed.map((a, i) => `
            <li data-i="${i}">${a.by === 'assistant' ? '<span class="pv-prov-chip pv-prov-ast">assistant</span> ' : ''}<span class="pv-ask-assumed-text">${esc(a.text)}</span>
            ${a.change ? ` <button type="button" class="pv-prov-link" data-ask="change" data-i="${i}">Change</button>` : ''}
            <span class="pv-ask-changer" hidden></span></li>`).join('')}</ul>`;
    }

    renderStale(item) {
        const p = this.$(item, '.pv-ask-stale');
        p.hidden = !item.stale;
        item.el.dataset.stale = item.stale ? 'true' : 'false';
        p.innerHTML = item.stale
            ? '<span class="pv-prov-chip pv-prov-warn">net changed since</span> The net has changed since this result was made. <button type="button" class="pv-btn pv-btn-sm" data-ask="rerun">Rerun</button>'
            : '';
    }

    renderFollow(item) {
        const m = this.model(item);
        this.$(item, '.pv-ask-follow').innerHTML = m.followUps.length
            ? `<span class="pv-result-dim">Next:</span> ${m.followUps.map((f) => `<button type="button" class="pv-btn pv-btn-sm" data-ask="follow" data-goal="${esc(f.id)}">${esc(f.question)}</button>`).join(' ')}`
            : '';
    }

    /** The evidence: the artifacts, drawn by petri-results.js, under the `engine` label. In the document before the plots wire their hover. */
    renderEvidence(item) {
        const { result } = item;
        const box = this.$(item, '.pv-ask-evidence');
        const arts = result.artifacts || [];
        if (!arts.length) { box.innerHTML = ''; return; }
        box.innerHTML = '<div class="pv-ask-line"><span class="pv-prov-chip pv-ask-eng" title="Produced by a command the engine ran, not by the model">engine</span></div>';
        for (const art of arts) {
            const part = document.createElement('div');
            part.className = 'pv-ask-art';
            const r = this.R.renderArtifact(this.solver, art, { width: 520, height: 300 });
            part.innerHTML = `<div class="pv-result-dim">${esc(art.title)} · ${esc(art.id)}</div>${r.svg || ''}${r.html}`;
            box.appendChild(part);
            if (r.plotData) this.solver.SVGPlotter.setupInteractivity(r.plotData);
            // (view commands act on the canvas: the live registry, as the Assistant's own view tools do)
            this.R.wireArtifact(part, art, (id, a) => this.env.live.execute(id, a), (m) => this.env.toast?.(m, 'error'));
        }
    }

    renderFooter(item, { open } = {}) {
        const box = this.$(item, '.pv-ask-footer');
        const was = box.querySelector('details');
        const opened = open ?? (was ? was.open : false);
        box.innerHTML = footerHtml(item.result.record, { open: opened, stale: item.stale });
    }

    // ---- staleness ----

    /** Judge every card against the net as it is now (the live net; a result made on a pending change, the sandbox). */
    refreshStale() {
        let live, sandbox;
        try { live = netKey(this.env.view.getModel()); } catch { live = undefined; }
        try { sandbox = netRevision(this.env.chat.model()); } catch { sandbox = undefined; }
        for (const item of this.items.values()) {
            const stale = isStaleResult(item.result, { liveKey: live, sandboxKey: sandbox });
            if (stale === item.stale) continue;
            item.stale = stale;
            item.result.stale = stale;
            this.renderStale(item);
            this.renderFooter(item);
        }
    }

    // ---- the model's answer arrives ----

    /** The reply that followed a goal result is its answer (ChatSession's `answer` event): redraw what it changes. */
    setAnswer(result) {
        const item = this.items.get(result.id);
        if (!item) return;
        this.renderWarns(item);
        this.renderAnswer(item);
        this.env.scrolled?.(item.el);
    }

    /** "Not that": the card stays, set aside, with nothing more to do on it. */
    setAside(result) {
        const item = this.items.get(result.id);
        if (!item) return;
        item.latest = false;
        item.el.dataset.aside = 'true';
        this.renderHead(item);
        this.say(item, 'Set aside: not the answer you were after.');
    }

    // ---- the card's own buttons ----

    onClick(item, e) {
        const b = e.target.closest?.('[data-ask]');
        if (!b || !item.el.contains(b)) return;
        switch (b.dataset.ask) {
        case 'notthat': this.env.notThat?.(item.result); break;
        case 'follow': this.env.followUp?.(this.env.catalog.goals.find((g) => g.id === b.dataset.goal)?.question || '', b.dataset.goal); break;
        case 'rerun': this.rerun(item); break;
        case 'change': this.openChange(item, +b.dataset.i, b); break;
        default: break;
        }
    }

    handlers(item) {
        const { view } = this.env;
        const { record } = item.result;
        return {
            rerun: () => this.rerun(item),
            edit: (_rec, { field }) => this.openEdit(item, field),
            mcp: () => this.copyMcp(item),
            link: () => (typeof view._copyViewLink === 'function' ? view._copyViewLink(record) : this.env.toast?.('Copy link is not available here')),
            tools: () => (typeof view._openPaletteFor === 'function' ? view._openPaletteFor(record) : this.env.toast?.('Open in Tools is not available here')),
        };
    }

    copyMcp(item) {
        const { view } = this.env;
        const text = mcpCallText(item.result.record);
        if (typeof view._copyToClipboard === 'function') view._copyToClipboard(text, () => this.env.toast?.('MCP call copied'), () => this.env.toast?.(text));
        else this.env.toast?.(text);
    }

    say(item, text, kind = 'info') {
        const p = this.$(item, '.pv-ask-note');
        p.hidden = !text;
        p.dataset.kind = kind;
        p.textContent = text || '';
        item.note = text ? { text, kind } : null;
    }

    busy(item, on, text = '') {
        item.el.setAttribute('aria-busy', on ? 'true' : 'false');
        item.el.querySelectorAll('[data-ask="rerun"], [data-act="rerun"], [data-act="edit"], [data-ask="change"]').forEach((b) => { b.setAttribute('aria-disabled', on ? 'true' : 'false'); });
        if (on) this.say(item, text, 'running');
        // a run that failed leaves its own error, not "Running…": only the running note goes (a result's own note stays)
        else if (item.note?.kind === 'running') this.say(item, '');
    }

    // ---- Rerun ----

    /** Rerun: the same calls on a fresh sandbox. The net the same and the artifacts the same by digest: "reproduced"; else a new card beside it. */
    async rerun(item) {
        if (item.el.getAttribute('aria-busy') === 'true') return;
        this.busy(item, true, 'Rerunning…');
        const epoch = this.epoch;
        try {
            const again = await this.env.chat.rerunResult(item.result);
            if (epoch !== this.epoch) return; // New was pressed while it ran
            const same = !item.stale && await sameEvidence(item.result, again);
            if (same && (item.result.artifacts || []).length) {
                this.say(item, 'Reproduced: the same calls gave the same artifacts, byte for byte at the footer\'s rounding.', 'ok');
                this.env.announce?.('Reproduced: the rerun gave the same artifacts.');
            } else if (same) {
                this.say(item, 'Reran: this result has no artifacts to compare.', 'ok');
            } else {
                const next = this.add(again, { pickedBy: 'you', after: item });
                this.say(next, item.stale ? 'The same calls on the net as it is now.' : 'Differs from the first run: the artifacts are not the same.', item.stale ? 'info' : 'warn');
                this.say(item, item.stale ? 'Rerun on the net as it is now: the new card is below.' : 'The rerun differs: the new card is below.', 'info');
            }
        } catch (e) {
            this.say(item, `Rerun failed: ${e.message || e}`, 'error');
        } finally {
            this.busy(item, false);
        }
    }

    // ---- Edit settings ----

    /** Edit settings: a form per call, prefilled; Run adds a new card next to this one. `field` focuses a control (the footer's Change on an assumption). */
    openEdit(item, field = null) {
        const box = this.$(item, '.pv-ask-edit');
        if (!box.hidden && !field) { box.hidden = true; box.innerHTML = ''; return; }
        const forms = editSettings(item.result.record, (id) => this.env.live.describe(id));
        const model = this.env.chat.model();
        const places = Object.keys(model.places || {});
        const transitions = Object.keys(model.transitions || {});
        box.hidden = false;
        box.innerHTML = `<form class="pv-ask-editform" novalidate>
            <div class="pv-ask-label">Edit settings</div>
            <p class="pv-result-dim">Run adds a new card beside this one; this result stays as it is.</p>
            ${forms.length ? forms.map((f) => `<fieldset class="pv-ask-callform" data-index="${f.index}"><legend><code>${esc(f.command)}</code> ${f.label !== f.command ? `<span class="pv-result-dim">${esc(f.label)}</span>` : ''}</legend>
                ${renderFormHtml(f.model, { esc, places, transitions, idPrefix: `pv-es-${item.result.id}-${f.index}` })}</fieldset>`).join('')
            : '<p class="pv-result-dim">None of this result\'s calls takes settings.</p>'}
            <div class="pv-form-summary" role="alert" hidden></div>
            <div class="pv-ask-acts">${forms.length ? '<button type="submit" class="pv-btn pv-btn-primary pv-btn-sm">Run</button>' : ''}<button type="button" class="pv-btn pv-btn-sm" data-ask="cancel-edit">Cancel</button></div>
        </form>`;
        const form = box.querySelector('form');
        box.querySelector('[data-ask="cancel-edit"]').addEventListener('click', () => { box.hidden = true; box.innerHTML = ''; });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const summary = form.querySelector('.pv-form-summary');
            const patches = [];
            const problems = [];
            for (const f of forms) {
                const fs = form.querySelector(`.pv-ask-callform[data-index="${f.index}"]`);
                const { args, errors } = readForm(fs, f.model);
                showFormErrors(fs, errors);
                problems.push(...errors.map((x) => x.message));
                patches[f.index] = patchFromEdit(f.recorded, f.model, args) || undefined;
            }
            if (problems.length) { summary.hidden = false; summary.textContent = problems.join(' · '); return; }
            if (!patches.some(Boolean)) { summary.hidden = false; summary.textContent = 'Nothing changed. Change a setting, or use Rerun to repeat the same calls.'; return; }
            summary.hidden = true;
            this.busy(item, true, 'Running with your settings…');
            const epoch = this.epoch;
            try {
                const next = await this.env.chat.rerunResult(item.result, { args: patches });
                if (epoch !== this.epoch) return;
                box.hidden = true;
                box.innerHTML = '';
                this.add(next, { pickedBy: 'you', after: item });
                this.say(item, 'Ran again with your settings: the new card is below.', 'info');
            } catch (err) {
                summary.hidden = false;
                summary.textContent = `The run failed: ${err.message || err}`;
            } finally {
                this.busy(item, false);
            }
        });
        const target = field ? form.querySelector(`[data-field="${CSS.escape(field)}"]`) : form.querySelector('[data-field]');
        (target || form.querySelector('button')).focus();
        this.env.scrolled?.(box);
    }

    // ---- Change ----

    /** Change: the control for one assumption, and a rerun with the person's value (a new card). */
    openChange(item, i, button) {
        const row = item.el.querySelectorAll('.pv-ask-assumed-list li')[i];
        const slot = row?.querySelector('.pv-ask-changer');
        const a = this.model(item).assumed[i];
        if (!slot || !a?.change) return;
        if (!slot.hidden) { slot.hidden = true; slot.innerHTML = ''; return; }
        const c = a.change;
        const id = `pv-ch-${item.result.id}-${i}`;
        const control = c.kind === 'select'
            ? `<select id="${id}" aria-label="Change: ${esc(a.source.label || a.key)}">${c.optional ? '<option value="">(the command picks)</option>' : ''}${c.options.map((o) => `<option value="${esc(o)}"${String(o) === String(c.value) ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select>`
            : `<input id="${id}" type="text" inputmode="${c.kind === 'number' ? 'decimal' : 'text'}" autocomplete="off" spellcheck="false" aria-label="Change: ${esc(a.source.label || a.key)}" value="${esc(c.value)}">`;
        slot.hidden = false;
        slot.innerHTML = `${control} <button type="button" class="pv-btn pv-btn-primary pv-btn-sm" data-do="go">Run with this</button> <button type="button" class="pv-btn pv-btn-sm" data-do="cancel">Cancel</button><span class="pv-form-err" role="alert" hidden></span>`;
        const ctl = slot.querySelector(`#${id}`);
        const err = slot.querySelector('.pv-form-err');
        slot.querySelector('[data-do="cancel"]').addEventListener('click', () => { slot.hidden = true; slot.innerHTML = ''; button.focus(); });
        slot.querySelector('[data-do="go"]').addEventListener('click', async () => {
            err.hidden = true;
            // (the blank option of an input the words did not name is what already ran: running it again would only add a copy of this card)
            if (ctl.value === '') { err.hidden = false; err.textContent = c.optional ? 'That is what ran: the command picked. Choose a value, or Cancel.' : 'Give a value.'; return; }
            this.busy(item, true, 'Running with your value…');
            const epoch = this.epoch;
            try {
                const next = await this.changeAndRun(item, a, ctl.value);
                if (epoch !== this.epoch) return;
                slot.hidden = true;
                slot.innerHTML = '';
                this.add(next, { pickedBy: 'you', after: item });
                this.say(item, `Ran again with ${a.source.label || a.key} = ${ctl.value}: the new card is below.`, 'info');
            } catch (e) {
                err.hidden = false;
                err.textContent = e.message || String(e);
            } finally {
                this.busy(item, false);
            }
        });
        ctl.focus();
    }

    /**
     * The result with an assumption given another value. The plan's own references say which call argument takes the
     * input, and rerunResult keeps every other argument as it was (same seed, same horizon). When the input sits in a nested
     * argument (best_setting's scenarios), the goal runs again with it instead, still with no model.
     */
    async changeAndRun(item, a, value) {
        const { result } = item;
        const goal = this.env.catalog.goals.find((g) => g.id === result.goal?.id);
        const change = a.change;
        const patch = goal ? patchForChange(result, goal, { input: change.input, kind: a.source.change.kind }, value) : null;
        if (patch) return withChange(await this.env.chat.rerunResult(result, { args: patch }), a.source, a.source.change.kind === 'number' ? Number(value) : value);
        if (!goal || !this.env.runner) throw new Error('This assumption cannot be changed here; use Edit settings.');
        const inputs = { ...(result.inputs || {}), [change.input]: a.source.change.kind === 'number' ? Number(value) : value };
        if (value === '') delete inputs[change.input];
        const entry = await this.env.runner.runCall({ name: 'run_goal', args: { goal_id: goal.id, inputs: JSON.stringify(inputs) } }, 0, { userText: '' });
        if (!entry.ok) throw new Error(entry.error);
        return entry.result;
    }
}

/**
 * Show a result. Resolves to {close, element}: the card in the Ask pane's list (the pane opens if it is not open). `view`
 * is the <petri-view>; the footer's actions call the view's optional hooks when it has them: view._copyToClipboard,
 * view._copyViewLink(record), view._openPaletteFor(record).
 */
export async function showResult(view, result) {
    const ui = await import('./petri-chat-ui.js');
    const panel = await ui.openChat(view, { focus: false });
    const item = await panel._ask.showResult(result);
    return { close: () => { item.el.remove(); panel._ask.results.items.delete(result.id); }, element: item.el };
}
