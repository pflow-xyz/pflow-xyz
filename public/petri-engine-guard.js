// petri-engine-guard.js — the engine guard (agent-first analysis, Step 1), no DOM.
//
// A net's own analysis says which engine can answer a question about it:
// sim.recommend applies docs/engine-selection.md (inhibitor or read arcs and
// reachable capacities mean the SSA, Rule 1; small token counts mean the SSA
// and its spread, Rule 2; otherwise the ODE). The live test showed what happens
// when nothing enforces it: analysis.diagnose ran the ODE although
// sim.recommend said SSA, and returned a confident, wrong ranking. A prompt
// does not fix that; this module is the mechanism that does. A plan or a tool
// call that names a command the recommendation rules out is refused before it
// runs, unless the person asked for that engine in their own words.
//
// What lives here:
//
//   ENGINE_NEEDS      which registry commands depend on the engine, and what
//                     to do when the recommendation rules it out
//   engineNeeded      the lookup
//   checkEngine       the pure decision: (command, recommendation) → verdict
//   overrideAllowed   whether the person's words name an engine; the model may
//                     PASS an override, the code decides whether it counts
//   EngineGuard       checkEngine plus sim.recommend, run once per net
//                     revision however many guarded calls follow
//   refusalText       the words a refusal puts in front of the model
//   needsGuard        whether a call has anything for the guard to look at
//                     (a command in the table, or macro.play)
//   isEdit            whether a command changes the net (the chat's sandbox
//                     rule, kept here so the macro check reads the same one)
//
// A stored macro is a plan the engine runs by itself: macro.play replays
// its steps inside the native engine, past anything a caller could check. So
// the guard reads the macro first (macro.get, nested macro.play steps
// expanded) and holds every step to the same rules, refusing the whole play
// when one step is refused, with nothing run. See EngineGuard.check.
//
// Two rules, both from the recommendation:
//
//   HARD  recommendation.gating is not empty (inhibitor or read arcs, a
//         reachable capacity): the ODE and the SDE would silently model an
//         unconstrained system. A command that needs one is refused, unless
//         the override names that engine.
//   SOFT  no gating, but the recommendation says SSA because the token counts
//         are small: the ODE's mean-field answer can mislead. A command that
//         ranks (onSoft 'refuse') is refused; one that only draws a curve
//         (onSoft 'warn') runs and carries a warning chip.
//
// An override that was used always comes back as a 'warn': a visible chip,
// never silence. SSA-needing commands are never refused (the SSA can read
// every net), so none is in the table. Registry.execute stays unguarded on
// purpose: a dialog or the palette naming an engine is the person's own
// choice. The guard sits in front of plans (petri-goals.js runGoal) and the
// model's tool calls (petri-chat.js ChatSession.runCall).

import { NATIVE_COMMANDS } from './vendor/pflow-native-wasm/commands.js';

export const ENGINES = Object.freeze({ ode: 'ODE', sde: 'SDE', ssa: 'SSA' });

/** The two rules of docs/engine-selection.md the guard enforces, as they are cited. */
export const RULES = Object.freeze({
    firing: Object.freeze({
        id: 'docs/engine-selection.md Rule 1',
        title: 'if the model has a firing instant, the ODE cannot see it',
    }),
    population: Object.freeze({
        id: 'docs/engine-selection.md Rule 2',
        title: 'population size decides who is telling the truth about noise',
    }),
});

// Scenario engine arguments: sim.scenario and sim.compare take the engine
// inside a scenario object (or a string holding one), 'ssa' unless it says ode.
function asValue(v) {
    if (typeof v !== 'string') return v;
    try { return JSON.parse(v); } catch { return null; }
}
const namesOde = (s) => !!s && typeof s === 'object' && String(s.engine || '').toLowerCase() === 'ode';

/**
 * Commands whose answer depends on the engine. An absent command is
 * unguarded. Fields: needs ('ode' | 'sde' | 'ssa'), onSoft ('refuse' | 'warn':
 * what the soft rule does), instead (what to use, as a phrase after "Use"),
 * when(args) (only some calls of the command need the engine).
 */
