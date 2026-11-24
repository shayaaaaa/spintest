// First-run setup: installs everything the app needs, automatically and once, the first time it opens.
// The big model download starts first (it runs in the background), the smaller pieces install one after another.
// Each step records "done" in settings so it never repeats; a step that fails is retried on the next launch.
import { createStore } from './store.js';
import { settings, setSetting } from './settings.js';
import { bus } from './bus.js';
import * as vfs from './vfs.js';

export const setupStore = createStore({ running: false, done: false, steps: [], error: null });

const stepDone = (id) => settings.get().setup?.steps?.[id] === 'done';
const markDone = (id) => setSetting(`setup.steps.${id}`, 'done');
const patchStep = (id, patch) => setupStore.set(s => ({ ...s, steps: s.steps.map(x => x.id === id ? { ...x, ...patch } : x) }));
const timeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not respond`)), ms))]);

async function pickModel() {
  if (globalThis.__aiaSetupModel) return globalThis.__aiaSetupModel; // tests use a small model
  const { GGUF_CATALOG, memNeedGB } = await import('../models/catalog.js');
  const { memoryBudgetGB } = await import('./platform.js');
  const budget = memoryBudgetGB();
  const fits = (m) => memNeedGB(m.sizeGB, m.context, m.params) <= budget * 0.6;
  return GGUF_CATALOG.find(m => m.tags?.includes('recommended') && fits(m))
    || GGUF_CATALOG.filter(m => m.tags?.includes('tools') && fits(m)).sort((a, b) => b.sizeGB - a.sizeGB)[0]
    || GGUF_CATALOG.find(m => m.tags?.includes('tiny'));
}

// ---------- steps ----------
const STEPS = {
  offline: {
    label: 'App files for offline use', size: '65 MB',
    async isDone(force) { return !force && stepDone('offline'); },
    async run(update) {
      const reg = await timeout(navigator.serviceWorker?.ready || Promise.resolve(null), 15000, 'Service worker').catch(() => null);
      if (!reg?.active) return 'skipped';
      await new Promise((resolve) => {
        const offP = bus.on('cache-engines-progress', (d) => update({ progress: d.total ? d.done / d.total : 0, text: `${d.done} of ${d.total} files` }));
        const offD = bus.on('cache-engines-done', () => { offP(); offD(); resolve(); });
        reg.active.postMessage({ type: 'cache-engines' });
      });
    },
  },
  model: {
    label: 'Agent & Chat model', size: '2.5 GB',
    async isDone(force) {
      if (!force && stepDone('model')) return true;
      const { modelsStore, refreshModels } = await import('../models/registry.js');
      if (!modelsStore.get().local.length) await refreshModels();
      return modelsStore.get().local.some(m => m.kind === 'llm' && m.status === 'ready' && m.engine !== 'forge');
    },
    async run(update) {
      const m = await pickModel();
      update({ label: `${m.name} (Agent & Chat model)`, size: `${m.sizeGB} GB` });
      const { installGGUF } = await import('../models/registry.js');
      const { downloads, restorePending, resume } = await import('../models/downloader.js');
      await restorePending();
      const want = (j) => j.name === m.name;
      const pending = downloads.get().jobs.find(want);
      if (pending) { if (pending.status !== 'done') resume(pending.id); }
      else await installGGUF(m);
      await new Promise((resolve, reject) => {
        const check = (s) => {
          const j = s.jobs.find(want);
          if (!j) return;
          update({ progress: j.total ? j.loaded / j.total : 0, text: j.status === 'paused' ? 'paused (waiting for the network)' : `${Math.round(j.loaded / 1e6)} of ${Math.round(j.total / 1e6)} MB` });
          if (j.status === 'done') { off(); resolve(); }
          else if (j.status === 'error') { off(); reject(new Error(j.error || 'download failed')); }
        };
        const off = downloads.subscribe(check);
        check(downloads.get());
      });
    },
  },
  linux: {
    label: 'Linux VM', size: '49 MB + first boot',
    async isDone(force) { return (!force && settings.get().linux?.autoInstall === false) || (await import('../runtimes/linux.js')).isPrepared(); },
    async run(update) {
      const L = await import('../runtimes/linux.js');
      const off = L.linuxStore.subscribe((s) => update({ progress: s.state === 'downloading' ? (s.progress || 0) * 0.3 : s.state === 'booting' ? 0.5 : undefined, text: s.text }));
      try { if (!(await L.autoSetup({ force: true }))) throw new Error('Linux setup did not finish'); }
      finally { off(); }
    },
  },
  python: {
    label: 'Python with numpy, pandas, matplotlib', size: '~45 MB',
    async isDone(force) { return force ? (await import('../runtimes/python.js')).isInstalled() : stepDone('python'); },
    async run(update) {
      const P = await import('../runtimes/python.js');
      const off = P.pythonStore.subscribe((s) => update({ progress: s.progress, text: s.text }));
      try { await P.install({ packages: ['numpy', 'pandas', 'matplotlib', 'micropip'] }); }
      finally { off(); }
    },
  },
  ffmpeg: {
    label: 'ffmpeg (audio & video)', size: '32 MB',
    async isDone() { return vfs.exists('/runtimes/ffmpeg/ffmpeg-core.wasm'); },
    async run(update) { await (await import('../agent/tools/media.js')).ensureFfmpeg((t) => update({ text: t })); },
  },
  search: {
    label: 'Search model for memory & knowledge', size: '23 MB',
    async isDone(force) {
      if (!force && stepDone('search')) return true;
      return (await vfs.readJSON('/models/embeddings/Xenova--all-MiniLM-L6-v2/manifest.json', null))?.status === 'ready';
    },
    async run(update) {
      update({ text: 'Downloading MiniLM embeddings…' });
      await (await import('../models/registry.js')).installONNX({ name: 'MiniLM L6 (embeddings)', repo: 'Xenova/all-MiniLM-L6-v2', kind: 'embeddings' });
    },
  },
};
const ORDER = ['offline', 'linux', 'python', 'ffmpeg', 'search'];

async function runStep(id) {
  const def = STEPS[id];
  patchStep(id, { state: 'running', progress: 0, text: '' });
  try {
    const r = await def.run((p) => patchStep(id, Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined))));
    markDone(id);
    patchStep(id, { state: r === 'skipped' ? 'skipped' : 'done', progress: 1, text: '' });
  } catch (e) {
    console.warn(`Setup step ${id} failed`, e);
    patchStep(id, { state: 'error', text: String(e.message || e) });
  }
}

let running = null;
// Runs whatever is still missing. Automatic on launch (opt out: Settings → Storage & offline); force for "Run again".
export function runSetup({ force = false } = {}) {
  if (running) return running;
  if (!force && (settings.get().setup?.auto === false || navigator.webdriver)) return Promise.resolve(null);
  running = (async () => {
    const todo = [];
    for (const id of ['model', ...ORDER]) if (!(await STEPS[id].isDone(force))) todo.push(id);
    if (!todo.length) { setupStore.set({ running: false, done: true, steps: [] }); return 'ready'; }
    if (!navigator.onLine) { addEventListener('online', () => runSetup({ force }), { once: true }); return null; }
    setupStore.set({ running: true, done: false, error: null, steps: todo.map(id => ({ id, label: STEPS[id].label, size: STEPS[id].size, state: 'pending', progress: 0, text: '' })) });
    bus.emit('setup-started', todo);
    const model = todo.includes('model') ? runStep('model') : null; // big download in the background
    for (const id of ORDER) if (todo.includes(id)) await runStep(id);
    await model;
    const failed = setupStore.get().steps.filter(s => s.state === 'error');
    setupStore.set(s => ({ ...s, running: false, done: !failed.length }));
    if (!failed.length) setSetting('setup.completed', Date.now());
    bus.emit('setup-finished', { failed: failed.map(s => s.id) });
    return failed.length ? 'partial' : 'ready';
  })().finally(() => { running = null; });
  return running;
}
