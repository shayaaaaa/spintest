// Training jobs (main thread): run records in Hub/training/runs/<id>/, live progress store, the memory/time
// estimator, and start/stop/pause/resume/export on top of the Forge worker.
import * as vfs from '../core/vfs.js';
import { createStore } from '../core/store.js';
import { uid } from '../core/util.js';
import { settings, setSetting } from '../core/settings.js';
import { memoryBudgetGB } from '../core/platform.js';
import { rpc, forgeEvents } from './client.js';

const ROOT = '/training/runs';
export const runsStore = createStore({ runs: [], live: {}, active: null });
export const METHODS = {
  sft: { label: 'Fine-tune (SFT)', data: 'sft', help: 'Teach the model to answer like your examples.' },
  pretrain: { label: 'Continued pre-training', data: 'text', help: 'Feed the model raw text in your domain.' },
  scratch: { label: 'Train from scratch', data: 'text', help: 'A brand-new small model with its own tokenizer.' },
  dpo: { label: 'Preference tuning (DPO)', data: 'dpo', help: 'Prefer the chosen answer over the rejected one.' },
  grpo: { label: 'Reinforcement learning (GRPO)', data: 'grpo', help: 'The model tries answers; rewards steer it.' },
};
export const SCRATCH = {
  nano: { label: 'Nano · ~2M', hidden_size: 128, num_hidden_layers: 4, num_attention_heads: 4, num_key_value_heads: 2, intermediate_size: 384, vocab: 4096 },
  micro: { label: 'Micro · ~10M', hidden_size: 256, num_hidden_layers: 6, num_attention_heads: 4, num_key_value_heads: 2, intermediate_size: 768, vocab: 8192 },
  small: { label: 'Small · ~45M', hidden_size: 512, num_hidden_layers: 8, num_attention_heads: 8, num_key_value_heads: 4, intermediate_size: 1536, vocab: 16384 },
  base: { label: 'Base · ~110M', hidden_size: 768, num_hidden_layers: 12, num_attention_heads: 12, num_key_value_heads: 4, intermediate_size: 2048, vocab: 32000 },
};

const live = (id) => runsStore.get().live[id] || { metrics: [], evals: [], samples: [], rollouts: [], warns: [] };
function patchLive(id, fn) { runsStore.set(s => ({ ...s, live: { ...s.live, [id]: fn(live(id)) } })); }
const cap = (a, n) => a.length > n ? a.slice(a.length - n) : a;

// Persisted run record updates (debounced per run).
const pendingSave = new Map();
async function saveRun(id, patch) {
  const run = runsStore.get().runs.find(r => r.id === id);
  if (!run) return;
  const next = { ...run, ...patch, updated: Date.now() };
  runsStore.set(s => ({ ...s, runs: s.runs.map(r => r.id === id ? next : r) }));
  clearTimeout(pendingSave.get(id));
  pendingSave.set(id, setTimeout(() => vfs.writeJSON(`${run.dir}/run.json`, next, { silent: true }).catch(() => {}), 400));
}

forgeEvents.on('event', (e) => {
  if (!e.run) return;
  const id = e.run;
  if (e.type === 'metric') {
    patchLive(id, l => ({ ...l, metrics: cap([...l.metrics, e], 5000), last: e }));
    if (e.step % 10 === 0 || e.step === e.total) saveRun(id, { step: e.step, total: e.total, loss: e.loss, reward: e.reward });
  } else if (e.type === 'eval') patchLive(id, l => ({ ...l, evals: [...l.evals, e] }));
  else if (e.type === 'sample') patchLive(id, l => ({ ...l, samples: cap([...l.samples, e], 50) }));
  else if (e.type === 'rollout') patchLive(id, l => ({ ...l, rollouts: cap([...l.rollouts, e], 20) }));
  else if (e.type === 'warn') patchLive(id, l => ({ ...l, warns: cap([...l.warns, e.text], 20) }));
  else if (e.type === 'export') patchLive(id, l => ({ ...l, export: e }));
  else if (e.type === 'status') {
    patchLive(id, l => ({ ...l, status: e }));
    const patch = { state: e.state, statusText: e.text };
    if (e.step != null) patch.step = e.step;
    if (e.total != null) patch.total = e.total;
    if (e.trainable) patch.trainable = e.trainable;
    if (e.state === 'error') patch.error = e.text;
    saveRun(id, patch);
    if (['done', 'stopped', 'paused', 'error'].includes(e.state)) runsStore.set(s => ({ ...s, active: s.active === id ? null : s.active }));
  }
});