export const ENGINE_NEEDS = Object.freeze({
    // Integrates the mass-action ODE; the one command whose whole job is the ODE curve, so a small net only earns the chip.
    'sim.ode': { needs: 'ode', onSoft: 'warn', instead: 'sim.ssa with runs > 1 (the ensemble mean with a ±1 sd band)' },
    // Chemical Langevin SDE: continuous like the ODE, so it cannot express gating (the command itself refuses such a net too), and it is wrong near zero counts.
    'sim.sde': { needs: 'sde', onSoft: 'warn', instead: 'sim.ssa' },
    // Sweeps one rate and reads each place at t_end off an ODE run per rate: a mean-field response curve, readable with the chip on a small net.
    'opt.rate_scan': { needs: 'ode', onSoft: 'warn', instead: 'sim.compare with one scenario per rate (the SSA)' },
    // One place's ODE trajectory per rate of one transition: same mean-field reading as the scan.
    'opt.sweep': { needs: 'ode', onSoft: 'warn', instead: 'sim.compare with one scenario per rate (the SSA)' },
    // Ranks every rate and initial token by its effect on an ODE run: the live-test failure; on a small or constrained net it ranks a knob that matters as irrelevant, so it is refused, and analysis.diagnose_ssa is the twin.
    'analysis.diagnose': { needs: 'ode', onSoft: 'refuse', instead: 'analysis.diagnose_ssa' },
    // Integrates the ODE until |du/dt| is small: the steady state of the mean-field system, which a capacity or an inhibitor changes.
    'sim.equilibrium': { needs: 'ode', onSoft: 'warn', instead: 'sim.ssa over a long horizon' },
    // Maps an observable over a grid of two rates, one ODE run per cell: a mean-field surface.
    'opt.heatmap': { needs: 'ode', onSoft: 'warn', instead: 'sim.compare over a few rate pairs (the SSA)' },
    // Monte Carlo over rates, one ODE run per sample, and it names the non-dominated settings; no SSA twin exists, so the small-net case is a chip, not a wall.
    'opt.optimize': { needs: 'ode', onSoft: 'warn', instead: 'sim.compare over a few candidate rate sets (the SSA)' },
    // Fits rates so the ODE matches the data (and with apply writes them into the net): on a gated net the fit absorbs what the ODE cannot see into the rates.
    'opt.fit': { needs: 'ode', onSoft: 'warn' },
    // A scenario names its engine; engine "ode" is the mean-field one (the default is the SSA, which is why the command is guarded only when asked for the ODE).
    'sim.scenario': { needs: 'ode', onSoft: 'warn', instead: 'the scenario without engine "ode" (the SSA is the default)', when: (a) => namesOde(asValue(a?.scenario)) },
    // Same, per scenario: one scenario with engine "ode" makes the whole comparison an ODE one.
    'sim.compare': { needs: 'ode', onSoft: 'warn', instead: 'the scenarios without engine "ode" (the SSA is the default)', when: (a) => { const l = asValue(a?.scenarios); return Array.isArray(l) && l.some(namesOde); } },
    // Considered and left out (see the package report): sim.what_if / sim.ssa / analysis.diagnose_ssa / sim.evaluate / opt.distill / data.generate
    // are SSA (valid on every net); sim.crosscheck compares the engines and skips the ODE half itself on a gated net; system.run runs library
    // models, not the open net the recommendation is about; analysis.check's ODE smoke test validates, it does not answer.
    // macro.play is not in the table because it needs no single engine: it runs stored command steps inside the native engine,
    // so EngineGuard.check expands the macro and holds each step to this table (nested macros included).
});

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * What a command needs from the engine, or null when it is unguarded. Given
 * its arguments, a call that does not use the engine (a scenario without
 * engine "ode") is null too.
 * @param {string} commandId
 * @param {Object} [args]
 * @returns {{needs: 'ode'|'sde'|'ssa', onSoft: 'refuse'|'warn'} | null}
 */
export function engineNeeded(commandId, args) {
    if (!hasOwn(ENGINE_NEEDS, commandId)) return null;
    const e = ENGINE_NEEDS[commandId];
    if (args !== undefined && e.when && !e.when(args || {})) return null;
    return { needs: e.needs, onSoft: e.onSoft };
}

/** The command that replays stored command steps: the one indirection the table cannot see through. */
export const MACRO_PLAY = 'macro.play';

/**
 * Does this call have anything for the guard to look at: a command in the
 * table whose engine this call uses, or macro.play (whose steps are).
 * @param {string} commandId
 * @param {Object} [args]
 */
export function needsGuard(commandId, args) {
    return commandId === MACRO_PLAY || engineNeeded(commandId, args) !== null;
}

