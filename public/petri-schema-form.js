// petri-schema-form.js — a form for any command's arguments, generated from its
// JSON Schema, and the same form for a goal's declared inputs. No model, no
// network. The command palette (petri-palette-ui.js) is the first caller: Enter
// on a command opens the form this module lays out, Run reads it back and the
// registry runs the command, so "the UI can do what the MCP connector can do"
// (docs/design/agent-first-analysis.md, section 8).
//
// The module has four layers, so the logic stays testable without a DOM:
//
//   formModel(schema, defaults) / goalFormModel(goal)   the schema (or a goal's
//       inputs) as a list of fields; plain data
//   renderFormHtml(model, {esc, places, transitions})   the markup; a string
//   readValues(model, raw)                              raw control values ->
//       {args, errors}; pure, this is where parsing and range checks live
//   readForm(root, model)                               collect the raw values
//       from the rendered controls (data-field attributes) and call readValues
//
// Field kinds:
//   number / integer / boolean / string   a scalar of that JSON type
//   enum                                  a schema "enum": a <select>
//   place / transition                    a string the net's own ids fill in.
//       Inferred from the argument's name and description ("place id",
//       "transition whose rate is scanned", `observable`), never from a word
//       list of the net. formModel does not know the net; renderFormHtml draws
//       a <select> of the offered ids, or a plain text box when none are
//       offered, so the kind is the same either way.
//   marking                               {place: count}: a grid of numbers
//       when the places are offered, JSON text otherwise (goal inputs only)
//   json                                  everything else, typed as text and
//       parsed: objects, arrays, unions such as "integer or array" (the
//       per-colour count), and arguments the schema leaves untyped. A bare
//       word is kept as a string where the schema allows a string; a list of
//       strings also accepts "a, b, c".
//
// A field is {name, label, kind, required, default?, min?, max?, enum?, help?}
// plus the few extras the markup needs: types (the schema's own, for json),
// itemType (for an array), multiline (a string that is text, not an id) and
// example (a goal input's example, shown as the placeholder).
//
// What the form cannot lay out becomes an explicit reason (noFormReason), never
// a silently empty form: the palette's rule is "every command has a form or
// says why not".

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const SCALARS = new Set(['number', 'integer', 'boolean', 'string']);

const escHtml = (s) => String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function typeOf(v) {
    if (v === null) return 'null';
    if (Array.isArray(v)) return 'array';
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
    return typeof v;
}

// A value of type `t` satisfies a schema type `want` (an integer is a number).
const fits = (t, want) => t === want || (t === 'integer' && want === 'number');