export async function loadRuns() {
  const runs = [];
  for (const e of await vfs.list(ROOT).catch(() => [])) {
    if (e.kind !== 'directory') continue;
    const r = await vfs.readJSON(`${e.path}/run.json`, null);
    if (r) runs.push({ ...r, dir: e.path });
  }
  runs.sort((a, b) => (b.created || 0) - (a.created || 0));
  // A run marked as training but not active in this session was interrupted (app closed or reloaded).
  const active = runsStore.get().active;
  for (const r of runs) if (['training', 'preparing', 'saving'].includes(r.state) && r.id !== active) { r.state = 'interrupted'; r.statusText = 'Interrupted (app closed). Resume from the last checkpoint.'; }
  runsStore.set(s => ({ ...s, runs }));
  return runs;
}

export async function readMetrics(id) {
  const run = runsStore.get().runs.find(r => r.id === id) || await vfs.readJSON(`${ROOT}/${id}/run.json`, null);
  const text = await vfs.readText(`${run?.dir || ROOT + '/' + id}/metrics.jsonl`).catch(() => '');
  const metrics = [], evals = [];
  for (const line of text.split('\n')) { if (!line.trim()) continue; try { const m = JSON.parse(line); (m.val_loss != null ? evals : metrics).push(m); } catch {} }
  const samples = (await vfs.readText(`${run?.dir}/samples.jsonl`).catch(() => '')).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  patchLive(id, l => ({ ...l, metrics: l.metrics.length > metrics.length ? l.metrics : metrics, evals: l.evals.length > evals.length ? l.evals : evals, samples: l.samples.length ? l.samples : cap(samples, 50) }));
  return { metrics, evals, samples };
}

// ---------- estimator ----------
function paramCount(hf) {
  const D = hf.hidden_size, L = hf.num_hidden_layers, I = hf.intermediate_size, V = hf.vocab_size, H = hf.num_attention_heads;
  const KVH = hf.num_key_value_heads || H, hd = hf.head_dim || D / H, qd = H * hd, kvd = KVH * hd;
  const lin = L * (D * qd + 2 * D * kvd + qd * D + 3 * D * I);
  const embed = V * D * (hf.tie_word_embeddings === false ? 2 : 1);
  return { lin, embed, total: lin + embed + L * 2 * D + D, D, L, I, V, H, KVH, hd, qd, kvd };
}

async function resolveBase(base) {
  if (!base || base === 'scratch') return null;
  const { modelsStore, refreshModels } = await import('../models/registry.js');
  if (!modelsStore.get().local.length) await refreshModels();
  const all = modelsStore.get().local;
  return all.find(m => m.ref === base) || all.find(m => m.id === base || m.name === base || m.source?.repo === base) || null;
}

export async function estimate(i) {
  const method = normMethod(i);
  const tuning = method.tuning;
  let hf;
  if (method.method === 'scratch') { const s = SCRATCH[i.size || 'micro']; hf = { ...s, vocab_size: s.vocab, tie_word_embeddings: true }; }
  else {
    const m = await resolveBase(i.base);
    if (!m) throw new Error('Base model not found. Use a trainable (safetensors) model from Studio → Models.');
    hf = await vfs.readJSON(`${m.dir}/config.json`, null);
    if (!hf) throw new Error(`${m.name} has no config.json (is it a safetensors model?)`);
  }
  const p = paramCount(hf);
  const T = i.seqLen || (method.method === 'grpo' ? 512 + (i.maxNew || 256) : method.method === 'scratch' || method.method === 'pretrain' ? 512 : 1024);
  const r = i.rank || 16;
  const targets = i.targets || ['q', 'k', 'v', 'o', 'gate', 'up', 'down'];
  const per = { q: p.D + p.qd, k: p.D + p.kvd, v: p.D + p.kvd, o: p.qd + p.D, gate: p.D + p.I, up: p.D + p.I, down: p.I + p.D };
  const loraParams = tuning === 'full' ? 0 : p.L * r * targets.reduce((a, t) => a + (per[t] || 0), 0);
  const trainable = tuning === 'full' ? p.total : loraParams;
  const GB = 1024 ** 3;
  const weights = tuning === 'full' ? p.total * 4 : tuning === 'qlora' ? p.lin * (0.5 + 4 / 64) + p.embed * 2 : p.lin * 2 + p.embed * 2;
  const optimizer = trainable * (tuning === 'full' ? 12 : 16);
  const rows = Math.min(T, Math.floor(256 * 1024 * 1024 / (p.V * 4)));
  const activations = 4 * (p.L * T * p.D + T * (6 * p.D + 3 * p.qd + 4 * p.kvd + 5 * p.I) + 2 * p.H * T * T + rows * p.V + T * p.D);
  const kv = 4 * p.L * 2 * Math.min(T + 256, 4096) * p.kvd; // KV cache for samples / GRPO rollouts
  const total = weights + optimizer + activations + kv;
  const budget = settings.get().forge?.memoryGB || memoryBudgetGB();
  const flopsPerToken = (tuning === 'full' ? 8 : 6) * (p.lin) + 6 * p.V * p.D;
  const batch = (i.batch || (method.method === 'grpo' ? 1 : 8)) * (i.gradAccum || 1);
  const gflops = settings.get().forge?.gflops || 400;
  let tokensPerStep = batch * T * (method.method === 'sft' || method.method === 'dpo' ? 0.5 : 1) * (method.method === 'dpo' ? 2 : 1);
  if (method.method === 'grpo') tokensPerStep = batch * (i.group || 4) * (T);
  let seconds = tokensPerStep * flopsPerToken / (gflops * 1e9) / 0.35;
  if (method.method === 'grpo') seconds += batch * (i.group || 4) * (i.maxNew || 256) * 2 * p.total / (gflops * 1e9 * 0.05);
  const steps = i.maxSteps || null;
  return {
    params: p.total, trainable, method: method.method, tuning, seqLen: T,
    memoryGB: { weights: +(weights / GB).toFixed(2), optimizer: +(optimizer / GB).toFixed(2), activations: +(activations / GB).toFixed(2), cache: +(kv / GB).toFixed(2), total: +(total / GB).toFixed(2) },
    budgetGB: budget, fits: total / GB <= budget, secondsPerStep: +seconds.toFixed(1), totalSeconds: steps ? Math.round(steps * seconds) : null,
    gflopsAssumed: gflops, measured: !!settings.get().forge?.gflops,
    advice: total / GB > budget ? (tuning === 'full' ? 'Too big for a full fine-tune: use LoRA or QLoRA, shorter sequences, or Offload.' : tuning === 'lora' ? 'Try QLoRA, a shorter sequence length, or Offload to a GPU.' : 'Shorten the sequence length, lower the rank, or Offload to a GPU.') : seconds > 60 ? 'Fits, but slow per step. Shorter sequences or Offload speed it up.' : 'Fits on this device.',
  };
}