// ---- which commands change the net ----

// Commands that change the document (or the token game's marking, which
// lives in it): they make the chat's sandbox differ from the live net, and a
// step of a macro that is one of them can change what sim.recommend says
// about the steps after it.
const EDITS = new Set(['file.new', 'edit.undo', 'edit.redo', 'edit.delete', 'sim.fire', 'sim.reset', 'sim.set_rate', 'sim.goto']);
// pflow-native's commands that edit the net or move its marking (compose.fuse,
// file.open_example, sim.run, data.discover …), the ones that edit it only
// when called with apply (opt.fit, opt.distill, data.calibrate), and the one
// that edits it only when its `model` names the open net (system.set_port).
const NATIVE_EDITS = new Set(NATIVE_COMMANDS.filter((s) => s.edits || s.setsMarking).map((s) => s.id));
const NATIVE_EDITS_ON_APPLY = new Set(NATIVE_COMMANDS.filter((s) => s.editsOnApply).map((s) => s.id));
const NATIVE_EDITS_ON_CURRENT = new Map(NATIVE_COMMANDS.filter((s) => s.editsOnCurrent).map((s) => [s.id, s.editsOnCurrent]));

/**
 * Does this call change the net (or move its marking)?
 * @param {string} id
 * @param {Object} [args]
 * @returns {boolean}
 */
export const isEdit = (id, args) => EDITS.has(id) || (id.startsWith('net.') && id !== 'net.info') || NATIVE_EDITS.has(id)
    || (NATIVE_EDITS_ON_APPLY.has(id) && !!args?.apply)
    || (NATIVE_EDITS_ON_CURRENT.has(id) && [undefined, 'current'].includes(args?.[NATIVE_EDITS_ON_CURRENT.get(id)]));

// Edits that cannot change what sim.recommend says, which reads the arcs
// (inhibitor and read), the capacities and the token counts: rates, labels,
// positions, names, and the fits that only write rates. Every other edit
// might, so a macro that makes one is not trusted to leave the net as the
// guard saw it.
const KEEPS_RECOMMENDATION = new Set([
    'sim.set_rate', 'net.set_label', 'net.move', 'net.rename', 'net.layout', 'net.set_details', 'net.set_goals', 'net.set_views',
    'file.seal', 'opt.fit', 'opt.distill', 'data.calibrate',
]);

const label = (engine) => ENGINES[engine] || String(engine || '?').toUpperCase();
const tokensNote = (rec) => (Number.isFinite(rec.tokens) ? ` (only ${rec.tokens} token${rec.tokens === 1 ? '' : 's'} in all)` : '');

/** @returns {Verdict} */
function verdictOf(extra) {
    return { verdict: 'ok', needs: null, recommended: null, rule: null, message: '', ...extra };
}

/**
 * @typedef {Object} Verdict
 * @property {'ok'|'warn'|'refuse'} verdict
 * @property {string|null} needs        the engine the command needs (null: unguarded)
 * @property {string|null} recommended  the engine sim.recommend picked
 * @property {string|null} rule         the rule of docs/engine-selection.md that applied
 * @property {string} message           why it was refused, or the warning chip's text
 * @property {boolean} [overridden]     an override changed the outcome
 * @property {string} [instead]         what to use instead
 * @property {string} [overrideIgnored] an override was passed and not honoured
 */

/**
 * The decision, with no side effects: may this command run on the net the
 * recommendation is about?
 * @param {string} commandId
 * @param {Object|null} [recommendation]  the result of sim.recommend ({engine, gating, tokens, …})
 * @param {{override?: string, args?: Object}} [opts]  override: the engine the
 *   call is allowed to use against the recommendation (the caller has already
 *   decided it counts: see overrideAllowed)
 * @returns {Verdict}
 */
