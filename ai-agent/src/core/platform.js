// Device capabilities, fold state, online state, theme application.
import { createStore } from './store.js';
import { settings } from './settings.js';

export const TWO_PANE_MIN = 600; // iPhone Duo unfolded is ~660 pt wide in portrait, folded ~470 pt

export const env = createStore({
  width: innerWidth, height: innerHeight,
  unfolded: innerWidth >= TWO_PANE_MIN,
  online: navigator.onLine,
  standalone: matchMedia('(display-mode: standalone)').matches || navigator.standalone === true,
  isolated: !!self.crossOriginIsolated,
  webgpu: null,          // {vendor, arch, f16, maxBuffer, maxBinding} or false
  storage: { used: 0, quota: 0 },
  keyboard: false,
  ios: /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1),
  touch: matchMedia('(pointer: coarse)').matches,
});

let rT;
addEventListener('resize', () => {
  clearTimeout(rT);
  rT = setTimeout(() => env.set({ width: innerWidth, height: innerHeight, unfolded: innerWidth >= TWO_PANE_MIN }), 60);
});
addEventListener('online', () => env.set({ online: true }));
addEventListener('offline', () => env.set({ online: false }));

// Soft keyboard detection via visualViewport (iOS)
if (window.visualViewport) {
  const vv = window.visualViewport;
  const onVV = () => {
    const kb = innerHeight - vv.height > 120;
    document.documentElement.style.setProperty('--vvh', vv.height + 'px');
    if (kb !== env.get().keyboard) env.set({ keyboard: kb });
  };
  vv.addEventListener('resize', onVV);
  onVV();
}

export async function probeWebGPU() {
  try {
    if (!navigator.gpu) return env.set({ webgpu: false }), false;
    const a = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!a) return env.set({ webgpu: false }), false;
    const info = a.info || {};
    const g = { vendor: info.vendor || '', arch: info.architecture || '', f16: a.features.has('shader-f16'), maxBuffer: a.limits.maxBufferSize, maxBinding: a.limits.maxStorageBufferBindingSize, subgroups: a.features.has('subgroups') };
    env.set({ webgpu: g });
    return g;
  } catch { env.set({ webgpu: false }); return false; }
}

export async function refreshStorage() {
  try { const e = await navigator.storage.estimate(); env.set({ storage: { used: e.usage || 0, quota: e.quota || 0 } }); } catch {}
}

const mq = matchMedia('(prefers-color-scheme: light)');
export function applyTheme() {
  const s = settings.get();
  const theme = s.theme === 'system' ? (mq.matches ? 'light' : 'dark') : s.theme;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = s.accent || 'iris';
  root.style.setProperty('--fs', (s.fontSize || 15) + 'px');
  const meta = document.querySelector('meta[name=theme-color]:not([media])') || Object.assign(document.head.appendChild(document.createElement('meta')), { name: 'theme-color' });
  meta.content = theme === 'light' ? '#f7f7f8' : '#0d0d10';
}
mq.addEventListener?.('change', applyTheme);
settings.subscribe(applyTheme);

// Rough guess at usable memory for models (iOS doesn't expose deviceMemory). iPhone Duo ≈ 12 GB.
export function memoryBudgetGB() {
  const dm = navigator.deviceMemory; // Chromium only, capped at 8
  if (env.get().ios) return 12;
  return dm ? Math.max(dm, 8) : 8;
}