export async function benchmark() {
  const r = await rpc('benchmark');
  setSetting('forge.gflops', Math.round(r.gflops));
  return r;
}

// ---------- runs ----------
function normMethod(i) {
  let method = i.method || 'sft', tuning = i.tuning || null;
  if (method === 'lora' || method === 'qlora') { tuning = method; method = 'sft'; }
  if (method === 'full') { tuning = 'full'; method = 'sft'; }
  if ((method === 'pretrain' && (!i.base || i.base === 'scratch')) || i.base === 'scratch') method = 'scratch';
  if (method === 'scratch') tuning = 'full';
  return { method, tuning: tuning || 'lora' };
}

export async function startRun(i) {
  if (runsStore.get().active) throw new Error('A training run is already active. Stop or pause it first.');
  const { method, tuning } = normMethod(i);
  if (!METHODS[method]) throw new Error('Unknown method ' + method);
  const base = method === 'scratch' ? null : await resolveBase(i.base);
  if (method !== 'scratch') {
    if (!base) throw new Error('Choose a base model. Download a trainable (safetensors) model in Studio → Models → Trainable models.');
    if (base.engine !== 'forge') throw new Error(`${base.name} is a ${base.engine} model. Training needs safetensors weights: download the trainable version in Studio → Models.`);
    if (base.status !== 'ready') throw new Error(`${base.name} hasn't finished downloading.`);
  }
  if (!i.dataset) throw new Error('Choose a dataset.');
  const { readRows } = await import('../studio/datasets.js');
  const rows = await readRows(i.dataset);
  if (!rows.length) throw new Error(`Dataset ${i.dataset} is empty.`);
  const valRows = await readRows(i.dataset, 'validation.jsonl');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const name = String(i.name || `${base?.id || 'scratch-' + (i.size || 'micro')}-${method}`).replace(/[^\w.-]+/g, '-');
  const id = `${name}-${stamp}`.slice(0, 80) + '-' + uid().slice(-4);
  const dir = `${ROOT}/${id}`;
  const config = {
    epochs: i.epochs ?? (method === 'scratch' ? 3 : 1), maxSteps: i.maxSteps || 0, lr: i.lr || 0, batch: (i.batch || (method === 'grpo' ? 1 : 8)) * (i.gradAccum || 1),
    seqLen: i.seqLen || 0, rank: i.rank || 16, alpha: i.alpha || 2 * (i.rank || 16), targets: i.targets || ['q', 'k', 'v', 'o', 'gate', 'up', 'down'],
    warmup: i.warmup ?? null, wd: i.wd ?? null, clip: i.clip ?? 1, saveEvery: i.saveEvery || 0, evalEvery: i.evalEvery || 0,
    beta: i.beta ?? null, group: i.group || 4, maxNew: i.maxNew || 256, temperature: i.temperature ?? 0.9,
    reward: i.reward && !/[({;=]/.test(i.reward) ? i.reward : (i.reward ? null : 'exact'), rewardCode: i.rewardCode || (i.reward && /[({;=]/.test(i.reward) ? i.reward : null),
    size: i.size || 'micro', vocabSize: i.vocabSize || 0, completionOnly: i.completionOnly !== false, thinking: i.thinking ?? null, seed: i.seed || 1,
    samplePrompts: i.samplePrompts || null, sampleTokens: i.sampleTokens || 0, saveOptimizer: i.saveOptimizer !== false,
  };
  for (const k of Object.keys(config)) if (config[k] === null || config[k] === 0) delete config[k];
  const run = { id, name, method, tuning, baseRef: base?.ref || null, baseDir: base?.dir || null, baseRepo: base?.source?.repo || null, baseName: base?.name || (method === 'scratch' ? `New ${i.size || 'micro'} model` : null), dataset: i.dataset, config, created: Date.now(), updated: Date.now(), state: 'queued', step: 0, total: 0, dir };
  await vfs.writeJSON(`${dir}/run.json`, run);
  runsStore.set(s => ({ ...s, runs: [run, ...s.runs.filter(r => r.id !== id)], active: id, live: { ...s.live, [id]: { metrics: [], evals: [], samples: [], rollouts: [], warns: [] } } }));
  await launch(run, rows, valRows, false);
  return { id, dir, method };
}

// Starts the run in the worker (does not wait for it to finish). Local chat engines are unloaded first to free GPU memory.
async function launch(run, rows, valRows, resume) {
  try { const { unloadLocal } = await import('../models/registry.js'); await unloadLocal(); } catch {}
  rpc('train', { id: run.id, runDir: run.dir, method: run.method, tuning: run.tuning, baseDir: run.baseDir, rows, valRows, resume, ...run.config })
    .catch((e) => { saveRun(run.id, { state: 'error', error: String(e.message || e), statusText: String(e.message || e) }); runsStore.set(s => ({ ...s, active: s.active === run.id ? null : s.active })); })
    .finally(() => import('../models/registry.js').then(m => m.refreshModels()).catch(() => {}));
}

export async function resumeRun(id) {
  if (runsStore.get().active) throw new Error('Another run is active.');
  const run = runsStore.get().runs.find(r => r.id === id) || await vfs.readJSON(`${ROOT}/${id}/run.json`, null);
  if (!run) throw new Error('Run not found');
  const { readRows } = await import('../studio/datasets.js');
  const rows = await readRows(run.dataset), valRows = await readRows(run.dataset, 'validation.jsonl');
  await readMetrics(id);
  runsStore.set(s => ({ ...s, active: id }));
  saveRun(id, { state: 'preparing', error: null });
  await launch(run, rows, valRows, true);
  return run;
}

export async function stopRun(id, { pause = false } = {}) {
  await rpc('stop', id || runsStore.get().active, { pause });
}

export async function status(id) {
  const runs = await loadRuns();
  const run = id ? runs.find(r => r.id === id || r.name === id) : runs[0];
  if (!run) return { error: 'No such run' };
  const l = live(run.id);
  return { id: run.id, method: run.method, tuning: run.tuning, base: run.baseName, dataset: run.dataset, state: run.state, step: run.step, total: run.total, loss: l.last?.loss ?? run.loss, valLoss: l.evals?.at(-1)?.val_loss, lastSample: l.samples?.at(-1)?.text?.slice(0, 300), dir: run.dir, error: run.error };
}

export async function exportRun(id, what, opts = {}) {
  if (runsStore.get().active) throw new Error('Wait for the active run to finish or pause it before exporting.');
  const run = runsStore.get().runs.find(r => r.id === id);
  if (!run) throw new Error('Run not found');
  const r = await rpc('exportRun', { run, what, ...opts });
  const { refreshModels } = await import('../models/registry.js');
  await refreshModels();
  vfs.events.emit('change', { path: r.dir, type: 'write' });
  saveRun(id, { exports: { ...(run.exports || {}), [what]: r.dir } });
  return r;
}

export async function deleteRun(id) {
  const run = runsStore.get().runs.find(r => r.id === id);
  if (!run) return;
  if (runsStore.get().active === id) throw new Error('Stop the run first.');
  await vfs.rm(run.dir);
  runsStore.set(s => ({ ...s, runs: s.runs.filter(r => r.id !== id) }));
}

// Loads the run's model (base + latest checkpoint) for quick chats inside Studio.
export async function chatWithRun(id, messages, { onToken, maxTokens = 256, temperature = 0.7 } = {}) {
  const run = runsStore.get().runs.find(r => r.id === id);
  await rpc('loadRun', run);
  const stream = uid('rc');
  const off = forgeEvents.on('event', (e) => { if (e.type === 'token' && e.stream === stream) onToken?.(e.text); });
  try { return await rpc('generate', { messages, maxTokens, temperature }, stream); } finally { off(); }
}
