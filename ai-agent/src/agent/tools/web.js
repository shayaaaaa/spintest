// WebSearch / WebFetch. Uses r.jina.ai / s.jina.ai readers (CORS-friendly), the user's proxy, or (when the active
// model is a cloud model with native search) defers to the model's own search tool.
import { settings } from '../../core/settings.js';
import { proxiedFetch, isOnline, friendlyNetError } from '../../core/net.js';
import { clip } from '../../core/util.js';

function webMode() { return settings.get().web?.mode || 'auto'; }

async function readerFetch(url, signal) {
  const mode = webMode();
  if (mode === 'off') throw new Error('Web access is turned off in Settings → Web.');
  if (!isOnline()) throw new Error("You're offline, so web pages can't be fetched.");
  if (mode === 'proxy' && settings.get().web?.proxyUrl) {
    const r = await proxiedFetch(url, { signal }, { forceProxy: true });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return htmlToText(await r.text(), url);
  }
  // Direct fetch works for CORS-enabled pages; otherwise use the reader service.
  try {
    const r = await fetch(url, { signal, mode: 'cors' });
    if (r.ok) { const t = r.headers.get('content-type') || ''; const body = await r.text(); return /html/.test(t) ? htmlToText(body, url) : body; }
  } catch { /* fall through */ }
  if (settings.get().web?.allowReader === false) throw new Error('This site blocks direct access and the reader service is disabled in Settings → Web.');
  const r = await fetch('https://r.jina.ai/' + url, { signal, headers: { 'X-Return-Format': 'markdown', Accept: 'text/plain' } });
  if (!r.ok) throw new Error(`Reader service: HTTP ${r.status}`);
  return r.text();
}

export function htmlToText(html, base) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,svg,iframe,nav,footer,header,form').forEach(e => e.remove());
  const title = doc.querySelector('title')?.textContent?.trim();
  const out = [];
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) { const t = c.textContent.replace(/\s+/g, ' '); if (t.trim()) out.push(t); continue; }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName.toLowerCase();
      if (/^h[1-6]$/.test(tag)) { out.push('\n\n' + '#'.repeat(Number(tag[1])) + ' '); walk(c); out.push('\n\n'); }
      else if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') { out.push('\n\n'); walk(c); out.push('\n\n'); }
      else if (tag === 'br') out.push('\n');
      else if (tag === 'li') { out.push('\n- '); walk(c); }
      else if (tag === 'a') { const href = c.getAttribute('href'); const txt = c.textContent.trim(); if (href && txt && !href.startsWith('#')) { try { out.push(`[${txt}](${new URL(href, base).href})`); } catch { out.push(txt); } } else walk(c); }
      else if (tag === 'pre' || tag === 'code') out.push('`' + c.textContent + '`');
      else walk(c);
    }
  };
  walk(doc.body || doc);
  return (title ? `# ${title}\n\n` : '') + out.join('').replace(/\n{3,}/g, '\n\n').trim();
}

export const WebFetch = {
  name: 'WebFetch',
  description: 'Fetch a web page or file URL and return its content as markdown/text (online only). Use for reading documentation, articles and search results.',
  input_schema: { type: 'object', properties: { url: { type: 'string' }, prompt: { type: 'string', description: 'What to look for in the page (optional)' } }, required: ['url'] },
  readOnly: true, kind: 'network',
  key: (i) => { try { return 'domain:' + new URL(i.url).hostname; } catch { return i.url; } },
  summary: (i) => i.url,
  async run({ url, prompt }, ctx) {
    if (!/^https?:\/\//.test(url)) url = 'https://' + url;
    let text;
    try { text = await readerFetch(url, ctx.signal); } catch (e) { throw new Error(friendlyNetError(e, url)); }
    const body = clip(text, 40000);
    return { content: (prompt ? `Requested focus: ${prompt}\n\n` : '') + `Content of ${url}:\n\n${body}`, display: { kind: 'web', url, chars: text.length } };
  },
};

export const WebSearch = {
  name: 'WebSearch',
  description: 'Search the web (online only). Returns titles, URLs and snippets. Then use WebFetch to read the best results.',
  input_schema: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'number' } }, required: ['query'] },
  readOnly: true, kind: 'network',
  summary: (i) => `"${i.query}"`,
  async run({ query, max_results = 8 }, ctx) {
    const mode = webMode();
    if (mode === 'off') throw new Error('Web access is turned off in Settings → Web.');
    if (!isOnline()) throw new Error("You're offline, so the web can't be searched. Answer from what you know and say it may be out of date.");
    let results = [];
    try {
      const r = await fetch('https://s.jina.ai/?q=' + encodeURIComponent(query), { signal: ctx.signal, headers: { Accept: 'application/json', 'X-Respond-With': 'no-content' } });
      if (r.ok) {
        const j = await r.json().catch(() => null);
        results = (j?.data || []).map(d => ({ title: d.title, url: d.url, snippet: d.description || d.content?.slice(0, 300) || '' }));
      }
    } catch {}
    if (!results.length) {
      // Fallback: DuckDuckGo HTML results through the reader.
      try {
        const md = await readerFetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), ctx.signal);
        const re = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g; let m;
        while ((m = re.exec(md)) && results.length < max_results) {
          let u = m[2];
          const real = /uddg=([^&]+)/.exec(u); if (real) u = decodeURIComponent(real[1]);
          if (/duckduckgo\.com/.test(u)) continue;
          if (!results.some(x => x.url === u)) results.push({ title: m[1], url: u, snippet: '' });
        }
      } catch (e) { throw new Error(friendlyNetError(e, 'the search service')); }
    }
    results = results.slice(0, max_results);
    if (!results.length) return { content: 'No results.', display: { kind: 'count', n: 0, noun: 'result' } };
    return {
      content: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n'),
      display: { kind: 'search', results },
    };
  },
};
