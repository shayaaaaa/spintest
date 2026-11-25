// Shared UI primitives: sheets, menus, toasts, dialogs, markdown, diff, chart, toggles.
import { html, useState, useEffect, useRef, useMemo, useLayoutEffect } from '../../vendor/preact.mjs';
import { createStore, useStore } from '../core/store.js';
import { Icon } from './icons.js';
import { renderMarkdown, handleMarkdownClick, onKatex, katexReady } from '../core/markdown.js';
import { uid, lineDiff, diffHunks, diffStats } from '../core/util.js';

// ---------- overlay stack ----------
export const overlays = createStore({ list: [] });
export function openOverlay(render, opts = {}) {
  const id = uid('ov');
  overlays.set(s => ({ list: [...s.list, { id, render, ...opts }] }));
  return () => closeOverlay(id);
}
export function closeOverlay(id) { overlays.set(s => ({ list: s.list.filter(o => o.id !== id) })); }

export function Overlays() {
  const { list } = useStore(overlays);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && list.length) { const top = list[list.length - 1]; top.onClose?.(); closeOverlay(top.id); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [list]);
  return html`${list.map(o => html`<${OverlayItem} key=${o.id} o=${o} />`)}`;
}
function OverlayItem({ o }) {
  const close = () => { o.onClose?.(); closeOverlay(o.id); };
  return o.render(close);
}

// ---------- Sheet (bottom sheet on phone, centered dialog when unfolded) ----------
export function Sheet({ title, onClose, children, footer, wide, actions, bodyClass = '', noPad }) {
  const ref = useRef();
  const drag = useRef(null);
  const onTouchStart = (e) => { if (ref.current?.querySelector('.sheet-body')?.scrollTop > 0) return; drag.current = { y: e.touches[0].clientY, dy: 0 }; };
  const onTouchMove = (e) => {
    if (!drag.current) return;
    drag.current.dy = Math.max(0, e.touches[0].clientY - drag.current.y);
    if (window.innerWidth < 700 && ref.current) ref.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const onTouchEnd = () => {
    if (!drag.current) return;
    const dy = drag.current.dy; drag.current = null;
    if (ref.current) ref.current.style.transform = '';
    if (dy > 110) onClose?.();
  };
  return html`
    <div class="scrim" onClick=${onClose}></div>
    <div class=${'sheet' + (wide ? ' wide' : '')} ref=${ref} role="dialog" aria-modal="true" aria-label=${title}>
      <div class="sheet-grip" onTouchStart=${onTouchStart} onTouchMove=${onTouchMove} onTouchEnd=${onTouchEnd}></div>
      ${title != null && html`<div class="sheet-head" onTouchStart=${onTouchStart} onTouchMove=${onTouchMove} onTouchEnd=${onTouchEnd}>
        <div class="sheet-title ellipsis">${title}</div>${actions}
        <button class="ibtn sm" onClick=${onClose} aria-label="Close"><${Icon} name="x" /></button>
      </div>`}
      <div class=${'sheet-body ' + bodyClass} style=${noPad ? 'padding:0' : ''}>${children}</div>
      ${footer && html`<div class="sheet-foot">${footer}</div>`}
    </div>`;
}

export function openSheet(props, content) {
  return openOverlay((close) => html`<${Sheet} ...${props} onClose=${close}>${typeof content === 'function' ? content(close) : content}<//>`, { onClose: props.onClose });
}

// ---------- Menu (popover anchored to an element or point) ----------
export function openMenu(anchor, items, { align = 'left', width } = {}) {
  let rect;
  if (anchor?.getBoundingClientRect) rect = anchor.getBoundingClientRect();
  else if (anchor && 'x' in anchor) rect = { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  else rect = { left: innerWidth / 2, right: innerWidth / 2, top: innerHeight / 2, bottom: innerHeight / 2 };
  return openOverlay((close) => html`<${Menu} rect=${rect} items=${items} align=${align} width=${width} close=${close} />`);
}

function Menu({ rect, items, align, width, close }) {
  const ref = useRef();
  const [pos, setPos] = useState({ left: -9999, top: -9999 });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const w = el.offsetWidth, h = el.offsetHeight, pad = 8;
    let left = align === 'right' ? rect.right - w : rect.left;
    left = Math.max(pad, Math.min(left, innerWidth - w - pad));
    let top = rect.bottom + 6;
    if (top + h > innerHeight - pad) top = Math.max(pad, rect.top - h - 6);
    setPos({ left, top });
  }, []);
  return html`
    <div class="scrim" style="background:transparent" onClick=${close}></div>
    <div class="menu" ref=${ref} style=${`left:${pos.left}px;top:${pos.top}px;${width ? `width:${width}px;` : ''}`} role="menu">
      ${items.filter(Boolean).map((it, i) => it === '-' ? html`<div class="menu-sep" key=${i}></div>`
        : it.label && !it.onClick && !it.items ? html`<div class="menu-label" key=${i}>${it.label}</div>`
        : html`<button key=${i} class=${'menu-item' + (it.danger ? ' danger' : '') + (it.selected ? ' sel' : '')} role="menuitem" disabled=${it.disabled}
            onClick=${() => { close(); it.onClick?.(); }}>
            ${it.icon && html`<${Icon} name=${it.icon} />`}
            <span class="grow"><div>${it.text}</div>${it.sub && html`<div class="mi-sub">${it.sub}</div>`}</span>
            ${it.selected && html`<${Icon} name="check" />`}
            ${it.right}
          </button>`)}
    </div>`;
}