// Put a value on an args object without letting a name like "__proto__" reach the prototype.
function put(o, k, v) {
    Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

// ---------------------------------------------------------------------------
// Can a form be made?
// ---------------------------------------------------------------------------

/**
 * Why a form cannot be made for this arguments schema, or null when one can.
 * A schema that is an object of named properties always can: an argument whose
 * own schema is exotic (a union, a nested object, nothing at all) is a JSON
 * field. What it cannot lay out is a schema that is not that shape.
 * @param {*} schema a command's `args`
 * @returns {string|null}
 */
export function noFormReason(schema) {
    if (!isObj(schema)) return 'the command declares no argument schema';
    if (schema.type !== undefined && schema.type !== 'object') {
        return `its arguments are declared as ${JSON.stringify(schema.type)}, not an object of named arguments`;
    }
    for (const k of ['$ref', 'oneOf', 'anyOf', 'allOf', 'not']) {
        if (schema[k] !== undefined) return `its arguments use "${k}", which a form cannot lay out`;
    }
    const props = schema.properties;
    if (props !== undefined && !isObj(props)) return 'its list of arguments is not an object of named arguments';
    if (schema.required !== undefined && !Array.isArray(schema.required)) return 'its "required" list is malformed';
    for (const [k, p] of Object.entries(props || {})) {
        if (!isObj(p) && typeof p !== 'boolean') return `argument "${k}" has a malformed schema`;
    }
    for (const r of schema.required || []) {
        if (!props || !own(props, r)) return `required argument "${r}" is not declared in its properties`;
    }
    return null;
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

// "place id", "the place that gets more tokens", "transition whose rate is
// scanned", "place; default: ..." -> place / transition. "transition role, or
// transition-id prefix" is a role name, not an id, and stays a string; so does
// "place or transition id" (it is either).
const ID_WORDS = /^(?:the |a )?(place|transition)(?: id)?(?:$|\s*[;,(]|\s+(?:whose|observed|on|that|swept|scanned)\b)/;

function idKind(name, description) {
    const m = ID_WORDS.exec(String(description || '').trim().toLowerCase());
    if (m) return m[1];
    if (name === 'place' || name === 'observable') return 'place';
    if (name === 'transition') return 'transition';
    return null;
}

// Strings that are text to write or paste, not an id or a name.
const TEXT_ARGS = new Set(['content', 'text']);

function fieldOf(name, ps, required, defaults) {
    const s = isObj(ps) ? ps : {};
    const types = [].concat(s.type ?? []);
    const kinds = types.filter((t) => t !== 'null');
    const choices = Array.isArray(s.enum) && s.enum.length ? s.enum : null;
    let kind;
    if (choices) kind = 'enum';
    else if (kinds.length === 1 && SCALARS.has(kinds[0])) kind = kinds[0] === 'string' ? (idKind(name, s.description) || 'string') : kinds[0];
    else kind = 'json';
    const f = { name, label: typeof s.title === 'string' && s.title ? s.title : name, kind, required };
    const dflt = own(defaults, name) ? defaults[name] : s.default;
    if (dflt !== undefined) f.default = dflt;
    if (kind === 'number' || kind === 'integer') {
        if (typeof s.minimum === 'number') f.min = s.minimum;
        if (typeof s.maximum === 'number') f.max = s.maximum;
    }
    if (choices) f.enum = [...choices];
    if (typeof s.description === 'string' && s.description) f.help = s.description;
    if (kind === 'json') {
        f.types = types;
        if (kinds.includes('array') && isObj(s.items) && typeof s.items.type === 'string') f.itemType = s.items.type;
    }
    if (kind === 'string' && TEXT_ARGS.has(name)) f.multiline = true;
    if (typeof s.example === 'string') f.example = s.example;
    return f;
}

/**
 * The fields of a form for a command's arguments schema. Required fields come
 * first (schema order within each half).
 * @param {any} schema a command's `args`
 * @param {any} [defaults] {argument name: value} to prefill
 * @returns {{fields: any[], noForm: string|null}}
 */
export function formModel(schema, defaults = {}) {
    const reason = noFormReason(schema);
    if (reason) return { fields: [], noForm: reason };
    const props = schema.properties || {};
    const need = new Set(schema.required || []);
    const given = isObj(defaults) ? defaults : {};
    const fields = Object.keys(props).map((k) => fieldOf(k, props[k], need.has(k), given));
    return { fields: [...fields.filter((f) => f.required), ...fields.filter((f) => !f.required)], noForm: null };
}

// What a goal input's example says about its type: {"x_": 1} is an object,
// ["x_win_"] a list of strings.
function typesOfExample(example) {
    if (typeof example !== 'string') return { types: [] };
    try {
        const v = JSON.parse(example);
        const t = typeOf(v);
        if (t === 'object') return { types: [t] };
        if (t === 'array') return { types: [t], ...(v.length && v.every((x) => typeof x === 'string') ? { itemType: 'string' } : {}) };
    } catch { /* not JSON: no type to learn */ }
    return { types: [] };
}

const GOAL_KINDS = new Set(['place', 'transition', 'number', 'marking', 'json']);

/**
 * The same model from a goal's declared inputs (public/goals.json: name, kind
 * place | transition | number | marking | json, label, optional, default,
 * example), as petri-goals-ui.js shows them today. An input is required unless
 * it is optional or has a default, which is what runGoal's missingInputs
 * checks. A goal that is not available here has no form and says why.
 * @param {any} goal
 * @returns {{fields: any[], noForm: string|null}}
 */
export function goalFormModel(goal) {
    if (!isObj(goal)) return { fields: [], noForm: 'no goal' };
    if (goal.available === false) return { fields: [], noForm: goal.caveat || 'this question is not available here' };
    const fields = (goal.inputs || []).map((i) => {
        const kind = GOAL_KINDS.has(i.kind) ? i.kind : 'string';
        const f = {
            name: i.name, label: i.label || i.name, kind,
            required: !i.optional && i.default === undefined,
        };
        if (i.default !== undefined) f.default = i.default;
        if (i.help) f.help = i.help;
        if (typeof i.example === 'string') f.example = i.example;
        if (kind === 'json') Object.assign(f, typesOfExample(i.example));
        return f;
    });
    return { fields, noForm: null };
}

// ---------------------------------------------------------------------------
// Reading values back
// ---------------------------------------------------------------------------

const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

// Blank text, nothing at all, or (a marking grid) every cell blank. A value the caller
// parsed already ({} or []) is a value.
const isEmpty = (f, v) => v === undefined || v === null
    || (typeof v === 'string' && v.trim() === '')
    || (f.kind === 'marking' && isObj(v) && Object.values(v).every((x) => x === undefined || x === null || String(x).trim() === ''));

function parseNumber(f, v) {
    let n;
    if (typeof v === 'number') n = v;
    else {
        const t = String(v).trim();
        if (!NUMBER.test(t)) return { error: `${f.label}: ${f.kind === 'integer' ? 'enter a whole number' : 'enter a number'} (got “${t}”)` };
        n = Number(t);
    }
    if (!Number.isFinite(n)) return { error: `${f.label}: must be a finite number` };
    if (f.kind === 'integer' && !Number.isInteger(n)) return { error: `${f.label}: must be a whole number (got ${n})` };
    if (f.min !== undefined && n < f.min) return { error: `${f.label}: must be at least ${f.min} (got ${n})` };
    if (f.max !== undefined && n > f.max) return { error: `${f.label}: must be at most ${f.max} (got ${n})` };
    return { value: n };
}

function checkItems(f, arr) {
    if (!f.itemType) return null;
    const bad = arr.findIndex((x) => !fits(typeOf(x), f.itemType));
    return bad < 0 ? null : `${f.label}: item ${bad + 1} must be ${f.itemType === 'object' ? 'an object' : `a ${f.itemType}`} (got ${typeOf(arr[bad])})`;
}

function parseJson(f, v) {
    if (typeof v !== 'string') return { value: v }; // a caller that already has the value
    const t = v.trim();
    const types = f.types || [];
    const listOfStrings = types.includes('array') && f.itemType === 'string';
    let value;
    try {
        value = JSON.parse(t);
    } catch (e) {
        if (!/^[[{]/.test(t)) {
            // Not JSON, and not trying to be: a string where the schema allows one, or a plain list.
            if (listOfStrings) return { value: t.split(/[\s,]+/).filter(Boolean) };
            if (!types.length || types.includes('string')) return { value: t };
        }
        return { error: `${f.label}: not valid JSON (${e.message})` };
    }
    if (types.length) {
        const t0 = typeOf(value);
        if (!types.some((want) => fits(t0, want))) {
            const want = types.filter((x) => x !== 'null').join(' or ');
            return { error: `${f.label}: expected ${want}, got ${t0}` };
        }
    }
    if (Array.isArray(value)) {
        const bad = checkItems(f, value);
        if (bad) return { error: bad };
    }
    return { value };
}

function parseMarking(f, v) {
    let m = v;
    if (typeof v === 'string') {
        try {
            m = JSON.parse(v);
        } catch (e) {
            return { error: `${f.label}: not valid JSON (${e.message})` };
        }
        if (!isObj(m)) return { error: `${f.label}: expected {place: count}, got ${typeOf(m)}` };
    }
    const out = {};
    for (const [place, x] of Object.entries(m)) {
        if (x === undefined || x === null || (typeof x === 'string' && x.trim() === '')) continue;
        const count = (c) => (typeof c === 'number' ? c : (/^\d+$/.test(String(c).trim()) ? Number(String(c).trim()) : NaN));
        const bad = () => ({ error: `${f.label}: ${place} needs a whole number of tokens, 0 or more` });
        if (Array.isArray(x)) {
            // a per-colour vector; null leaves a colour free
            if (x.some((c) => c !== null && !(Number.isInteger(c) && c >= 0))) return bad();
            put(out, place, x);
            continue;
        }
        const n = count(x);
        if (!Number.isInteger(n) || n < 0) return bad();
        put(out, place, n);
    }
    return { value: out };
}

function parseOne(f, v) {
    switch (f.kind) {
    case 'number': case 'integer': return parseNumber(f, v);
    case 'enum': {
        const hit = f.enum.find((c) => String(c) === String(v));
        return hit === undefined ? { error: `${f.label}: must be one of ${f.enum.join(', ')}` } : { value: hit };
    }
    case 'json': return parseJson(f, v);
    case 'marking': return parseMarking(f, v);
    default: {
        // string, place, transition: an id or a name is trimmed, text to write is not
        const s = String(v);
        return { value: f.multiline ? s : s.trim() };
    }
    }
}

/**
 * Parse and check raw control values against a model. Numbers are parsed and
 * range-checked against min and max, JSON is parsed with a readable error, an
 * empty optional field is dropped, an empty required one is reported. A
 * checkbox left unticked is dropped (the argument's own default is false)
 * unless the field is required or its default is true.
 * @param {{fields: any[]}} model
 * @param {any} raw {field name: text | boolean | {place: text} (a marking)}
 * @returns {{args: any, errors: {name: string, message: string}[]}}
 */
export function readValues(model, raw = {}) {
    const args = {};
    const errors = [];
    for (const f of model.fields || []) {
        const v = own(raw, f.name) ? raw[f.name] : undefined;
        if (f.kind === 'boolean') {
            const on = v === true || v === 'true';
            if (on) put(args, f.name, true);
            else if (f.required || f.default === true) put(args, f.name, false);
            continue;
        }
        if (isEmpty(f, v)) {
            if (f.required) errors.push({ name: f.name, message: `${f.label}: required` });
            continue;
        }
        const r = parseOne(f, v);
        if (r.error) errors.push({ name: f.name, message: r.error });
        else put(args, f.name, r.value);
    }
    return { args, errors };
}

/**
 * Collect the raw values from a rendered form (the controls renderFormHtml
 * drew carry data-field, and data-mark for one place of a marking grid) and
 * parse them with readValues.
 * @param {{querySelectorAll: Function}} root
 * @param {{fields: any[]}} model
 * @returns {{args: any, errors: {name: string, message: string}[]}}
 */
export function readForm(root, model) {
    const raw = {};
    for (const el of root.querySelectorAll('[data-field]')) {
        const name = el.dataset.field;
        if (el.dataset.mark !== undefined) {
            if (!isObj(raw[name])) raw[name] = {};
            put(raw[name], el.dataset.mark, el.value);
        } else if (el.type === 'checkbox') {
            raw[name] = !!el.checked;
        } else {
            raw[name] = el.value;
        }
    }
    return readValues(model, raw);
}

/**
 * Show readValues' errors beside their fields (and clear the rest): the
 * message goes in the field's data-err-for element, which is a role=alert
 * region, and the control gets aria-invalid.
 * @param {{querySelectorAll: Function}} root
 * @param {{name: string, message: string}[]} errors
 */
export function showFormErrors(root, errors) {
    const by = new Map((errors || []).map((e) => [e.name, e.message]));
    for (const el of root.querySelectorAll('[data-err-for]')) {
        const msg = by.get(el.dataset.errFor);
        el.textContent = msg || '';
        el.hidden = !msg;
    }
    for (const el of root.querySelectorAll('[data-field]')) {
        if (by.has(el.dataset.field)) el.setAttribute('aria-invalid', 'true');
        else el.removeAttribute('aria-invalid');
    }
}

// ---------------------------------------------------------------------------
// Markup
// ---------------------------------------------------------------------------

function jsonHint(f) {
    if (f.example) return f.example;
    const types = f.types || [];
    if (types.includes('array') && (types.includes('integer') || types.includes('number'))) return '3 or [1, 2]';
    if (types.includes('array')) {
        if (f.itemType === 'string') return '["a", "b"]  or  a, b';
        if (f.itemType === 'object') return '[{ … }]';
        return '[ … ]';
    }
    if (types.includes('object') && types.includes('string')) return '{ … }  or the JSON text';
    if (types.includes('object')) return '{ … }';
    return 'JSON value';
}

const shown = (v) => (v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));

function controlHtml(f, id, describedBy, ctx) {
    const { esc, places, transitions } = ctx;
    const common = `id="${id}" data-field="${esc(f.name)}" aria-describedby="${describedBy}"${f.required ? ' aria-required="true"' : ''}`;
    const dflt = shown(f.default);
    const options = (list, blank) => `<option value="">${blank}</option>${list.map((x) => `<option value="${esc(x)}"${String(x) === dflt ? ' selected' : ''}>${esc(x)}</option>`).join('')}`;
    switch (f.kind) {
    case 'boolean':
        return `<input type="checkbox" ${common}${f.default === true ? ' checked' : ''}>`;
    case 'enum':
        return `<select ${common}>${options(f.enum, f.required && f.default === undefined ? '(choose)' : '(default)')}</select>`;
    case 'place': case 'transition': {
        const list = f.kind === 'place' ? places : transitions;
        if (list.length) return `<select ${common}>${options(list, f.required && f.default === undefined ? '(choose)' : '(default)')}</select>`;
        return `<input type="text" ${common} autocomplete="off" spellcheck="false" value="${esc(dflt)}">`;
    }
    case 'number': case 'integer':
        return `<input type="text" inputmode="${f.kind === 'integer' ? 'numeric' : 'decimal'}" ${common} autocomplete="off" spellcheck="false" value="${esc(dflt)}">`;
    case 'json':
        return `<textarea rows="2" ${common} spellcheck="false" autocomplete="off" placeholder="${esc(jsonHint(f))}">${esc(dflt)}</textarea>`;
    default:
        return f.multiline
            ? `<textarea rows="4" ${common} spellcheck="false" autocomplete="off">${esc(dflt)}</textarea>`
            : `<input type="text" ${common} autocomplete="off" spellcheck="false" value="${esc(dflt)}">`;
    }
}

function rangeHint(f) {
    if (f.kind !== 'number' && f.kind !== 'integer') return '';
    const bits = [];
    if (f.min !== undefined) bits.push(`at least ${f.min}`);
    if (f.max !== undefined) bits.push(`at most ${f.max}`);
    return bits.join(', ');
}

function fieldHtml(f, i, ctx) {
    const { esc, places, idPrefix } = ctx;
    const id = `${idPrefix}-${i}`;
    const help = f.help ? esc(f.help) : '';
    const range = rangeHint(f);
    const describedBy = `${id}-help ${id}-err`;
    const star = f.required ? '<span class="pv-form-req" aria-hidden="true"> *</span>' : '';
    const tail = `<div class="pv-form-help" id="${id}-help">${help}${help && range ? ' · ' : ''}${range ? `<span class="pv-form-range">${esc(range)}</span>` : ''}</div>`
        + `<div class="pv-form-err" id="${id}-err" data-err-for="${esc(f.name)}" role="alert" hidden></div>`;
    if (f.kind === 'marking' && places.length) {
        const dflt = isObj(f.default) ? f.default : {};
        const grid = places.map((p) => `<label class="pv-form-mark">${esc(p)} <input type="text" inputmode="numeric" autocomplete="off" data-field="${esc(f.name)}" data-mark="${esc(p)}" value="${esc(shown(dflt[p]))}"></label>`).join(' ');
        return `<fieldset class="pv-form-field pv-form-field-marking" aria-describedby="${describedBy}"><legend class="pv-form-label">${esc(f.label)}${star}</legend><div class="pv-form-grid">${grid}</div>${tail}</fieldset>`;
    }
    const ctl = f.kind === 'marking'
        ? `<textarea rows="2" id="${id}" data-field="${esc(f.name)}" aria-describedby="${describedBy}"${f.required ? ' aria-required="true"' : ''} spellcheck="false" autocomplete="off" placeholder="${esc(f.example || '{"place": 1}')}">${esc(shown(f.default))}</textarea>`
        : controlHtml(f, id, describedBy, ctx);
    const label = `<label class="pv-form-label" for="${id}">${esc(f.label)}${star}</label>`;
    // A checkbox reads best with its label after it; every other control sits under its label.
    const body = f.kind === 'boolean' ? `<div class="pv-form-check">${ctl} ${label}</div>` : `${label}${ctl}`;
    return `<div class="pv-form-field pv-form-field-${f.kind}">${body}${tail}</div>`;
}

/**
 * The form as HTML. Every control has a <label for>, a help line and an error
 * region it is described by (aria-describedby), required controls say so
 * (aria-required and a visible mark), enum / place / transition are selects
 * (place and transition fall back to a text box when the net's ids are not
 * offered), numbers are text inputs with a numeric keypad hint so what was
 * typed is kept and checked by readValues. Optional fields fold into a
 * <details> when there are many.
 * @param {{fields: any[], noForm: string|null}} model
 * @param {{esc?: (s: *) => string, places?: string[], transitions?: string[], idPrefix?: string}} [opts]
 *   idPrefix keeps control ids unique when two forms are on the page
 * @returns {string}
 */
export function renderFormHtml(model, { esc = escHtml, places = [], transitions = [], idPrefix = 'pv-f' } = {}) {
    if (!model || model.noForm) return `<p class="pv-form-noform">${esc(model?.noForm || 'no form')}</p>`;
    const ctx = { esc, places, transitions, idPrefix };
    const rows = model.fields.map((f, i) => ({ f, html: fieldHtml(f, i, ctx) }));
    const req = rows.filter((r) => r.f.required);
    const opt = rows.filter((r) => !r.f.required);
    const key = req.length ? '<p class="pv-form-key"><span class="pv-form-req" aria-hidden="true">*</span> required</p>' : '';
    // Few optional arguments sit in the form; many fold away, closed if something is required.
    if (opt.length <= 4) return key + rows.map((r) => r.html).join('\n');
    const prefilled = opt.some((r) => r.f.default !== undefined);
    return `${key}${req.map((r) => r.html).join('\n')}<details class="pv-form-more"${!req.length || prefilled ? ' open' : ''}><summary>Optional (${opt.length})</summary>${opt.map((r) => r.html).join('\n')}</details>`;
}
