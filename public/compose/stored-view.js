// A view stored as a file instead of drawn by a module: an image, a video, an html
// page, text, JSON or anything else to fetch. Its registry entry (views-meta.js) says
// the rest. It is a picture of something, not the registry's answer about the
// composition on screen, and the view says so every time it is drawn.

const here = (src) => new URL(src, import.meta.url).href;

/** The view for a stored entry: the same shape a module's default export has. */
export function storedView(entry) {
  const url = here(entry.src);
  let text = null; // a text or JSON file, once fetched
  const show = {
    image: (ctx) => ctx.el('img', { class: 'stored', src: url, alt: entry.alt || entry.title }),
    video: (ctx) => ctx.el('video', { class: 'stored', src: url, controls: true, 'aria-label': entry.alt || entry.title }),
    // No allow-same-origin: what is inside cannot reach this page.
    html: (ctx) => ctx.el('iframe', { class: 'stored', src: url, title: entry.title, sandbox: 'allow-scripts' }),
    file: (ctx) => ctx.el('p', {}, ctx.el('a', { href: url, target: '_blank', rel: 'noopener' }, `Open ${entry.src}`)),
    text: (ctx) => shown(ctx, (t) => t),
    json: (ctx) => shown(ctx, (t) => JSON.stringify(JSON.parse(t), null, 2)),
  };
  function shown(ctx, format) {
    const pre = ctx.el('pre', { class: 'stored-text' }, 'Loading…');
    const put = () => {
      try { pre.textContent = format(text); } catch (e) { fail(ctx, pre, e); }
    };
    if (text !== null) put();
    else fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }).then((t) => { text = t; put(); }).catch((e) => fail(ctx, pre, e));
    return pre;
  }
  return {
    id: entry.id, title: entry.title, short: entry.short, consumes: entry.consumes, source: entry.source, convention: entry.convention,
    stored: true,
    render(ctx) {
      ctx.note(`A stored file, not drawn by the registry: it does not change with the links, instances or plan on this page. Source: ${entry.source}`);
      if (entry.examples && !entry.examples.includes(ctx.example)) ctx.note(`This file is about ${entry.examples.join(' and ')}, not the example selected.`, 'na');
      ctx.root.append(show[entry.kind](ctx));
    },
  };
}

function fail(ctx, pre, e) {
  pre.replaceWith(ctx.el('div', { class: 'stage-note warn' }, `Could not read the stored file: ${e.message || e}`));
}
