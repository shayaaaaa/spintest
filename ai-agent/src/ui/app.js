// App shell: tab bar (folded) or side rail + two resizable panes (unfolded).
import { html, useState, useEffect, useRef } from '../../vendor/preact.mjs';
import { useStore } from '../core/store.js';
import { env } from '../core/platform.js';
import { settings } from '../core/settings.js';
import { bus } from '../core/bus.js';
import { Icon } from './icons.js';
import { Overlays, Toasts, toast } from './kit.js';
import { layout, TABS, showTab, focusPane, setSplit, persistSplit, isTwoPane } from './layout.js';
import { SetupBar } from './setup-bar.js';

const loaders = {
  agent: () => import('./agent/agent-view.js').then(m => m.AgentView),
  code: () => import('./code/code-view.js').then(m => m.CodeView),
  chat: () => import('./chat/chat-view.js').then(m => m.ChatView),
  studio: () => import('./studio/studio-view.js').then(m => m.StudioView),
  hub: () => import('./hub/hub-view.js').then(m => m.HubView),
};
const loaded = {};

function LazyTab({ id, pane, active }) {
  const [Comp, setComp] = useState(() => loaded[id] || null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (loaded[id]) { setComp(() => loaded[id]); return; }
    loaders[id]().then(C => { loaded[id] = C; setComp(() => C); }).catch(e => { console.error(e); setErr(e); });
  }, [id]);
  if (err) return html`<div class="empty"><${Icon} name="alert" /><h3>Couldn't load ${id}</h3><div class="small">${String(err.message || err)}</div></div>`;
  if (!Comp) return html`<div class="center grow"><div class="spinner"></div></div>`;
  return html`<${Comp} pane=${pane} active=${active} />`;
}

// Keeps every opened tab mounted (so agent runs, editors and downloads keep their state) and shows one.
function PaneContent({ tab, pane }) {
  const [mounted, setMounted] = useState(() => new Set([tab]));
  useEffect(() => { setMounted(m => m.has(tab) ? m : new Set([...m, tab])); }, [tab]);
  return html`${[...mounted].map(id => html`<div key=${id} class="pbody" style=${id === tab ? '' : 'display:none'}><${LazyTab} id=${id} pane=${pane} active=${id === tab} /></div>`)}`;
}

function TabButton({ t, active, other, onClick }) {
  return html`<button class=${'tab' + (active ? ' active' : '') + (other ? ' other' : '')} onClick=${onClick} aria-label=${t.label} aria-current=${active ? 'page' : null}>
    <${Icon} name=${t.icon} /><span>${t.label}</span></button>`;
}

export function App() {
  const e = useStore(env, s => ({ unfolded: s.unfolded, keyboard: s.keyboard }));
  const st = useStore(settings, s => ({ layout: s.layout }));
  const L = useStore(layout);
  const two = e.unfolded && st.layout !== 'single';
  const panesRef = useRef();

  useEffect(() => {
    const onHash = () => { const h = location.hash.slice(1); if (TABS.some(t => t.id === h)) showTab(h); };
    addEventListener('hashchange', onHash);
    const offUpd = bus.on('app-updated', () => toast('Ai Agent was updated. Reopen the app to use the new version.', 'info', 6000));
    return () => { removeEventListener('hashchange', onHash); offUpd(); };
  }, []);

  const startDrag = (ev) => {
    ev.preventDefault();
    const rect = panesRef.current.getBoundingClientRect();
    const move = (m) => { const x = (m.touches ? m.touches[0].clientX : m.clientX) - rect.left; setSplit(x / rect.width); };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); persistSplit(); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  };

  if (!two) {
    return html`<div class="shell"><div class="shell-main">
      <div class="panes"><div class="pane"><${PaneContent} tab=${L.single} pane="single" /></div></div>
      ${!e.keyboard && html`<${SetupBar} />`}
      ${!e.keyboard && html`<nav class="tabbar">${TABS.map(t => html`<${TabButton} key=${t.id} t=${t} active=${L.single === t.id} onClick=${() => showTab(t.id)} />`)}</nav>`}
    </div></div><${Overlays} /><${Toasts} />`;
  }

  const focusedTab = L[L.focus];
  const otherTab = L[L.focus === 'left' ? 'right' : 'left'];
  return html`<div class="shell">
    <nav class="rail">
      ${TABS.map(t => html`<${TabButton} key=${t.id} t=${t} active=${focusedTab === t.id} other=${otherTab === t.id} onClick=${() => showTab(t.id)} />`)}
      <div class="spacer"></div>
      <button class="tab" title="Single pane" onClick=${() => settings.set(s => ({ ...s, layout: 'single' }))}><${Icon} name="square" /><span>Single</span></button>
    </nav>
    <div class="shell-main"><div class="panes" ref=${panesRef}>
      <div class=${'pane' + (L.focus === 'left' ? ' focused' : '')} style=${`flex:${L.split}`} onPointerDown=${() => L.focus !== 'left' && focusPane('left')}>
        <${PaneContent} tab=${L.left} pane="left" /></div>
      <div class="divider" onPointerDown=${startDrag} onDblClick=${() => { setSplit(0.5); persistSplit(); }} role="separator" aria-orientation="vertical"></div>
      <div class=${'pane' + (L.focus === 'right' ? ' focused' : '')} style=${`flex:${1 - L.split}`} onPointerDown=${() => L.focus !== 'right' && focusPane('right')}>
        <${PaneContent} tab=${L.right} pane="right" /></div>
    </div><${SetupBar} /></div>
  </div><${Overlays} /><${Toasts} />`;
}

export { isTwoPane };
