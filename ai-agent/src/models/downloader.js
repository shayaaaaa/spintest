// Resumable downloads into the Hub (Range requests, retries, survives app restarts and backgrounding).
import * as vfs from '../core/vfs.js';
import { createStore } from '../core/store.js';
import { holdWakeLock } from '../core/net.js';
import { authHeaders } from './hf.js';
import { uid, sleep } from '../core/util.js';

export const downloads = createStore({ jobs: [] });
const controllers = new Map();

function patchJob(id, patch) {
  downloads.set(s => ({ jobs: s.jobs.map(j => j.id === id ? { ...j, ...(typeof patch === 'function' ? patch(j) : patch) } : j) }));
}

// job: {name, dir (Hub folder), manifest (object written to dir/manifest.json), files:[{url, path, size}], onDone?}
export function enqueue(job) {
  const existing = downloads.get().jobs.find(j => j.dir === job.dir && ['queued', 'downloading', 'paused', 'error'].includes(j.status));
  if (existing) { resume(existing.id); return existing.id; }
  const id = uid('dl');
  const total = job.files.reduce((a, f) => a + (f.size || 0), 0);
  downloads.set(s => ({ jobs: [...s.jobs, { id, name: job.name, dir: job.dir, total, loaded: 0, speed: 0, status: 'queued', error: null, job }] }));
  pump();
  return id;
}

let running = false;
async function pump() {
  if (running) return;
  running = true;
  try {
    while (true) {
      const next = downloads.get().jobs.find(j => j.status === 'queued');
      if (!next) break;
      await run(next.id);
    }
  } finally { running = false; }
}

async function writeManifest(job, status, extra = {}) {
  const man = { ...job.manifest, status, files: job.files.map(f => ({ path: f.path, size: f.size, url: f.url, done: !!f.done })), bytes: job.files.reduce((a, f) => a + (f.size || 0), 0), ...extra };
  await vfs.writeJSON(`${job.dir}/manifest.json`, man);
}

async function run(id) {
  const j = downloads.get().jobs.find(x => x.id === id);
  if (!j) return;
  const job = j.job;
  const ctrl = new AbortController();
  controllers.set(id, ctrl);
  patchJob(id, { status: 'downloading', error: null });
  const release = await holdWakeLock();
  await writeManifest(job, 'downloading', { added: job.manifest.added || Date.now() });
  let loadedBase = 0;
  const t0 = performance.now();
  let lastT = t0, lastBytes = 0, speed = 0;
  try {
    // Figure out how much is already on disk (resume).
    for (const f of job.files) {
      const p = `${job.dir}/${f.path}`;
      const st = await vfs.stat(p).catch(() => null);
      f.have = st?.size || 0;
      if (f.size && f.have >= f.size) f.done = true;
      loadedBase += Math.min(f.have, f.size || f.have);
    }
    patchJob(id, { loaded: loadedBase });
    const report = (delta) => {
      loadedBase += delta;
      const now = performance.now();
      if (now - lastT > 500) {
        const inst = (loadedBase - lastBytes) / ((now - lastT) / 1000);
        speed = speed ? speed * 0.7 + inst * 0.3 : inst;
        lastT = now; lastBytes = loadedBase;
        patchJob(id, { loaded: loadedBase, speed });
      }
    };
    lastBytes = loadedBase;
    // Small files in parallel (MLC shards), big ones one at a time.
    const pending = job.files.filter(f => !f.done);
    const small = pending.filter(f => (f.size || 0) < 150e6), big = pending.filter(f => (f.size || 0) >= 150e6);
    const worker = async (list) => { for (const f of list) await fetchFile(job, f, ctrl.signal, report); };
    const lanes = [[], [], []];
    small.forEach((f, i) => lanes[i % 3].push(f));
    await Promise.all(lanes.map(worker));
    await worker(big);
    await writeManifest(job, 'ready', { completed: Date.now() });
    patchJob(id, { status: 'done', loaded: job.files.reduce((a, f) => a + (f.size || 0), 0), speed: 0 });
    try { await job.onDone?.(); } catch (e) { console.error(e); }
  } catch (e) {
    if (ctrl.signal.aborted) { patchJob(id, { status: 'paused', speed: 0 }); await writeManifest(job, 'partial'); }
    else { console.error(e); patchJob(id, { status: 'error', error: String(e.message || e), speed: 0 }); await writeManifest(job, 'partial').catch(() => {}); }
  } finally { release(); controllers.delete(id); }
}