export function checkEngine(commandId, recommendation, { override, args } = {}) {
    const entry = engineNeeded(commandId, args) && ENGINE_NEEDS[commandId];
    if (!entry || !recommendation || typeof recommendation !== 'object') {
        return verdictOf({ needs: entry ? entry.needs : null, recommended: recommendation?.engine ?? null });
    }
    const recommended = recommendation.engine ?? null;
    const gating = Array.isArray(recommendation.gating) ? recommendation.gating : [];
    const hard = gating.length > 0;
    const soft = !hard && recommended === 'ssa';
    // The SSA reads every net; a recommendation of ode means no rule applies.
    if (entry.needs === 'ssa' || (!hard && !soft)) return verdictOf({ needs: entry.needs, recommended });

    const name = label(entry.needs);
    const rec = label(recommended);
    const rule = (hard ? RULES.firing : RULES.population).id;
    const use = entry.instead ? ` Use ${entry.instead}.` : '';
    let verdict = hard || entry.onSoft === 'refuse' ? 'refuse' : 'warn';
    const used = override === entry.needs;
    let message;
    if (verdict === 'refuse' && !used) {
        message = hard
            ? `${commandId} needs the ${name}, but this net has ${gating.join('; ')}: constraints that only exist at a firing instant, which the ${name} does not have, so it would silently model an unconstrained system (${RULES.firing.id}: ${RULES.firing.title}). Nothing ran. The engine recommends the ${rec}.${use}`
            : `${commandId} gives its answer on the ${name}, and the engine recommends the ${rec} for this net${tokensNote(recommendation)}: at counts this small the ${name}'s mean-field answer can mislead, and a ranking can call a knob that matters irrelevant (${RULES.population.id}: ${RULES.population.title}). Nothing ran.${use}`;
    } else {
        // Runs, with the chip: either a soft rule that only warns, or an override that was used.
        verdict = 'warn';
        message = hard
            ? `${name} on a net with ${gating.join('; ')}; the engine recommends ${rec}`
            : `${name} on a net where the engine recommends ${rec}${tokensNote(recommendation)}`;
    }
    return verdictOf({ verdict, needs: entry.needs, recommended, rule, message, overridden: used, ...(entry.instead ? { instead: entry.instead } : {}) });
}

// ---- the person's words ----

// How people name each engine. "differential equation" is the ODE unless it
// is the SDE's "stochastic differential equation".
const NAMES = {
    ode: [/\bodes?\b/gi, /(?<!stochastic )\bdifferential equations?\b/gi, /\bmean[- ]?field\b/gi, /\brate equations?\b/gi],
    sde: [/\bsdes?\b/gi, /\blangevin\b/gi, /\bstochastic differential equations?\b/gi],
    ssa: [/\bssa\b/gi, /\bgillespie\b/gi, /\bstochastic simulations?\b/gi],
};
// A mention only counts when it is not negated just before it: "not the ODE",
// "instead of the ODE", "don't use the ODE" ask for something else.
const NEGATION = /\b(?:not|never|no|without|avoid|instead of|rather than|except|cannot)\b|n't\b/i;

/**
 * Did the person's own words name this engine? The model may pass an
 * engine_override, but a model cannot override on its own initiative: the code
 * counts it only when this is true for the person's message. A mention that is
 * negated just before it ("not the ODE") does not count.
 * @param {string} userText
 * @param {string} engine  'ode', 'sde' or 'ssa'
 * @returns {boolean}
 */
export function overrideAllowed(userText, engine) {
    const patterns = NAMES[String(engine || '').toLowerCase()];
    if (!patterns || typeof userText !== 'string' || !userText) return false;
    for (const re of patterns) {
        for (const m of userText.matchAll(re)) {
            const before = userText.slice(0, m.index).split(/[.!?;\n]/).pop().slice(-24);
            if (!NEGATION.test(before)) return true;
        }
    }
    return false;
}

// ---- once per revision ----

// A cheap, stable key for a net revision: two 32-bit multiplicative passes
// (FNV-1a and a murmur-style multiplier) over the model JSON plus its length. Any edit (a rate, a token, an arc) changes it.
export function modelKey(model) {
    const s = JSON.stringify(model);
    let a = 0x811c9dc5, b = 0x9747b28c;
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        a = Math.imul(a ^ c, 0x01000193) >>> 0;
        b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
    }
    return `${s.length}:${a.toString(36)}${b.toString(36)}`;
}

const MAX_MACRO_DEPTH = 6;
const MAX_MACRO_STEPS = 200;

/** A macro whose steps the guard cannot list for certain. */
class Unreadable extends Error {}

export class EngineGuard {
    /**
     * @param {Object|(() => Object)} registry  the registry whose net is guarded,
     *   or a function returning it (the chat's sandbox is replaced between calls)
     */
    constructor(registry) {
        this._source = registry;
        this._cache = null;
    }

    get registry() {
        return typeof this._source === 'function' ? this._source() : this._source;
    }

