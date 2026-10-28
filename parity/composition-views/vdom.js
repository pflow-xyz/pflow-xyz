// A minimal DOM for running the composition views headless (the parity test).
//
// The views draw with document.createElement(NS) and friends; this document
// builds a plain node tree instead (the "draw list"), with no layout and no
// events. That is enough for a view's render(ctx) to run to the end, collecting
// its scene manifest as it draws (public/compose/manifest.js). Nothing here
// decides anything a view draws: geometry queries answer zero.

class ClassList {
  constructor(el) { this.el = el; }
  _get() { return (this.el.getAttribute('class') || '').split(/\s+/).filter(Boolean); }
  _set(a) { this.el.setAttribute('class', a.join(' ')); }
  add(...c) { const a = this._get(); for (const x of c) if (!a.includes(x)) a.push(x); this._set(a); }
  remove(...c) { this._set(this._get().filter((x) => !c.includes(x))); }
  toggle(c, force) { const has = this.contains(c); const want = force === undefined ? !has : !!force; if (want) this.add(c); else this.remove(c); return want; }
  contains(c) { return this._get().includes(c); }
}

class Style {
  constructor() { this._p = {}; }
  setProperty(k, v) { this._p[k] = String(v); }
  removeProperty(k) { delete this._p[k]; }
  getPropertyValue(k) { return this._p[k] ?? ''; }
}

class Node {
  constructor(doc) { this.ownerDocument = doc; this.parentNode = null; this.childNodes = []; }
  get children() { return this.childNodes.filter((c) => c instanceof Element); }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get lastElementChild() { const c = this.children; return c[c.length - 1] || null; }
  get parentElement() { return this.parentNode instanceof Element ? this.parentNode : null; }
  get nextSibling() { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return p.childNodes[i + 1] || null; }
  get previousSibling() { const p = this.parentNode; if (!p) return null; const i = p.childNodes.indexOf(this); return p.childNodes[i - 1] || null; }
  get nextElementSibling() { let n = this.nextSibling; while (n && !(n instanceof Element)) n = n.nextSibling; return n; }
  _adopt(n) {
    if (typeof n === "string" || typeof n === "number" || n === null || n === undefined) n = this.ownerDocument.createTextNode(String(n));
    if (n instanceof Fragment) return [...n.childNodes].map((c) => { n.childNodes = []; c.parentNode = null; return c; });
    if (n.parentNode) n.remove();
    return [n];
  }
  appendChild(n) { for (const c of this._adopt(n)) { c.parentNode = this; this.childNodes.push(c); } return n; }
  append(...ns) { for (const n of ns) this.appendChild(n); }
  prepend(...ns) { const add = ns.flatMap((n) => this._adopt(n)); for (const c of add) c.parentNode = this; this.childNodes.unshift(...add); }
  insertBefore(n, ref) {
    if (!ref) return this.appendChild(n);
    const add = this._adopt(n);
    const i = this.childNodes.indexOf(ref);
    for (const c of add) c.parentNode = this;
    this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, ...add);
    return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  replaceChildren(...ns) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this.append(...ns); }
  replaceWith(...ns) { const p = this.parentNode; if (!p) return; const i = p.childNodes.indexOf(this); const add = ns.flatMap((n) => p._adopt(n)); for (const c of add) c.parentNode = p; p.childNodes.splice(i, 1, ...add); this.parentNode = null; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  after(...ns) { const p = this.parentNode; if (!p) return; const i = p.childNodes.indexOf(this); const add = ns.flatMap((n) => p._adopt(n)); for (const c of add) c.parentNode = p; p.childNodes.splice(i + 1, 0, ...add); }
  before(...ns) { const p = this.parentNode; if (!p) return; const i = p.childNodes.indexOf(this); const add = ns.flatMap((n) => p._adopt(n)); for (const c of add) c.parentNode = p; p.childNodes.splice(i, 0, ...add); }
  contains(n) { while (n) { if (n === this) return true; n = n.parentNode; } return false; }
  get textContent() { return this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { this.replaceChildren(); if (v !== '' && v != null) this.appendChild(this.ownerDocument.createTextNode(String(v))); }
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return true; }
}

class Text extends Node {
  constructor(doc, t) { super(doc); this.data = t; this.nodeType = 3; }
  get textContent() { return this.data; }
  set textContent(v) { this.data = String(v); }
  cloneNode() { return new Text(this.ownerDocument, this.data); }
}

class Fragment extends Node {}

