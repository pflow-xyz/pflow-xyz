// Small DOM helpers: no framework.

const SVGNS = 'http://www.w3.org/2000/svg';

function apply(node, attrs) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.setAttribute('class', v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sv === null || sv === undefined) continue;
        if (sk.startsWith('--')) node.style.setProperty(sk, sv); else node.style[sk] = sv;
      }
    }
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
}

/** svg('rect', {x: 0, ...}, ...children) */
export function svg(tag, attrs, ...children) {
  const n = document.createElementNS(SVGNS, tag);
  apply(n, attrs);
  append(n, children);
  return n;
}

/** el('div', {class: 'x'}, ...children) */
export function el(tag, attrs, ...children) {
  const n = document.createElement(tag);
  apply(n, attrs);
  append(n, children);
  return n;
}

/** A sized root <svg> with a viewBox; it scales to the stage width. */
export function svgRoot(width, height, attrs = {}) {
  return svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'view-svg', 'font-family': 'var(--font-sans)', ...attrs });
}

/** Text width estimate for layout (SVG text is not measured before insertion). */
export function textWidth(s, size = 12) {
  return String(s).length * size * 0.58;
}

/** A cubic path between two points, bending along the given axis. */
export function curve(x1, y1, x2, y2, axis = 'x') {
  if (axis === 'x') {
    const mx = (x1 + x2) / 2;
    return `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
  }
  const my = (y1 + y2) / 2;
  return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
}

export function escapeXml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