    /**
     * sim.recommend for the registry's net, cached per net revision: it runs
     * once however many guarded calls follow, and again after an edit.
     */
    recommendation() {
        const reg = this.registry;
        const key = modelKey(reg.host.getModel());
        if (this._cache && this._cache.key === key) return this._cache.promise;
        const promise = Promise.resolve().then(() => reg.execute('sim.recommend'));
        this._cache = { key, promise };
        promise.catch(() => { if (this._cache && this._cache.promise === promise) this._cache = null; });
        return promise;
    }

    /**
     * Take a sim.recommend result a plan has just run itself, for the net as
     * it is now, so the guard does not run it a second time.
     */
    prime(result) {
        if (!result || typeof result !== 'object' || !result.engine) return;
        this._cache = { key: modelKey(this.registry.host.getModel()), promise: Promise.resolve(result) };
    }

    /**
     * May this call run? A command that is not in the table is 'ok' without a
     * lookup. override is what the caller (the model, a plan) asked for;
     * userText is the person's message, and the override counts only when it
     * names the engine.
     *
     * macro.play is checked through its steps: the macro is read (macro.get,
     * nested macro.play steps expanded), and every step the table guards is
     * held to the same rules against the net's recommendation. One refused
     * step refuses the whole play (nothing runs); otherwise the play carries
     * a warning if any step warns. A macro the guard cannot read to the end
     * (unknown name, plays itself, nests too deep, is too long, rewrites the
     * macro table and then plays one) is refused too: it is not trusted
     * unseen. A guarded step that follows a step that may change the net's
     * arcs, capacities or token counts is refused as well, because the
     * recommendation was made for the net as it is now, not as the earlier
     * step leaves it; the override, when the person's words name the engine,
     * lifts that like any other refusal.
     * @param {string} commandId
     * @param {Object} [args]
     * @param {{override?: string, userText?: string}} [opts]
     * @returns {Promise<Verdict>} checkEngine's verdict, plus overrideIgnored when an override was passed and not honoured
     */
    async check(commandId, args = {}, { override, userText } = {}) {
        const macro = commandId === MACRO_PLAY;
        const entry = macro ? null : engineNeeded(commandId, args);
        if (!macro && (!entry || entry.needs === 'ssa')) return verdictOf({ needs: entry ? entry.needs : null });
        const asked = typeof override === 'string' && override ? override.toLowerCase() : undefined;
        const honoured = asked !== undefined && overrideAllowed(userText, asked) ? asked : undefined;
        let v;
        if (macro) {
            v = await this._checkMacro(args, honoured);
            if (v.verdict === 'ok') return v;
        } else {
            const rec = await this.recommendation();
            v = checkEngine(commandId, rec, { override: honoured, args });
        }
        // (a refusal with no engine behind it, a macro that could not be read, is not one an override would have changed)
        if (asked !== undefined && honoured === undefined && v.needs) {
            v.overrideIgnored = asked;
            if (v.verdict === 'refuse') v.message += ` The engine_override "${asked}" was not applied: the person's own message does not name that engine.`;
        }
        return v;
    }

    /**
     * Every step macro.play would run, in order, nested macros expanded in
     * place: [{command, args, macro, n}] (n: the step's place in its macro).
     * Throws Unreadable when the steps cannot be listed for certain.
     */
    async _expandMacro(name, st, trail) {
        if (trail.includes(name)) throw new Unreadable(`macro "${name}" plays itself (${[...trail, name].join(' → ')})`);
        if (trail.length >= MAX_MACRO_DEPTH) throw new Unreadable(`macros nest more than ${MAX_MACRO_DEPTH} deep (${[...trail, name].join(' → ')})`);
        let steps;
        try {
            steps = await this.registry.execute('macro.get', { name });
        } catch (e) {
            throw new Unreadable(`macro.get "${name}" failed: ${e?.message || e}`);
        }
        if (!Array.isArray(steps)) throw new Unreadable(`macro.get "${name}" did not return a list of steps`);
        for (let i = 0; i < steps.length; i++) {
            const s = steps[i];
            if (!s || typeof s.command !== 'string' || !s.command) throw new Unreadable(`step ${i + 1} of macro "${name}" names no command`);
            const args = s.args && typeof s.args === 'object' ? s.args : {};
            if (s.command === MACRO_PLAY) {
                // The macro table is read once, up front: a play that follows a write to it may not play what was read.
                if (st.macroWrite) throw new Unreadable(`macro "${name}" changes the macro table (macro.define or macro.delete) before playing another macro`);
                await this._expandMacro(typeof args.name === 'string' && args.name ? args.name : 'last', st, [...trail, name]);
                continue;
            }
            if (s.command === 'macro.define' || s.command === 'macro.delete') st.macroWrite = true;
            if (st.steps.length >= MAX_MACRO_STEPS) throw new Unreadable(`it runs more than ${MAX_MACRO_STEPS} steps`);
            st.steps.push({ command: s.command, args, macro: name, n: i + 1 });
        }
    }