// ---------- Toasts ----------
const toastStore = createStore({ list: [] });
export function toast(text, kind = 'info', ms = 3200) {
  const id = uid('t');
  toastStore.set(s => ({ list: [...s.list.slice(-3), { id, text, kind }] }));
  if (ms) setTimeout(() => toastStore.set(s => ({ list: s.list.filter(t => t.id !== id) })), ms);
  return id;
}
export function Toasts() {
  const { list } = useStore(toastStore);
  const icon = { ok: 'checkCircle', err: 'alert', warn: 'alert', info: 'info' };
  return html`<div class="toasts" aria-live="polite">${list.map(t => html`<div key=${t.id} class=${'toast ' + t.kind} onClick=${() => toastStore.set(s => ({ list: s.list.filter(x => x.id !== t.id) }))}><${Icon} name=${icon[t.kind] || 'info'} /><div class="grow">${t.text}</div></div>`)}</div>`;
}

// ---------- Dialogs (promise-based) ----------
export function confirmDialog({ title = 'Are you sure?', message = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    openOverlay((close) => html`<${Sheet} title=${title} onClose=${() => { close(); resolve(false); }}
      footer=${html`<button class="btn" onClick=${() => { close(); resolve(false); }}>${cancel}</button>
        <button class=${'btn ' + (danger ? 'danger solid' : 'primary')} onClick=${() => { close(); resolve(true); }}>${ok}</button>`}>
      <div style="white-space:pre-wrap">${message}</div><//>`, { onClose: () => resolve(false) });
  });
}

export function promptDialog({ title = 'Enter a value', label = '', value = '', placeholder = '', ok = 'OK', multiline = false, mono = false }) {
  return new Promise((resolve) => {
    openOverlay((close) => html`<${PromptBody} title=${title} label=${label} value=${value} placeholder=${placeholder} ok=${ok} multiline=${multiline} mono=${mono}
      done=${(v) => { close(); resolve(v); }} />`, { onClose: () => resolve(null) });
  });
}
function PromptBody({ title, label, value, placeholder, ok, multiline, mono, done }) {
  const [v, setV] = useState(value);
  const ref = useRef();
  useEffect(() => { setTimeout(() => { ref.current?.focus(); ref.current?.select?.(); }, 60); }, []);
  const submit = () => done(v);
  return html`<${Sheet} title=${title} onClose=${() => done(null)}
    footer=${html`<button class="btn" onClick=${() => done(null)}>Cancel</button><button class="btn primary" onClick=${submit}>${ok}</button>`}>
    ${label && html`<div class="label" style="margin-bottom:8px">${label}</div>`}
    ${multiline
      ? html`<textarea ref=${ref} class=${'textarea' + (mono ? ' mono' : '')} rows="8" value=${v} placeholder=${placeholder} onInput=${e => setV(e.target.value)}></textarea>`
      : html`<input ref=${ref} class=${'input' + (mono ? ' mono' : '')} value=${v} placeholder=${placeholder} onInput=${e => setV(e.target.value)} onKeyDown=${e => e.key === 'Enter' && submit()} autocapitalize="off" autocorrect="off" spellcheck="false" />`}
  <//>`;
}

