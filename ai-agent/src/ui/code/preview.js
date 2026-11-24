// Live preview of web projects in a sandboxed iframe (opaque origin: no access to the Hub or keys).
// Local CSS, scripts, images and ES module imports are inlined (data: URLs), so it works fully offline.
import { html, useState, useEffect, useRef } from '../../../vendor/preact.mjs';
import { Icon } from '../icons.js';
import * as vfs from '../../core/vfs.js';
import { mimeOf } from '../../core/util.js';
import { blobToBase64 } from '../../models/content.js';

const isLocal = (u) => u && !/^(https?:|data:|blob:|mailto:|tel:|#|javascript:|\/\/)/i.test(u);
const b64 = (s) => btoa(unescape(encodeURIComponent(s)));

async function dataUrl(path) {
  const f = await vfs.getFile(path);
  return `data:${mimeOf(path)};base64,${await blobToBase64(f)}`;
}

async function bundleModule(path, seen = new Map()) {
  if (seen.has(path)) return seen.get(path);
  seen.set(path, 'data:text/javascript;base64,'); // cycle guard
  let code = await vfs.readText(path);
  const dir = vfs.dirname(path);
  const specs = new Set();
  code.replace(/(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s*['"]([^'"]+)['"]/g, (_, a, b, c) => { const s = a || b || c; if (s && (s.startsWith('.') || s.startsWith('/'))) specs.add(s); return _; });
  for (const s of specs) {
    const target = s.startsWith('/') ? vfs.normalize(s) : vfs.normalize(s, dir);
    let url;
    try { url = /\.(css|json|png|jpe?g|svg|gif|webp)$/i.test(target) ? await dataUrl(target) : await bundleModule(target, seen); } catch { continue; }
    code = code.split(`'${s}'`).join(`'${url}'`).split(`"${s}"`).join(`"${url}"`);
  }
  const url = 'data:text/javascript;base64,' + b64(code);
  seen.set(path, url);
  return url;
}

const CONSOLE_SHIM = `<script>(function(){var send=function(l,a){try{parent.postMessage({__preview:1,level:l,msg:Array.from(a).map(function(x){try{return typeof x==='string'?x:JSON.stringify(x)}catch(e){return String(x)}}).join(' ')},'*')}catch(e){}};['log','info','warn','error'].forEach(function(l){var o=console[l];console[l]=function(){send(l,arguments);o.apply(console,arguments)}});addEventListener('error',function(e){send('error',[e.message+' ('+(e.lineno||'?')+':'+(e.colno||'?')+')'])});addEventListener('unhandledrejection',function(e){send('error',['Unhandled: '+(e.reason&&e.reason.message||e.reason)])});})();<\/script>`;

export async function buildPreview(htmlPath) {
  const dir = vfs.dirname(htmlPath);
  const doc = new DOMParser().parseFromString(await vfs.readText(htmlPath), 'text/html');
  const resolve = (u) => vfs.normalize(u.split(/[?#]/)[0], dir);
  for (const l of doc.querySelectorAll('link[rel=stylesheet][href]')) {
    const href = l.getAttribute('href'); if (!isLocal(href)) continue;
    try {
      let css = await vfs.readText(resolve(href));
      const cssDir = vfs.dirname(resolve(href));
      for (const m of [...css.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)]) if (isLocal(m[1])) { try { css = css.split(m[0]).join(`url("${await dataUrl(vfs.normalize(m[1], cssDir))}")`); } catch {} }
      const st = doc.createElement('style'); st.textContent = css; l.replaceWith(st);
    } catch {}
  }
  for (const s of doc.querySelectorAll('script[src]')) {
    const src = s.getAttribute('src'); if (!isLocal(src)) continue;
    try {
      if (s.type === 'module') s.setAttribute('src', await bundleModule(resolve(src)));
      else { s.removeAttribute('src'); s.textContent = await vfs.readText(resolve(src)); }
    } catch {}
  }
  for (const s of doc.querySelectorAll('script[type=module]:not([src])')) {
    const tmp = `${dir}/.__inline_${Math.random().toString(36).slice(2)}.mjs`;
    await vfs.write(tmp, s.textContent, { silent: true });
    try { s.textContent = `import '${await bundleModule(tmp)}';`; } finally { await vfs.rm(tmp, { silent: true }).catch(() => {}); }
  }
  for (const el of doc.querySelectorAll('img[src], source[src], audio[src], video[src], link[rel~=icon][href]')) {
    const attr = el.hasAttribute('src') ? 'src' : 'href'; const v = el.getAttribute(attr);
    if (isLocal(v)) { try { el.setAttribute(attr, await dataUrl(resolve(v))); } catch {} }
  }
  for (const a of doc.querySelectorAll('a[href]')) { const v = a.getAttribute('href'); if (isLocal(v) && /\.html?$/.test(v)) a.setAttribute('data-preview-link', resolve(v)); }
  doc.head.insertAdjacentHTML('afterbegin', CONSOLE_SHIM + `<script>document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[data-preview-link]');if(a){e.preventDefault();parent.postMessage({__preview:1,navigate:a.getAttribute('data-preview-link')},'*')}});<\/script>`);
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

export function Preview({ path, onClose, onNavigate }) {
  const [src, setSrc] = useState(null);
  const [err, setErr] = useState(null);
  const [logs, setLogs] = useState([]);
  const [showConsole, setShowConsole] = useState(false);
  const [nonce, setNonce] = useState(0);
  const frame = useRef();
  useEffect(() => {
    let alive = true;
    setLogs([]); setErr(null);
    buildPreview(path).then(s => alive && setSrc(s)).catch(e => alive && setErr(String(e.message || e)));
    return () => { alive = false; };
  }, [path, nonce]);
  // Live reload when project files change.
  useEffect(() => {
    let t;
    const off = vfs.events.on('change', (e) => { if (e.path.startsWith(vfs.dirname(path)) && !e.path.includes('/.__inline_')) { clearTimeout(t); t = setTimeout(() => setNonce(n => n + 1), 400); } });
    return () => { off(); clearTimeout(t); };
  }, [path]);
  useEffect(() => {
    const onMsg = (e) => {
      if (e.source !== frame.current?.contentWindow || !e.data?.__preview) return;
      if (e.data.navigate) onNavigate?.(e.data.navigate);
      else { setLogs(l => [...l.slice(-200), { level: e.data.level, msg: e.data.msg }]); if (e.data.level === 'error') setShowConsole(true); }
    };
    addEventListener('message', onMsg);
    return () => removeEventListener('message', onMsg);
  }, [onNavigate]);
  const errors = logs.filter(l => l.level === 'error').length;
  return html`<div class="preview">
    <div class="preview-bar"><${Icon} name="globe" size=${14} /><span class="grow ellipsis mono">${path}</span>
      <button class=${'ibtn sm' + (showConsole ? ' active' : '')} onClick=${() => setShowConsole(!showConsole)} aria-label="Console"><${Icon} name="terminal" />${errors ? html`<span class="badge" style="background:var(--err)">${errors}</span>` : ''}</button>
      <button class="ibtn sm" onClick=${() => setNonce(n => n + 1)} aria-label="Reload"><${Icon} name="refresh" /></button>
      ${onClose && html`<button class="ibtn sm" onClick=${onClose} aria-label="Close preview"><${Icon} name="x" /></button>`}</div>
    ${err ? html`<div class="empty"><${Icon} name="alert" /><h3>Preview failed</h3><div class="small">${err}</div></div>`
      : src ? html`<iframe ref=${frame} key=${nonce} sandbox="allow-scripts allow-forms allow-modals allow-popups" srcdoc=${src} title="Preview"></iframe>` : html`<div class="center grow"><div class="spinner"></div></div>`}
    ${showConsole && html`<div class="preview-console">${logs.length ? logs.map(l => html`<div class=${l.level === 'error' ? 'e' : l.level === 'warn' ? 'w' : ''}>${l.msg}</div>`) : html`<div class="dim">Console is empty</div>`}</div>`}
  </div>`;
}