async function fetchFile(job, f, signal, report) {
  const path = `${job.dir}/${f.path}`;
  for (let attempt = 0; ; attempt++) {
    const st = await vfs.stat(path).catch(() => null);
    let offset = st?.size || 0;
    if (f.size && offset >= f.size) { f.done = true; return; }
    try {
      const headers = { ...(f.url.includes('huggingface.co') ? authHeaders() : {}) };
      if (offset > 0) headers.Range = `bytes=${offset}-`;
      const r = await fetch(f.url, { headers, signal });
      if (r.status === 416) { f.done = true; return; }
      if (!r.ok && r.status !== 206) throw new Error(`${f.path}: HTTP ${r.status}`);
      if (offset > 0 && r.status === 200) { report(-offset); offset = 0; } // server ignored Range
      if (!f.size) f.size = Number(r.headers.get('content-length') || 0) + offset;
      const ws = await vfs.createWriteStream(path, { offset });
      const reader = r.body.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          await ws.write(value);
          report(value.byteLength);
        }
        await ws.close();
      } catch (e) { await ws.close().catch(() => {}); throw e; }
      f.done = true;
      return;
    } catch (e) {
      if (signal.aborted) throw e;
      if (attempt >= 5) throw e;
      await sleep(Math.min(15000, 1000 * 2 ** attempt));
      if (!navigator.onLine) await new Promise(res => addEventListener('online', res, { once: true }));
    }
  }
}

export function pause(id) { controllers.get(id)?.abort(); }
export function resume(id) { patchJob(id, { status: 'queued', error: null }); pump(); }
export async function cancel(id, { deleteFiles = true } = {}) {
  const j = downloads.get().jobs.find(x => x.id === id);
  controllers.get(id)?.abort();
  await sleep(100);
  downloads.set(s => ({ jobs: s.jobs.filter(x => x.id !== id) }));
  if (deleteFiles && j) await vfs.rm(j.dir).catch(() => {});
}
export function clearFinished() { downloads.set(s => ({ jobs: s.jobs.filter(j => j.status !== 'done') })); }

// Finds downloads that were interrupted (app closed) and lists them as paused, ready to resume.
export async function restorePending() {
  for (const kind of ['llm', 'vision', 'speech', 'tts', 'embeddings', 'adapters']) {
    for (const e of await vfs.list(`/models/${kind}`).catch(() => [])) {
      if (e.kind !== 'directory') continue;
      const man = await vfs.readJSON(`${e.path}/manifest.json`, null);
      if (!man || !['downloading', 'partial'].includes(man.status) || !man.files?.every(f => f.url)) continue;
      if (downloads.get().jobs.some(j => j.dir === e.path)) continue;
      const files = man.files.map(f => ({ url: f.url, path: f.path, size: f.size }));
      const { status, files: _f, ...manifest } = man;
      const total = files.reduce((a, f) => a + (f.size || 0), 0);
      downloads.set(s => ({ jobs: [...s.jobs, { id: uid('dl'), name: man.name || man.id, dir: e.path, total, loaded: 0, speed: 0, status: 'paused', job: { name: man.name, dir: e.path, manifest, files } }] }));
    }
  }
}

addEventListener('online', () => { for (const j of downloads.get().jobs) if (j.status === 'error') resume(j.id); });