    async _checkMacro(args, honoured) {
        const name = typeof args?.name === 'string' && args.name ? args.name : 'last';
        const st = { steps: [], macroWrite: false };
        try {
            await this._expandMacro(name, st, []);
        } catch (e) {
            if (!(e instanceof Unreadable)) throw e;
            return verdictOf({ verdict: 'refuse', message: `macro.play "${name}" cannot be checked against the engine rules, so it is not run: ${e.message}. Nothing ran.` });
        }
        if (!st.steps.some((s) => { const n = engineNeeded(s.command, s.args); return n && n.needs !== 'ssa'; })) return verdictOf();
        const rec = await this.recommendation();
        const known = new Set(this.registry.list().map((c) => c.id));
        const where = (s) => `step ${s.n} of macro "${s.macro}" (${s.command})`;
        let changedBy = null; // the first earlier step that may change what the recommendation is about
        const warns = [];
        for (const s of st.steps) {
            const need = engineNeeded(s.command, s.args);
            if (need && need.needs !== 'ssa') {
                let v = checkEngine(s.command, rec, { override: honoured, args: s.args });
                if (changedBy) {
                    const after = `${where(changedBy)} can change the net before ${s.command} runs`;
                    if (honoured === need.needs) {
                        if (v.verdict === 'ok') v = verdictOf({ verdict: 'warn', needs: need.needs, recommended: rec?.engine ?? null, message: `${label(need.needs)} was asked for, and ${after}: checked against the net as it is now` });
                    } else if (v.verdict !== 'refuse') {
                        v = verdictOf({
                            verdict: 'refuse', needs: need.needs, recommended: rec?.engine ?? null,
                            message: `${s.command} needs the ${label(need.needs)}, and ${after}: the engine's recommendation was made for the net as it is now, not as that step leaves it (${RULES.firing.id}, ${RULES.population.id}). Nothing ran. Run the macro's steps one at a time, so each is checked against the net it will see.`,
                        });
                    }
                }
                if (v.verdict === 'refuse') return { ...v, message: `macro.play "${name}" would run ${where(s)}. ${v.message}` };
                if (v.verdict === 'warn') warns.push({ ...v, message: `${where(s)}: ${v.message}` });
            }
            if (!changedBy && !KEEPS_RECOMMENDATION.has(s.command) && (isEdit(s.command, s.args) || !known.has(s.command))) changedBy = s;
        }
        if (!warns.length) return verdictOf();
        const [first] = warns;
        return verdictOf({
            verdict: 'warn', needs: first.needs, recommended: first.recommended, rule: first.rule,
            message: warns.map((w) => w.message).join('; '), overridden: warns.some((w) => w.overridden),
        });
    }
}

/**
 * What a refusal says to the model, as the tool's error answer. canOverride:
 * the interface the call came through offers an engine_override argument
 * (run_goal, run_command). The plain tools do not, so there the refusal is
 * final and the person has the other doors.
 * @param {{message: string, needs: string|null}} verdict
 * @param {{canOverride?: boolean}} [opts]
 */
export function refusalText(verdict, { canOverride = false } = {}) {
    // No engine behind the refusal (a macro the guard could not read): there is nothing to override.
    if (!verdict.needs) return `refused: ${verdict.message} This is not an engine choice, so engine_override does not apply; if the macro's name or steps are wrong, fix those, or run its steps one at a time.`;
    const name = label(verdict.needs);
    return `refused: ${verdict.message} ` + (canOverride
        ? `If the person explicitly asked for the ${name}, call again with engine_override: "${verdict.needs}"; it is honoured only when their own message names the engine, and the answer then carries a warning chip.`
        : `This tool has no override, so the refusal is final here. If the person explicitly wants the ${name}, they can run it themselves from the classic dialogs in the menus (or the command palette, where there is one); do not retry.`);
}