const MATCH = (el, sel) => {
  sel = sel.trim();
  if (sel.startsWith(':scope >')) sel = sel.slice(8).trim();
  return sel.split(',').some((one) => {
    const s = one.trim();
    const m = s.match(/^([a-zA-Z][\w-]*)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
    if (!m) return false;
    if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
    for (const part of m[2].match(/[.#][\w-]+|\[[^\]]+\]/g) || []) {
      if (part[0] === '.' && !el.classList.contains(part.slice(1))) return false;
      if (part[0] === '#' && el.getAttribute('id') !== part.slice(1)) return false;
      if (part[0] === '[') {
        const [k, v] = part.slice(1, -1).split('=');
        if (!el.hasAttribute(k)) return false;
        if (v !== undefined && el.getAttribute(k) !== v.replace(/^["']|["']$/g, '')) return false;
      }
    }
    return true;
  });
};

class Element extends Node {
  constructor(doc, tag, ns) {
    super(doc);
    this.tagName = tag;
    this.localName = tag;
    this.namespaceURI = ns || null;
    this.nodeType = 1;
    this.attrs = new Map();
    this.classList = new ClassList(this);
    this.style = new Style();
    const self = this;
    this.dataset = new Proxy({}, {
      get: (_, k) => self.getAttribute(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`) ?? undefined,
      set: (_, k, v) => { self.setAttribute(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(v)); return true; },
      deleteProperty: (_, k) => { self.removeAttribute(`data-${String(k).replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`); return true; },
    });
    this.scrollLeft = 0; this.scrollTop = 0;
  }
  setAttribute(k, v) { this.attrs.set(k, String(v)); }
  setAttributeNS(_, k, v) { this.setAttribute(k, v); }
  getAttribute(k) { return this.attrs.has(k) ? this.attrs.get(k) : null; }
  hasAttribute(k) { return this.attrs.has(k); }
  removeAttribute(k) { this.attrs.delete(k); }
  get id() { return this.getAttribute('id') || ''; }
  set id(v) { this.setAttribute('id', v); }
  get className() { return this.getAttribute('class') || ''; }
  set className(v) { this.setAttribute('class', v); }
  set innerHTML(v) { this.replaceChildren(); this._html = String(v); }
  get innerHTML() { return this._html || ''; }
  get offsetWidth() { return 0; }
  get offsetHeight() { return 0; }
  get clientWidth() { return 0; }
  get clientHeight() { return 0; }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  getBBox() { return { x: 0, y: 0, width: 0, height: 0 }; }
  getComputedTextLength() { return 0; }
  getTotalLength() { return 0; }
  getPointAtLength() { return { x: 0, y: 0 }; }
  getScreenCTM() { return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, inverse() { return this; } }; }
  createSVGPoint() { return { x: 0, y: 0, matrixTransform() { return this; } }; }
  animate() { const a = { finished: Promise.resolve(), cancel() {}, finish() {}, play() {}, pause() {}, onfinish: null, addEventListener() {} }; return a; }
  beginElement() {}
  focus() {}
  blur() {}
  click() {}
  scrollIntoView() {}
  closest(sel) { let n = this; while (n instanceof Element) { if (MATCH(n, sel)) return n; n = n.parentNode; } return null; }
  matches(sel) { return MATCH(this, sel); }
  querySelectorAll(sel) {
    const direct = sel.trim().startsWith(':scope >');
    const out = [];
    const walk = (n) => { for (const c of n.children) { if (MATCH(c, sel)) out.push(c); if (!direct) walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  getElementsByTagName(t) { return this.querySelectorAll(t); }
  cloneNode(deep) {
    const c = new Element(this.ownerDocument, this.tagName, this.namespaceURI);
    for (const [k, v] of this.attrs) c.attrs.set(k, v);
    if (deep) for (const k of this.childNodes) c.appendChild(k.cloneNode(true));
    return c;
  }
  get outerHTML() { return serialize(this); }
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
export function serialize(n) {
  if (n instanceof Text) return esc(n.data);
  if (!(n instanceof Element)) return n.childNodes.map(serialize).join('');
  const a = [...n.attrs].map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  return `<${n.tagName}${a}>${n._html || ''}${n.childNodes.map(serialize).join('')}</${n.tagName}>`;
}

export class Document extends Node {
  constructor() {
    super(null);
    this.ownerDocument = this;
    this.documentElement = new Element(this, 'html');
    this.head = new Element(this, 'head');
    this.body = new Element(this, 'body');
    this.documentElement.append(this.head, this.body);
    this.childNodes = [this.documentElement];
  }
  createElement(t) { return new Element(this, t, 'http://www.w3.org/1999/xhtml'); }
  createElementNS(ns, t) { return new Element(this, t, ns); }
  createTextNode(t) { return new Text(this, t); }
  createDocumentFragment() { return new Fragment(this); }
  querySelectorAll(sel) { return this.documentElement.querySelectorAll(sel); }
  querySelector(sel) { return this.documentElement.querySelector(sel); }
  getElementById(id) { return this.querySelector(`#${id}`); }
}

/** Install a fresh document (and the few window globals the views touch) on globalThis. */
export function installDom() {
  const doc = new Document();
  globalThis.document = doc;
  globalThis.window ??= globalThis;
  globalThis.getComputedStyle ??= () => ({ getPropertyValue: () => '' });
  globalThis.requestAnimationFrame ??= (f) => setTimeout(() => f(0), 0);
  globalThis.matchMedia ??= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  if (typeof globalThis.location === 'undefined') globalThis.location = { hash: '', href: 'http://localhost/compose.html', search: '' };
  globalThis.history ??= { replaceState() {} };
  return doc;
}
