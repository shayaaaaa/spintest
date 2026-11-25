// Python runtime (Pyodide 0.29.5 / CPython 3.13): downloaded once into Hub/runtimes/pyodide, then fully offline.
import * as vfs from '../core/vfs.js';
import { createStore } from '../core/store.js';
import { isTextName } from '../core/util.js';

export const PYODIDE_VERSION = '0.29.5';
const CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const DIR = '/runtimes/pyodide';
const CORE = ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
export const pythonStore = createStore({ state: 'unknown', progress: 0, text: '' });

const indexURL = () => new URL('hub/runtimes/pyodide/', document.baseURI).href;
let lock = null;
async function getLock() { return lock ||= await vfs.readJSON(`${DIR}/pyodide-lock.json`); }

export async function isInstalled() {
  for (const f of CORE) if (!(await vfs.exists(`${DIR}/${f}`))) return false;
  return true;
}

async function download(name, onBytes) {
  const r = await fetch(CDN + name);
  if (!r.ok) throw new Error(`Download failed: ${name} (${r.status})`);
  const ws = await vfs.createWriteStream(`${DIR}/${name}`);
  const reader = r.body.getReader();
  while (true) { const { value, done } = await reader.read(); if (done) break; await ws.write(value); onBytes?.(value.byteLength); }
  await ws.close();
}

export async function install({ packages = ['numpy', 'micropip'] } = {}) {
  if (!navigator.onLine) throw new Error('Python needs a one-time download (~25 MB). Connect to the internet and try again.');
  pythonStore.set({ state: 'installing', progress: 0, text: 'Downloading Python…' });
  let got = 0; const approx = 26e6;
  for (const f of CORE) if (!(await vfs.exists(`${DIR}/${f}`))) await download(f, (n) => { got += n; pythonStore.set({ progress: Math.min(0.95, got / approx) }); });
  lock = null;
  await ensurePackages(packages);
  pythonStore.set({ state: 'ready', progress: 1, text: '' });
}

// Downloads wheels (with dependencies) for the given package names into the Hub.
export async function ensurePackages(names) {
  const l = await getLock();
  const need = new Set();
  const add = (n) => { const k = n.toLowerCase(); const p = l.packages[k] || Object.values(l.packages).find(x => x.name?.toLowerCase() === k); if (!p || need.has(p.name)) return; need.add(p.name); (p.depends || []).forEach(add); };
  names.forEach(add);
  const missing = [];
  for (const n of need) { const p = l.packages[n.toLowerCase()] || l.packages[n]; if (p && !(await vfs.exists(`${DIR}/${p.file_name}`))) missing.push(p.file_name); }
  if (missing.length && !navigator.onLine) throw new Error(`Python packages not downloaded yet: ${missing.join(', ')}. Connect once to fetch them.`);
  let i = 0;
  for (const f of missing) { pythonStore.set({ state: 'installing', text: `Downloading ${f}`, progress: i++ / missing.length }); await download(f); }
  return [...need];
}

export function packageNames(imports, l) {
  const map = l.info?.import_name_to_package_name || {};
  const out = new Set();
  for (const imp of imports) {
    const top = imp.split('.')[0];
    const name = map[top] || Object.values(l.packages).find(p => (p.imports || []).includes(top))?.name;
    if (name) out.add(name);
  }
  return [...out];
}

let worker = null, seq = 0;
const waits = new Map();
function call(msg, onStream) {
  if (!worker) {
    worker = new Worker(new URL('../workers/python.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { const w = waits.get(e.data.id); if (!w) return; if (e.data.stream != null) { w.onStream?.(e.data.stream); return; } waits.delete(e.data.id); w.resolve(e.data); };
    worker.onerror = (e) => { for (const w of waits.values()) w.resolve({ error: 'Python crashed: ' + (e.message || 'unknown error') }); waits.clear(); worker = null; };
  }
  const id = ++seq;
  return new Promise((resolve) => { waits.set(id, { resolve, onStream }); worker.postMessage({ id, indexURL: indexURL(), ...msg }); });
}

export function stopPython() { worker?.terminate(); worker = null; for (const w of waits.values()) w.resolve({ error: 'Stopped' }); waits.clear(); }

// Runs code with the project folder mirrored in; writes changed files back. Returns {output, error, changed}.
export async function runPython(code, { cwd = '/workspace', onOutput, signal, file, argv } = {}) {
  if (!(await isInstalled())) await install();
  const l = await getLock();
  const imp = await call({ type: 'imports', code });
  const pkgs = packageNames(imp.result || [], l);
  if (pkgs.length) await ensurePackages(pkgs);
  // Mirror the project (text and small binaries up to 25 MB, max 2,000 files).
  const files = [];
  let total = 0;
  for await (const e of vfs.walk(cwd, { details: true })) {
    if (files.length >= 2000 || (e.size || 0) > 25e6 || total > 300e6) continue;
    if (!isTextName(e.name) && (e.size || 0) > 5e6) continue;
    files.push([e.path, await (await vfs.getFile(e.path)).arrayBuffer()]);
    total += e.size || 0;
  }
  let output = '';
  const onAbort = () => stopPython();
  signal?.addEventListener('abort', onAbort);
  const r = await call({ type: 'run', code, cwd, files, packages: pkgs, file, argv }, (s) => { output += s; onOutput?.(s); });
  signal?.removeEventListener('abort', onAbort);
  for (const [p, data] of r.changed || []) await vfs.write(p, new Uint8Array(data));
  pythonStore.set({ state: 'ready' });
  return { output, error: r.error || null, result: r.result, changed: (r.changed || []).map(c => c[0]) };
}
