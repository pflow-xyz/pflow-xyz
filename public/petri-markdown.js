// petri-markdown.js — the Assistant's replies as HTML, no dependencies.
//
// Gemini answers in Markdown (**Plan**, `code`, lists). This renders the
// small subset it uses: headings, paragraphs, bold, italic, inline code,
// fenced code, bullet and numbered lists, and http(s) links. Everything is
// escaped first, so a reply can never inject markup; only the tags emitted
// here reach the page.

function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function inline(text) {
    const codes = [];
    // inline code first, so its contents are not read as emphasis
    let t = esc(text).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    t = t.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    t = t.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>').replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\s][^*\n]*?)\*(?![*\w])/g, '$1<em>$2</em>');
    return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[+i]}</code>`);
}

/** Markdown text as safe HTML. */
export function renderMarkdown(src) {
    const lines = String(src ?? '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let para = [], list = null, fence = null;
    const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
    const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
    for (const line of lines) {
        if (fence) {
            if (/^```/.test(line)) { out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`); fence = null; } else fence.push(line);
            continue;
        }
        if (/^```/.test(line)) { flushPara(); flushList(); fence = []; continue; }
        const h = /^(#{1,4})\s+(.*)$/.exec(line);
        const li = /^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/.exec(line);
        if (h) { flushPara(); flushList(); out.push(`<h4>${inline(h[2])}</h4>`); continue; }
        if (li) {
            flushPara();
            const tag = li[1] ? 'ul' : 'ol';
            if (list && list.tag !== tag) flushList();
            (list ||= { tag, items: [] }).items.push(li[3]);
            continue;
        }
        if (!line.trim()) { flushPara(); flushList(); continue; }
        flushList();
        para.push(line);
    }
    if (fence) out.push(`<pre><code>${esc(fence.join('\n'))}</code></pre>`);
    flushPara();
    flushList();
    return out.join('');
}
