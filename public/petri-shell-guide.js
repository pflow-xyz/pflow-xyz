// petri-shell-guide.js — the two windows that take the place of the old landing page (docs/ide-shell.md section 9):
//
//   examples   the example models, as cards that open a net (with the one recorded question about it) in the IDE
//   connect    how to connect your own Claude (or any MCP client) and drive this page, plus the book, blog, ontology, GitHub
//
// Both are modals of the shell's registry (petri-shell.js ViewRegistry), so the palette ("Open Examples"), the center bar's
// buttons and an MCP `show` of the same name reach them. Neither calls a model: pflow.xyz makes no server-side model calls;
// people bring their own AI and connect it over MCP. No inline handler or style attribute (docs/ide-shell.md section 6).
//
// The cards are the ones scripts/gen-example-cards.mjs writes into index.html's #pf-examples <template> from
// public/examples.json: plain links (/?cid=…#view=…), so they work with the page's scripts off and a card's recorded view
// opens through the same link-open path as a shared link.

import { h } from './petri-shell-views.js';

/** Where a person goes to read more. Order is the order shown. */
export const LINKS = Object.freeze([
    { href: 'https://book.pflow.xyz', title: 'The book', text: 'A worked introduction to Petri nets: the formalism, the solvers, and the models taken apart step by step.' },
    { href: 'https://blog.stackdump.com', title: 'The blog', text: 'Technical notes on Petri nets and the systems built on them.' },
    { href: 'https://ontology.pflow.xyz', title: 'The ontology', text: 'The terms, patterns and definitions behind the models, as open data (CC0) you can browse and query.' },
    { href: 'https://github.com/pflow-xyz/pflow-xyz', title: 'GitHub', text: 'The editor, the engines and the checks you can re-run yourself. MIT.' },
    { href: '/compose.html', title: 'Compose', text: 'Snap parts together into one system and see it in ten categorical views.' },
]);

/** The connector steps. `copy` is the text a Copy button puts on the clipboard. */
export const CONNECT_STEPS = Object.freeze([
    { title: 'Claude (web, desktop, mobile)', text: 'Customize, then Connectors, add a custom connector, and paste the URL. No sign-in is needed to start.', copy: 'https://pflow.xyz/mcp' },
    { title: 'Claude Code', text: 'One command:', copy: 'claude mcp add --transport http pflow https://pflow.xyz/mcp' },
    { title: 'On your own machine, offline', text: 'The same engine as an MCP server, with no account and no network:', copy: 'npx @pflow-xyz/pflow-mcp' },
]);

/** The card grid from the page's #pf-examples template, or null when the page has none (a copy of the shell on another page). */
export function exampleCards(doc = document) {
    const tpl = doc.getElementById('pf-examples');
    if (!tpl?.content) return null;
    const grid = tpl.content.cloneNode(true);
    // The modal covers the page: a plain navigation is the right thing for a card (the new net replaces this one).
    return grid;
}

const examples = {
    type: 'examples', kind: 'modal', level: 'outcome', title: 'Examples',
    summary: () => 'example models that open in the editor, each with one recorded question',
    render(host) {
        const cards = exampleCards();
        host.replaceChildren(
            h('p', { class: 'pf-note', text: 'Each one is a saved net with a content-addressed ID. A card opens the net together with one recorded question about it, computed in your browser; "Open the canvas" opens the net alone.' }),
            cards || h('p', { class: 'pf-empty', text: 'No examples on this page.' }));
    },
};

function copyButton(text) {
    const b = h('button', { class: 'pf-btn', type: 'button', text: 'Copy' });
    b.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
        setTimeout(() => { b.textContent = 'Copy'; }, 1500);
    });
    return b;
}

const connect = {
    type: 'connect', kind: 'modal', level: 'outcome', title: 'Connect your Claude',
    summary: () => 'how to connect your own AI to pflow.xyz over MCP, and where to read more',
    render(host, _payload, ctx) {
        const steps = CONNECT_STEPS.map((s) => h('section', { class: 'pf-group' },
            h('h3', { class: 'pf-h', text: s.title }),
            h('p', { text: s.text }),
            h('div', { class: 'pf-copyrow' }, h('code', { class: 'pf-code', text: s.copy }), copyButton(s.copy))));
        void ctx;
        host.replaceChildren(
            h('p', { text: 'pflow.xyz makes no model calls of its own. You bring your own AI, and it works the engines here over MCP.' }),
            h('h3', { class: 'pf-h', text: 'Connect' }), ...steps,
            h('h3', { class: 'pf-h', text: 'Drive this page' }),
            h('p', { text: 'With the connector added, sign in, open File > Link to Claude in this page, then ask Claude to show you something: "list my pflow tabs, put a coffee-shop net on this one, switch to the math level and walk me through its invariants." It can open panels, point at places and transitions, and narrate a tour; you stay in control of the level of detail.' }),
            h('p', {}, h('a', { class: 'pf-btn', href: '/mcp.html', text: 'Full connector instructions and tool list' })),
            h('h3', { class: 'pf-h', text: 'Read more' }),
            h('ul', { class: 'pf-list' }, LINKS.map((l) => h('li', {}, h('a', { href: l.href, text: l.title }), ` — ${l.text}`))));
    },
};

export const GUIDE_VIEWS = [examples, connect];

export function registerGuide(registry) {
    for (const v of GUIDE_VIEWS) registry.register(v);
    return registry;
}