// Multiple-choice question (used by the AskUser tool). Resolves to {answers:{question:label|labels}} or null.
export function choiceDialog({ title = 'Question', questions }) {
  return new Promise((resolve) => {
    openOverlay((close) => html`<${ChoiceBody} title=${title} questions=${questions} done=${(v) => { close(); resolve(v); }} />`, { onClose: () => resolve(null) });
  });
}
function ChoiceBody({ title, questions, done }) {
  const [sel, setSel] = useState({});
  const [other, setOther] = useState({});
  const pick = (q, label) => setSel(s => {
    if (q.multiSelect) { const cur = new Set(s[q.question] || []); cur.has(label) ? cur.delete(label) : cur.add(label); return { ...s, [q.question]: [...cur] }; }
    return { ...s, [q.question]: label };
  });
  const complete = questions.every(q => (q.multiSelect ? (sel[q.question] || []).length : sel[q.question]) || other[q.question]);
  const submit = () => {
    const answers = {};
    for (const q of questions) answers[q.question] = other[q.question] ? (q.multiSelect ? [...(sel[q.question] || []), other[q.question]] : other[q.question]) : sel[q.question];
    done({ answers });
  };
  return html`<${Sheet} title=${title} onClose=${() => done(null)}
    footer=${html`<button class="btn" onClick=${() => done(null)}>Skip</button><button class="btn primary" disabled=${!complete} onClick=${submit}>Submit</button>`}>
    ${questions.map(q => html`<div style="margin-bottom:18px">
      ${q.header && html`<span class="tag accent" style="margin-bottom:6px">${q.header}</span>`}
      <div style="font-weight:650;margin:6px 0 10px">${q.question}</div>
      <div class="list">${(q.options || []).map(o => {
        const on = q.multiSelect ? (sel[q.question] || []).includes(o.label) : sel[q.question] === o.label;
        return html`<button class="li" onClick=${() => pick(q, o.label)}>
          <span class="li-icon" style=${on ? 'background:var(--accent);color:var(--on-accent)' : ''}><${Icon} name=${on ? 'check' : q.multiSelect ? 'square' : 'chevronRight'} /></span>
          <div class="li-main"><div class="li-title" style="white-space:normal">${o.label}</div>${o.description && html`<div class="li-sub" style="white-space:normal">${o.description}</div>`}</div></button>`;
      })}</div>
      <input class="input" style="margin-top:8px" placeholder="Other…" value=${other[q.question] || ''} onInput=${e => setOther(s => ({ ...s, [q.question]: e.target.value }))} />
    </div>`)}
  <//>`;
}

// ---------- Markdown ----------
export function Markdown({ text, class: cls = '' }) {
  const [, force] = useState(0);
  const htmlStr = useMemo(() => renderMarkdown(text), [text, katexReady()]);
  useEffect(() => { if (htmlStr.includes('math-pending')) onKatex(() => force(n => n + 1)); }, [htmlStr]);
  return html`<div class=${'md ' + cls} onClick=${handleMarkdownClick} dangerouslySetInnerHTML=${{ __html: htmlStr }}></div>`;
}

