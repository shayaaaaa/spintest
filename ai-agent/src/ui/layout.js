// Which tab shows in which pane. Folded (narrow) = one pane; unfolded = two panes when layout is "adaptive".
import { createStore } from '../core/store.js';
import { settings, setSetting } from '../core/settings.js';
import { env } from '../core/platform.js';
import { bus } from '../core/bus.js';

export const TABS = [
  { id: 'agent', label: 'Agent', icon: 'terminal' },
  { id: 'code', label: 'Code', icon: 'code' },
  { id: 'chat', label: 'Chat', icon: 'chat' },
  { id: 'studio', label: 'Studio', icon: 'flask' },
  { id: 'hub', label: 'Hub', icon: 'folder' },
];

const initial = () => {
  const p = settings.get().panes || {};
  const hash = location.hash.slice(1);
  const single = TABS.some(t => t.id === hash) ? hash : (p.single || p.left || 'agent');
  return { single, left: p.left || 'agent', right: p.right || 'code', focus: 'left', split: p.split || 0.5 };
};
export const layout = createStore(initial());

export function isTwoPane() {
  return env.get().unfolded && settings.get().layout !== 'single';
}

function persist() {
  const s = layout.get();
  setSetting('panes', { single: s.single, left: s.left, right: s.right, split: s.split });
  history.replaceState(null, '', '#' + (isTwoPane() ? s[s.focus] : s.single));
}

// Show a tab. In two-pane mode it goes into the focused pane, unless it's already visible in the other one.
export function showTab(id, { pane } = {}) {
  layout.set(s => {
    if (!isTwoPane()) return { ...s, single: id };
    if (pane) return { ...s, [pane]: id, focus: pane };
    if (s.left === id) return { ...s, focus: 'left', single: id };
    if (s.right === id) return { ...s, focus: 'right', single: id };
    return { ...s, [s.focus]: id, single: id };
  });
  persist();
}

export function focusPane(pane) { layout.set({ focus: pane }); }
export function setSplit(split) { layout.set({ split: Math.max(0.25, Math.min(0.75, split)) }); }
export function persistSplit() { persist(); }
export function swapPanes() { layout.set(s => ({ ...s, left: s.right, right: s.left })); persist(); }

// Cross-tab navigation helpers.
export function openFileInEditor(path, line) { showTab('code'); setTimeout(() => bus.emit('open-file', { path, line }), 0); }
export function openInHub(path) { showTab('hub'); setTimeout(() => bus.emit('hub-open', { path }), 0); }
