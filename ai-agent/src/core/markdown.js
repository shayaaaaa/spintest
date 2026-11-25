// Markdown -> sanitized HTML with syntax highlighting, copyable code blocks and KaTeX math (lazy-loaded).
import { Marked, hljs, DOMPurify } from '../../vendor/markdown.mjs';
import { escapeHtml } from './util.js';

let katex = null, katexLoading = null;
const katexWaiters = new Set();
export function loadKatex() {
  if (katex || katexLoading) return katexLoading;
  katexLoading = import('../../vendor/katex.mjs').then(m => {
    katex = m.default;
    if (!document.querySelector('link[data-katex]')) {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = new URL('../../vendor/katex/katex.min.css', import.meta.url).href; l.dataset.katex = '1';
      document.head.appendChild(l);
    }
    for (const fn of katexWaiters) fn();
    katexWaiters.clear();
  }).catch(() => {});
  return katexLoading;
}
export const onKatex = (fn) => { if (katex) fn(); else { katexWaiters.add(fn); loadKatex(); } };
export const katexReady = () => !!katex;

function renderMath(tex, display) {
  if (!katex) return `<code class="math-pending">${escapeHtml(tex)}</code>`;
  try { return katex.renderToString(tex, { displayMode: display, throwOnError: false, output: 'html' }); }
  catch { return `<code>${escapeHtml(tex)}</code>`; }
}

const mathBlock = {
  name: 'mathBlock', level: 'block',
  start(src) { const i = src.search(/\$\$|\\\[/); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^\$\$([\s\S]+?)\$\$/.exec(src) || /^\\\[([\s\S]+?)\\\]/.exec(src);
    if (m) return { type: 'mathBlock', raw: m[0], text: m[1].trim() };
  },
  renderer(t) { return `<div class="math-block">${renderMath(t.text, true)}</div>`; },
};
const mathInline = {
  name: 'mathInline', level: 'inline',
  start(src) { const i = src.search(/\$[^\s$]|\\\(/); return i < 0 ? undefined : i; },
  tokenizer(src) {
    const m = /^\$(?!\s)([^$\n]+?)(?<!\s)\$(?!\d)/.exec(src) || /^\\\(([\s\S]+?)\\\)/.exec(src);
    if (m) return { type: 'mathInline', raw: m[0], text: m[1] };
  },
  renderer(t) { return renderMath(t.text, false); },
};

const COPY_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>';

const marked = new Marked({
  gfm: true, breaks: false,
  extensions: [mathBlock, mathInline],
  renderer: {
    code({ text, lang }) {
      const l = (lang || '').trim().split(/\s+/)[0];
      let body;
      try { body = l && hljs.getLanguage(l) ? hljs.highlight(text, { language: l, ignoreIllegals: true }).value : (text.length < 20000 ? hljs.highlightAuto(text).value : escapeHtml(text)); }
      catch { body = escapeHtml(text); }
      return `<div class="codeblock"><div class="codeblock-head"><span class="grow">${escapeHtml(l || 'text')}</span><button class="ibtn sm" data-copy title="Copy">${COPY_SVG}</button></div><pre><code class="hljs">${body}</code></pre></div>`;
    },
    link({ href, title, tokens }) {
      const text = this.parser.parseInline(tokens);
      const safe = /^(https?:|mailto:|#|\.|\/)/i.test(href || '') ? href : '#';
      return `<a href="${escapeHtml(safe)}"${title ? ` title="${escapeHtml(title)}"` : ''} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

const purifyCfg = { ADD_ATTR: ['target', 'data-copy', 'aria-hidden'], ADD_TAGS: ['semantics', 'annotation'], FORBID_TAGS: ['style', 'form', 'input', 'button:not([data-copy])'] };

export function renderMarkdown(src) {
  src = String(src ?? '');
  if (!katex && /\$\$|\\\[|\\\(|\$[^\s$][^$\n]*\$/.test(src)) loadKatex();
  let out;
  try { out = marked.parse(src); } catch { out = `<pre>${escapeHtml(src)}</pre>`; }
  return DOMPurify.sanitize(out, { ...purifyCfg, FORBID_TAGS: ['style', 'form'] });
}

export function highlight(code, lang) {
  try { return lang && hljs.getLanguage(lang) ? hljs.highlight(code, { language: lang, ignoreIllegals: true }).value : escapeHtml(code); }
  catch { return escapeHtml(code); }
}

// Copy buttons inside rendered markdown (event delegation).
export function handleMarkdownClick(e) {
  const btn = e.target.closest?.('[data-copy]');
  if (!btn) return;
  const code = btn.closest('.codeblock')?.querySelector('code')?.innerText ?? '';
  navigator.clipboard?.writeText(code).then(() => {
    btn.classList.add('active');
    setTimeout(() => btn.classList.remove('active'), 1200);
  }).catch(() => {});
}