// ---------- Diff ----------
export function DiffView({ before = '', after = '', ctx = 3, maxLines = 400, startLine }) {
  const { hunks, stats } = useMemo(() => {
    const d = lineDiff(before, after);
    return { hunks: diffHunks(d, ctx), stats: diffStats(d) };
  }, [before, after]);
  let shown = 0;
  return html`<div class="diff">${hunks.map((h, i) => html`
    ${i > 0 && html`<div class="diff-gap">⋯</div>`}
    ${h.lines.map(l => {
      if (shown++ > maxLines) return null;
      const cls = l.t === '+' ? 'add' : l.t === '-' ? 'del' : '';
      return html`<div class=${'diff-line ' + cls}><span class="ln">${l.t === '+' ? l.b : l.a}</span><span class="sg">${l.t === ' ' ? '' : l.t}</span><span class="tx">${l.s}</span></div>`;
    })}`)}
    ${shown > maxLines && html`<div class="diff-gap">… ${shown - maxLines} more lines</div>`}
    ${!hunks.length && html`<div class="diff-gap">No changes</div>`}
  </div>`;
}
export { diffStats, lineDiff };

// ---------- small controls ----------
export function Toggle({ on, onChange, label, disabled }) {
  return html`<button class=${'toggle' + (on ? ' on' : '')} role="switch" aria-checked=${on} aria-label=${label} disabled=${disabled} onClick=${() => onChange(!on)}></button>`;
}

export function Seg({ value, options, onChange, block }) {
  return html`<div class=${'seg' + (block ? ' block' : '')} role="tablist">${options.map(o => {
    const v = typeof o === 'string' ? o : o.value, l = typeof o === 'string' ? o : o.label;
    return html`<button role="tab" aria-selected=${value === v} class=${value === v ? 'on' : ''} onClick=${() => onChange(v)}>${o.icon && html`<${Icon} name=${o.icon} />`}${l}</button>`;
  })}</div>`;
}

export function Progress({ value, max = 1, indet }) {
  const pct = indet ? 35 : Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  return html`<div class=${'progress' + (indet ? ' indet' : '')}><div style=${`width:${pct}%`}></div></div>`;
}

export function Empty({ icon = 'inbox', title, children }) {
  return html`<div class="empty"><${Icon} name=${icon} /><h3>${title}</h3><div class="small">${children}</div></div>`;
}

export function Banner({ kind = '', icon = 'info', children }) {
  return html`<div class=${'banner ' + kind}><${Icon} name=${icon} /><div class="grow">${children}</div></div>`;
}

// ---------- Line chart (canvas, multiple series, tooltips) ----------
const SERIES_COLORS = ['var(--accent)', '#f2b24c', '#3fd6a4', '#f2708f', '#4fb3ff', '#c792ea'];
export function LineChart({ series, height = 180, xLabel = 'step', logY = false, yLabel }) {
  const ref = useRef();
  const [hover, setHover] = useState(null);
  useEffect(() => {
    const c = ref.current; if (!c) return;
    const draw = () => {
      const dpr = devicePixelRatio || 1, W = c.clientWidth, H = height;
      c.width = W * dpr; c.height = H * dpr;
      const g = c.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
      const cs = getComputedStyle(c);
      const col = (v) => v.startsWith('var(') ? cs.getPropertyValue(v.slice(4, -1)).trim() : v;
      const pts = series.flatMap(s => s.points);
      if (!pts.length) { g.fillStyle = col('var(--text-4)'); g.font = '12px system-ui'; g.fillText('No data yet', 12, H / 2); return; }
      const tf = (y) => logY ? Math.log10(Math.max(y, 1e-8)) : y;
      let x0 = Math.min(...pts.map(p => p[0])), x1 = Math.max(...pts.map(p => p[0]));
      let y0 = Math.min(...pts.map(p => tf(p[1]))), y1 = Math.max(...pts.map(p => tf(p[1])));
      if (x0 === x1) x1 = x0 + 1; if (y0 === y1) { y0 -= 1; y1 += 1; }
      const padY = (y1 - y0) * 0.08; y0 -= padY; y1 += padY;
      const L = 44, R = 10, T = 10, B = 22;
      const X = (x) => L + (x - x0) / (x1 - x0) * (W - L - R);
      const Y = (y) => T + (1 - (tf(y) - y0) / (y1 - y0)) * (H - T - B);
      g.strokeStyle = col('var(--border)'); g.lineWidth = 1; g.fillStyle = col('var(--text-3)'); g.font = '10.5px ui-monospace, monospace';
      for (let i = 0; i <= 4; i++) {
        const yv = y0 + (y1 - y0) * i / 4, yy = T + (1 - i / 4) * (H - T - B);
        g.beginPath(); g.moveTo(L, yy); g.lineTo(W - R, yy); g.stroke();
        const label = logY ? Math.pow(10, yv) : yv;
        g.fillText(Math.abs(label) >= 100 ? label.toFixed(0) : Math.abs(label) >= 1 ? label.toFixed(2) : label.toPrecision(2), 2, yy + 3);
      }
      g.fillText(String(Math.round(x0)), L, H - 6);
      const xr = String(Math.round(x1)); g.fillText(xr, W - R - g.measureText(xr).width, H - 6);
      series.forEach((s, si) => {
        if (!s.points.length) return;
        g.strokeStyle = col(s.color || SERIES_COLORS[si % SERIES_COLORS.length]); g.lineWidth = 1.8; g.lineJoin = 'round';
        g.beginPath();
        s.points.forEach(([x, y], i) => (i ? g.lineTo(X(x), Y(y)) : g.moveTo(X(x), Y(y))));
        g.stroke();
      });
      c._scale = { X, Y, x0, x1, L, R, W };
    };
    draw();
    const ro = new ResizeObserver(draw); ro.observe(c);
    return () => ro.disconnect();
  }, [series, height, logY]);
  const onMove = (e) => {
    const c = ref.current, s = c?._scale; if (!s) return;
    const r = c.getBoundingClientRect();
    const px = (e.touches ? e.touches[0].clientX : e.clientX) - r.left;
    const xv = s.x0 + (px - s.L) / (s.W - s.L - s.R) * (s.x1 - s.x0);
    const vals = series.map(se => { let best = null; for (const p of se.points) if (!best || Math.abs(p[0] - xv) < Math.abs(best[0] - xv)) best = p; return best && { name: se.name, x: best[0], y: best[1] }; }).filter(Boolean);
    setHover(vals.length ? { px, vals } : null);
  };
  return html`<div style="position:relative">
    <canvas ref=${ref} class="chart" style=${`height:${height}px`} onMouseMove=${onMove} onTouchMove=${onMove} onMouseLeave=${() => setHover(null)} onTouchEnd=${() => setTimeout(() => setHover(null), 1500)}></canvas>
    ${hover && html`<div class="tag" style=${`position:absolute;top:4px;left:${Math.min(hover.px + 8, 9999)}px;pointer-events:none;flex-direction:column;align-items:flex-start;gap:0;padding:4px 7px`}>
      <span>${xLabel} ${hover.vals[0].x}</span>${hover.vals.map(v => html`<span>${v.name}: ${typeof v.y === 'number' ? v.y.toPrecision(4) : v.y}</span>`)}</div>`}
    ${series.length > 1 && html`<div class="legend" style="margin-top:6px">${series.map((s, i) => html`<span><i style=${`background:${s.color || SERIES_COLORS[i % SERIES_COLORS.length]}`}></i>${s.name}</span>`)}</div>`}
  </div>`;
}

export function copyText(text) {
  return navigator.clipboard?.writeText(text).then(() => toast('Copied', 'ok', 1200)).catch(() => toast('Copy failed', 'err'));
}

// Long-press helper for touch (context menus)
export function useLongPress(cb, ms = 480) {
  const t = useRef();
  const start = (e) => { const ev = e.touches ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : { x: e.clientX, y: e.clientY }; t.current = setTimeout(() => cb(ev), ms); };
  const cancel = () => clearTimeout(t.current);
  return { onTouchStart: start, onTouchEnd: cancel, onTouchMove: cancel, onContextMenu: (e) => { e.preventDefault(); cb({ x: e.clientX, y: e.clientY }); } };
}
